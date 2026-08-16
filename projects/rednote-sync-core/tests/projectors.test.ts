import assert from "node:assert/strict";
import { chmod, link, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FileContentAddressedObjectStore,
  JsonExporter,
  MarkdownExporter,
  SafeError,
  SqliteStateStore,
  accountKey,
  accountPartition,
  bytesIterable,
  computeContentHash,
  createProjectors,
  createValidatedNoteRank,
  noteCsvRowDigest,
  decodeSha256,
  deriveMembershipNameObservations,
  indexEntryDigest,
  initialProgress,
  mergeCanonicalNote,
  noteKey,
  projectAccountInOrder,
  type Media,
  type Note,
  type NoteManifest,
  type RunRecord,
  type SyncState,
} from "../src/index.ts";
import { cleanupProjectionAttempt, createProjectionBoundary, isProjectionPaused, restoreProjectionAttempt } from "../src/projectors.ts";
import { issueBusinessResult, makeAccount, makeNote, makeRun, makeScope, tempRoot, time1, time2, withMergeCandidates } from "./helpers.ts";

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> { const chunks: Uint8Array[] = []; for await (const chunk of iterable) chunks.push(chunk); return Buffer.concat(chunks); }

function repairRun(account: ReturnType<typeof accountPartition>, id: string): RunRecord {
  return Object.freeze({ runId: id, command: "repair_views", account, scope: null, outcome: "committed", startedAt: time1, finishedAt: time2, safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 });
}

async function mediaManifest(objects: FileContentAddressedObjectStore, id: string, mediaObject: Awaited<ReturnType<FileContentAddressedObjectStore["put"]>>): Promise<NoteManifest> {
  const media: Media = { mediaId: `image-1-${id}`, kind: "image", ordinal: 1, status: "stored", extension: "png", object: mediaObject };
  const raw: Note = { ...makeNote("accA", id), noteType: "image", media: [media] };
  const note = Object.freeze({ ...raw, contentHash: computeContentHash(raw) });
  const rank = createValidatedNoteRank(note, time1);
  const signal = new AbortController().signal;
  const json = await objects.put(bytesIterable(await collect(new JsonExporter().render(note))), null, signal);
  const markdown = await objects.put(bytesIterable(await collect(new MarkdownExporter().render(note))), null, signal);
  return Object.freeze({ schemaVersion: 1, revision: 1, accountId: note.accountId, hostId: note.hostId, noteId: note.noteId, canonicalNote: note, semanticSourceRank: rank, membershipNameObservations: deriveMembershipNameObservations(note), mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: rank, media, tombstone: false }], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) });
}

test("derived assets are ordinary isolated copies and repair restores corruption without touching unchanged mtimes", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const mediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
    const mediaObject = await objects.put(bytesIterable(mediaBytes), "application/false", new AbortController().signal);
    const manifests = [await mediaManifest(objects, "noteA", mediaObject), await mediaManifest(objects, "noteB", mediaObject)];
    const scope = makeScope();
    const account = makeAccount();
    const partition = accountPartition(scope);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time2, lastSuccessfulAt: time2, nextAllowedAt: null }) as SyncState;
    const tasks = manifests.map((manifest) => Object.freeze({ schemaVersion: 1 as const, scope, noteId: manifest.noteId, status: "done" as const, attemptCount: 1, failureIds: Object.freeze([]), skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time2 }));
    const run = Object.freeze({ ...makeRun(scope), listed: 2, done: 2 });
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, account);
    store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null, noteB: null }, nextState: state, manifests, tasks, failures: [] })));
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, run, tasks.map((task) => task.noteId)));
    assert.ok(batch.outcomes.find((outcome) => outcome.projectorId === "notes")!.receipts!.length >= 4);
    store.finalizeAccount(tx, batch);
    store.commit(tx);

    const accountDigest = accountKey(partition);
    const assetA = path.join(root, `accounts/${accountDigest}/assets/${noteKey(partition, manifests[0]!.noteId)}/image-1.png`);
    const assetB = path.join(root, `accounts/${accountDigest}/assets/${noteKey(partition, manifests[1]!.noteId)}/image-1.png`);
    const canonical = objects.objectPath(mediaObject.sha256);
    const [canonicalStat, aStat, bStat] = await Promise.all([stat(canonical), stat(assetA), stat(assetB)]);
    assert.notEqual(aStat.ino, canonicalStat.ino);
    assert.notEqual(bStat.ino, canonicalStat.ino);
    assert.notEqual(aStat.ino, bStat.ino);
    const indexPath = path.join(root, `accounts/${accountDigest}/data/index.json`);
    const indexMtime = (await stat(indexPath)).mtimeMs;
    await unlink(assetA);
    await link(canonical, assetA);
    assert.equal((await stat(assetA)).ino, (await stat(canonical)).ino);
    const unlinkRepair = store.beginImmediate({ command: "repair_views", account: partition });
    const unlinkRun = repairRun(partition, "repairHardlink");
    const unlinkBatch = await projectAccountInOrder(createProjectors(root, objects), unlinkRepair, partition, 2, issueBusinessResult(store, unlinkRepair, unlinkRun));
    store.finalizeAccount(unlinkRepair, unlinkBatch);
    store.commit(unlinkRepair);
    assert.notEqual((await stat(assetA)).ino, (await stat(canonical)).ino);
    await chmod(assetA, 0o600);
    await writeFile(assetA, "corrupt-derived-copy");
    assert.deepEqual(await readFile(canonical), mediaBytes);
    assert.deepEqual(await readFile(assetB), mediaBytes);

    const repair = store.beginImmediate({ command: "repair_views", account: partition });
    const repairRecord = repairRun(partition, "repairAsset");
    const repairedBatch = await projectAccountInOrder(createProjectors(root, objects), repair, partition, 3, issueBusinessResult(store, repair, repairRecord));
    store.finalizeAccount(repair, repairedBatch);
    store.commit(repair);
    assert.deepEqual(await readFile(assetA), mediaBytes);
    assert.deepEqual(await readFile(canonical), mediaBytes);
    assert.equal((await stat(indexPath)).mtimeMs, indexMtime);
    const repairedStat = await stat(assetA);
    assert.notEqual(repairedStat.ino, (await stat(canonical)).ino);
    assert.notEqual(repairedStat.ino, (await stat(assetB)).ino);

    const removedRaw: Note = { ...manifests[0]!.canonicalNote, media: [] };
    const removedNote = Object.freeze({ ...removedRaw, contentHash: computeContentHash(removedRaw) });
    const removalRank = createValidatedNoteRank(removedNote, time2);
    const removalJson = await objects.put(bytesIterable(await collect(new JsonExporter().render(removedNote))), null, new AbortController().signal);
    const removalMarkdown = await objects.put(bytesIterable(await collect(new MarkdownExporter().render(removedNote))), null, new AbortController().signal);
    const removedManifest: NoteManifest = Object.freeze({ ...manifests[0]!, revision: 2, canonicalNote: removedNote, semanticSourceRank: removalRank, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: removalRank, media: null, tombstone: true }], artifacts: { json: removalJson, markdown: removalMarkdown }, indexEntrySha256: indexEntryDigest(removedNote), csvRowSha256: noteCsvRowDigest(removedNote) });
    const state2: SyncState = Object.freeze({ ...state, revision: 2, lastAttemptAt: time2 });
    const tombstoneTx = store.beginImmediate({ command: "sync", scope });
    store.putCanonicalMutation(tombstoneTx, store.prepareCanonicalWritePlan(tombstoneTx, withMergeCandidates({ scope, expectedStateRevision: 1, expectedManifestRevisions: { [removedManifest.noteId]: 1 }, nextState: state2, manifests: [removedManifest], tasks: [{ ...tasks[0]!, updatedAt: time2 }], failures: [] })));
    const tombstoneRun = makeRun(scope, "sync", "removeAsset");
    const tombstoneBatch = await projectAccountInOrder(createProjectors(root, objects), tombstoneTx, partition, 4, issueBusinessResult(store, tombstoneTx, tombstoneRun, [tasks[0]!.noteId]));
    store.finalizeAccount(tombstoneTx, tombstoneBatch);
    store.commit(tombstoneTx);
    await assert.rejects(stat(assetA), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.deepEqual(await readFile(assetB), mediaBytes);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan objects survive rollback but are absent from DB refs; missing/ahead views rebuild from committed DB", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const initial = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(initial, account);
    const run1 = repairRun(partition, "repairBase");
    const batch1 = await projectAccountInOrder(createProjectors(root, objects), initial, partition, 1, issueBusinessResult(store, initial, run1));
    store.finalizeAccount(initial, batch1);
    store.commit(initial);

    const orphanTx = store.beginImmediate({ command: "repair_views", account: partition });
    const orphan = await objects.put(bytesIterable(Buffer.from("orphan object bytes")), null, new AbortController().signal);
    const aheadRun = repairRun(partition, "repairAhead");
    const ahead = await projectAccountInOrder(createProjectors(root, objects), orphanTx, partition, 2, issueBusinessResult(store, orphanTx, aheadRun));
    assert.equal(ahead.outcomes.every((outcome) => outcome.complete), true);
    store.rollback(orphanTx);
    assert.equal(await objects.verify(orphan), true);
    const afterRollback = store.openReadSnapshot();
    assert.equal(afterRollback.accountGeneration(partition), 1);
    assert.equal([...afterRollback.enumerateObjectRefs(partition)].some((ref) => ref.sha256 === orphan.sha256), false);
    afterRollback.close();

    const key = accountKey(partition);
    const markerPath = path.join(root, `accounts/${key}/.views/index.generation.json`);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).generation, 2);
    const missing = path.join(root, `accounts/${key}/data/index.json`);
    await unlink(missing);
    const repair = store.beginImmediate({ command: "repair_views", account: partition });
    const run2 = repairRun(partition, "repairCommitted");
    const batch2 = await projectAccountInOrder(createProjectors(root, objects), repair, partition, 2, issueBusinessResult(store, repair, run2));
    store.finalizeAccount(repair, batch2);
    store.commit(repair);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).generation, 2);
    assert.ok((await stat(missing)).isFile());
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repairing account A leaves account B generation, receipts, marker, and mtime untouched", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const partitions = [];
    for (const id of ["accA", "accB"]) {
      const account = makeAccount(id);
      const partition = { hostId: account.hostId, accountId: account.accountId };
      partitions.push(partition);
      const tx = store.beginImmediate({ command: "repair_views", account: partition });
      store.upsertAccount(tx, account);
      const run = repairRun(partition, `initial-${id}`);
      const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, run));
      store.finalizeAccount(tx, batch);
      store.commit(tx);
    }
    const b = partitions[1]!;
    const bIndex = path.join(root, `accounts/${accountKey(b)}/data/index.json`);
    const bMarker = path.join(root, `accounts/${accountKey(b)}/.views/index.generation.json`);
    const beforeIndex = await stat(bIndex);
    const beforeMarker = await readFile(bMarker);
    const beforeViews = (() => { const r = store.openReadSnapshot(); const v = r.enumerateViewGenerations(accountKey(b)); r.close(); return v; })();

    const a = partitions[0]!;
    const repair = store.beginImmediate({ command: "repair_views", account: a });
    const run = repairRun(a, "repair-only-A");
    const batch = await projectAccountInOrder(createProjectors(root, objects), repair, a, 2, issueBusinessResult(store, repair, run));
    store.finalizeAccount(repair, batch);
    store.commit(repair);
    const read = store.openReadSnapshot();
    assert.equal(read.accountGeneration(a), 2);
    assert.equal(read.accountGeneration(b), 1);
    assert.deepEqual(read.enumerateViewGenerations(accountKey(b)), beforeViews);
    read.close();
    assert.equal((await stat(bIndex)).mtimeMs, beforeIndex.mtimeMs);
    assert.deepEqual(await readFile(bMarker), beforeMarker);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every projector failure is isolated, later projectors still run, and finalization marks dirty", async () => {
  for (const failId of ["notes", "assets", "index", "failures", "runs"] as const) {
    const root = await tempRoot(`rednote-projector-${failId}-`);
    try {
      const store = await SqliteStateStore.init(root);
      const objects = store.objectStore();
      const account = makeAccount();
      const partition = { hostId: account.hostId, accountId: account.accountId };
      const tx = store.beginImmediate({ command: "repair_views", account: partition });
      store.upsertAccount(tx, account);
      const run = repairRun(partition, `repair-${failId}`);
      const batch = await projectAccountInOrder(createProjectors(root, objects, undefined, failId), tx, partition, 1, issueBusinessResult(store, tx, run));
      const outcomes = batch.outcomes;
      assert.deepEqual(outcomes.map((outcome) => outcome.projectorId), ["notes", "assets", "index", "failures", "runs"]);
      assert.deepEqual(outcomes.filter((outcome) => !outcome.complete).map((outcome) => outcome.projectorId), [failId]);
      assert.equal(batch.finalRun.outcome, failId === "runs" ? "committed" : "committed_with_warnings");
      assert.equal(batch.finalRun.safeErrorCategory, failId === "runs" ? null : "DERIVED_VIEW");
      store.finalizeAccount(tx, batch);
      store.commit(tx);
      const read = store.openReadSnapshot();
      assert.equal([...read.enumerateAccountsWithGenerations()][0]!.viewsDirty, true);
      assert.equal(read.enumerateViewGenerations(accountKey(partition)).find((row) => row.projectorId === failId)!.complete, false);
      read.close(); store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("WAL read snapshot exposes stable G and a closed/new connection exposes G2", async () => {
  const root = await tempRoot();
  try {
    const first = await SqliteStateStore.init(root);
    const objects = first.objectStore();
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const initial = first.beginImmediate({ command: "repair_views", account: partition });
    first.upsertAccount(initial, account);
    const run1 = repairRun(partition, "repairG1");
    const batch1 = await projectAccountInOrder(createProjectors(root, objects), initial, partition, 1, issueBusinessResult(first, initial, run1));
    first.finalizeAccount(initial, batch1);
    first.commit(initial);
    const snapshot = first.openReadSnapshot();
    assert.equal([...snapshot.enumerateAccountsWithGenerations()][0]!.canonicalGeneration, 1);

    const second = await SqliteStateStore.open(root);
    const secondObjects = second.objectStore();
    const next = second.beginImmediate({ command: "repair_views", account: partition });
    const run2 = repairRun(partition, "repairG2");
    const batch2 = await projectAccountInOrder(createProjectors(root, secondObjects), next, partition, 2, issueBusinessResult(second, next, run2));
    second.finalizeAccount(next, batch2);
    second.commit(next); second.close();
    assert.equal([...snapshot.enumerateAccountsWithGenerations()][0]!.canonicalGeneration, 1);
    snapshot.close(); first.close();
    const reopened = await SqliteStateStore.open(root);
    const g2 = reopened.openReadSnapshot();
    assert.equal([...g2.enumerateAccountsWithGenerations()][0]!.canonicalGeneration, 2);
    g2.close(); reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paused projection undo restores replacements, stale deletes, markers, and unchanged mtimes", async () => {
  const root = await tempRoot("rednote-projection-undo-");
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const mediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    const mediaObject = await objects.put(bytesIterable(mediaBytes), null, new AbortController().signal);
    const firstManifest = await mediaManifest(objects, "undo-note", mediaObject);
    const unchangedManifest = await mediaManifest(objects, "unchanged-note", mediaObject);
    const scope = makeScope();
    const account = makeAccount();
    const partition = accountPartition(scope);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const tasks = [firstManifest, unchangedManifest].map((manifest) => Object.freeze({ schemaVersion: 1 as const, scope, noteId: manifest.noteId, status: "done" as const, attemptCount: 1, failureIds: Object.freeze([]), skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time1 }));
    const seed = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(seed, account);
    store.putCanonicalMutation(seed, store.prepareCanonicalWritePlan(seed, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { [firstManifest.noteId]: null, [unchangedManifest.noteId]: null }, nextState: state, manifests: [firstManifest, unchangedManifest], tasks, failures: [] })));
    const seedBatch = await projectAccountInOrder(createProjectors(root, objects), seed, partition, 1, issueBusinessResult(store, seed, { ...makeRun(scope, "sync", "undo-seed"), listed: 2, done: 2 }, tasks.map((task) => task.noteId)));
    store.finalizeAccount(seed, seedBatch); store.commit(seed);

    const key = accountKey(partition);
    const firstDigest = noteKey(partition, firstManifest.noteId);
    const unchangedDigest = noteKey(partition, unchangedManifest.noteId);
    const paths = [
      path.join(root, `accounts/${key}/notes/${firstDigest}.md`),
      path.join(root, `accounts/${key}/assets/${firstDigest}/image-1.png`),
      path.join(root, `accounts/${key}/.views/notes.generation.json`),
      path.join(root, `accounts/${key}/.views/assets.generation.json`),
      path.join(root, `accounts/${key}/notes/${unchangedDigest}.md`),
    ];
    const fixed = new Date("2001-01-01T00:00:00.000Z");
    for (const target of paths) await utimes(target, fixed, fixed);
    const before = await Promise.all(paths.map(async (target) => ({ bytes: await readFile(target), stat: await stat(target) })));

    const removedRaw: Note = { ...firstManifest.canonicalNote, capturedAt: time2, media: [] };
    const removedNote = Object.freeze({ ...removedRaw, contentHash: computeContentHash(removedRaw) });
    const removedRank = createValidatedNoteRank(removedNote, time2);
    const mergedRemoval = mergeCanonicalNote(firstManifest, { note: removedNote, sourceRank: removedRank, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: removedRank, media: null, tombstone: true }], mediaSetComplete: true });
    const signal = new AbortController().signal;
    const removedJson = await objects.put(bytesIterable(await collect(new JsonExporter().render(mergedRemoval.note))), null, signal);
    const removedMarkdown = await objects.put(bytesIterable(await collect(new MarkdownExporter().render(mergedRemoval.note))), null, signal);
    const removedManifest: NoteManifest = Object.freeze({ ...firstManifest, revision: 2, canonicalNote: mergedRemoval.note, semanticSourceRank: mergedRemoval.sourceRank, membershipNameObservations: mergedRemoval.membershipNameObservations, mediaSlots: mergedRemoval.mediaSlots, artifacts: { json: removedJson, markdown: removedMarkdown }, indexEntrySha256: indexEntryDigest(mergedRemoval.note), csvRowSha256: noteCsvRowDigest(mergedRemoval.note) });
    const nextState: SyncState = Object.freeze({ ...state, revision: 2, lastAttemptAt: time2 });
    const nextTask = Object.freeze({ ...tasks[0]!, attemptCount: 2, updatedAt: time2 });
    const tx = store.beginImmediate({ command: "sync", scope });
    const plan = store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 1, expectedManifestRevisions: { [removedManifest.noteId]: 1 }, nextState, manifests: [removedManifest], tasks: [nextTask], failures: [] }));
    store.putCanonicalMutation(tx, plan);
    const business = issueBusinessResult(store, tx, makeRun(scope, "sync", "undo-attempt"), [removedManifest.noteId]);
    let paused: unknown;
    try {
      await projectAccountInOrder(createProjectors(root, objects), tx, partition, 2, business, createProjectionBoundary(async (point) => point.projectorId === "assets" && point.phase === "after_projector"));
    } catch (error) { paused = error; }
    assert.equal(isProjectionPaused(paused), true);
    store.rewindWriteForPausedReplay(tx);
    await restoreProjectionAttempt(paused, root);
    assert.throws(() => store.putCanonicalMutation(tx, plan), (error: unknown) => error instanceof SafeError && error.code === "STATE", "rewind invalidates the old write plan epoch");
    store.rollback(tx);

    const after = await Promise.all(paths.map(async (target) => ({ bytes: await readFile(target), stat: await stat(target) })));
    for (let index = 0; index < paths.length; index += 1) {
      assert.deepEqual(after[index]!.bytes, before[index]!.bytes, `${paths[index]} bytes`);
      assert.equal(after[index]!.stat.ino, before[index]!.stat.ino, `${paths[index]} inode`);
      assert.equal(after[index]!.stat.mode, before[index]!.stat.mode, `${paths[index]} mode`);
      assert.equal(after[index]!.stat.mtimeMs, before[index]!.stat.mtimeMs, `${paths[index]} mtime`);
    }
    const abandoned = path.join(path.dirname(paths[0]!), ".rednote-sync-undo-000000000000000000000000.bak");
    await writeFile(abandoned, "abandoned", { mode: 0o600 });
    const repair = store.beginImmediate({ command: "repair_views", account: partition });
    const repairBatch = await projectAccountInOrder(createProjectors(root, objects), repair, partition, 2, issueBusinessResult(store, repair, repairRun(partition, "undo-cleanup")));
    store.finalizeAccount(repair, repairBatch); store.commit(repair);
    await assert.rejects(stat(abandoned), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projection pause errors are privately branded and invalid boundary decisions fail hard", async () => {
  const root = await tempRoot("rednote-projection-brand-");
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const account = makeAccount();
    const partition = accountPartition(account);
    let tx = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(tx, account);
    let branded: unknown;
    try {
      await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, repairRun(partition, "pause-brand")), createProjectionBoundary(async () => true));
    } catch (error) { branded = error; }
    assert.equal(isProjectionPaused(branded), true);
    assert.equal(isProjectionPaused(Object.create(Object.getPrototypeOf(branded as object))), false, "matching the private error prototype cannot forge a pause");
    await cleanupProjectionAttempt(branded, root);
    store.rollback(tx);

    tx = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(tx, account);
    await assert.rejects(
      projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, repairRun(partition, "invalid-boundary")), createProjectionBoundary(async () => "yes" as never)),
      (error: unknown) => error instanceof SafeError && error.code === "STATE" && !isProjectionPaused(error),
    );
    store.rollback(tx); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
