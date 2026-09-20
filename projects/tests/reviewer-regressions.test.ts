import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  FileContentAddressedObjectStore,
  MemorySecretRegistry,
  SafeError,
  SqliteStateStore,
  accountKey,
  accountPartition,
  assertProjectorNamespace,
  bytesIterable,
  computeContentHash,
  computeFailureId,
  createProjectors,
  createValidatedNoteRank,
  createValidatedSourceRank,
  deriveMembershipNameObservations,
  indexEntryDigest,
  initialProgress,
  mergeCanonicalNote,
  mergeFailure,
  noteCsvRowDigest,
  projectAccountInOrder,
  renderNoteJsonBytes,
  renderNoteMarkdownBytes,
  type Note,
  type NoteManifest,
  type Media,
  type SyncState,
} from "../src/index.ts";
import { issueBusinessResult, makeAccount, makeManifest, makeNote, makeRun, makeScope, tempRoot, time1, time2, withMergeCandidates } from "./helpers.ts";

function shell(result: ReturnType<typeof mergeCanonicalNote>): NoteManifest {
  const empty = { sha256: "0".repeat(64) as never, byteLength: 0, mimeType: "application/octet-stream" };
  return { schemaVersion: 1, revision: 1, accountId: result.note.accountId, hostId: result.note.hostId, noteId: result.note.noteId, canonicalNote: result.note, semanticSourceRank: result.sourceRank, membershipNameObservations: result.membershipNameObservations, mediaSlots: result.mediaSlots, artifacts: { json: empty, markdown: empty }, indexEntrySha256: indexEntryDigest(result.note), csvRowSha256: noteCsvRowDigest(result.note) };
}

test("DatabaseSync and snapshot owner capabilities do not escape, even with type-erased fakes", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    assert.equal("db" in store, false);
    assert.equal(Reflect.ownKeys(store).some((key) => String(key).includes("db")), false);
    assert.equal(Reflect.ownKeys(Object.getPrototypeOf(store)).some((key) => String(key).startsWith("query")), false);
    assert.throws(() => (store as never as { queryAccounts(): unknown }).queryAccounts(), TypeError);
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const tx = store.beginImmediate({ command: "repair_views", account: partition });
    assert.equal("store" in tx, false);
    assert.equal(Reflect.ownKeys(tx).some((key) => String(key).includes("store")), false);
    const fake = { kind: "write", accountGeneration: () => 0, enumerateViewGenerations: () => [], enumerateAccountManifests: () => [], enumerateAccountTasks: () => [], enumerateUnresolvedFailures: () => [], enumerateRuns: () => [] };
    const runtimeConstructor = Object.getPrototypeOf(tx).constructor as new (...args: unknown[]) => unknown;
    assert.throws(() => Reflect.construct(runtimeConstructor, [store, tx.intent]), SafeError);
    const inheritedPrototype = Object.getPrototypeOf(Object.getPrototypeOf(tx)) as { assertActive?: () => void };
    const originalAssert = inheritedPrototype.assertActive;
    inheritedPrototype.assertActive = () => {};
    assert.equal([...tx.enumerateAccountsWithGenerations()].length, 0);
    inheritedPrototype.assertActive = originalAssert;
    const projector = createProjectors(root, new FileContentAddressedObjectStore(root))[0];
    await assert.rejects(projector.project(fake as never, partition, { plannedGeneration: 1, pendingRun: null }), SafeError);
    store.rollback(tx);
    assert.throws(() => tx.accountGeneration(partition), SafeError);
    assert.throws(() => Reflect.construct(runtimeConstructor, [store, tx.intent]), SafeError);
    const read = store.openReadSnapshot();
    const readConstructor = Object.getPrototypeOf(read).constructor as new (...args: unknown[]) => unknown;
    assert.throws(() => Reflect.construct(readConstructor, [store]), SafeError);
    read.close();
    assert.throws(() => read.enumerateAccountsWithGenerations(), SafeError);
    store.close();
    assert.throws(() => tx.accountGeneration(partition), SafeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mutation exact decoding and object/artifact verification happen before its first SQL write", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const account = makeAccount();
    const manifest = await makeManifest(objects);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, account);
    const missing = { ...manifest, artifacts: { ...manifest.artifacts, json: { ...manifest.artifacts.json, sha256: "f".repeat(64) } } };
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [missing] as never, tasks: [], failures: [] })), SafeError);
    const extra = { ...manifest, unexpected: true };
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [extra] as never, tasks: [], failures: [] })), SafeError);
    const changedRaw: Note = { ...manifest.canonicalNote, body: "different body" };
    const changed = Object.freeze({ ...changedRaw, contentHash: computeContentHash(changedRaw) });
    const mismatched = { ...manifest, canonicalNote: changed, semanticSourceRank: createValidatedNoteRank(changed, time2), membershipNameObservations: deriveMembershipNameObservations(changed), indexEntrySha256: indexEntryDigest(changed), csvRowSha256: noteCsvRowDigest(changed) };
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [mismatched], tasks: [], failures: [] })), SafeError);
    const partition = accountPartition(scope);
    assert.throws(() => issueBusinessResult(store, tx, makeRun(scope)), SafeError);
    store.rollback(tx);
    const read = store.openReadSnapshot();
    assert.equal(read.loadState(scope), null);
    assert.equal([...read.enumerateAccountsWithGenerations()].length, 0);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("membership name selection is commutative and associative with newer null observations", () => {
  const time3 = "2026-01-03T00:00:00.000Z" as never;
  const base = makeNote();
  function candidate(boardName: string | null, observedAt: typeof time1): { note: Note; rank: ReturnType<typeof createValidatedNoteRank> } {
    const raw: Note = { ...base, memberships: [{ target: "collected_album", boardId: "boardA" as never, boardName, observedAt }] };
    const note = Object.freeze({ ...raw, contentHash: computeContentHash(raw) });
    return { note, rank: createValidatedNoteRank(note, observedAt) };
  }
  const a = candidate("Old", time1);
  const b = candidate(null, time3);
  const c = candidate("Middle", time2);
  const merge = (prior: NoteManifest | null, item: typeof a) => mergeCanonicalNote(prior, { note: item.note, sourceRank: item.rank, mediaSlots: [], mediaSetComplete: false });
  const ab = merge(shell(merge(null, a)), b);
  const ba = merge(shell(merge(null, b)), a);
  assert.deepEqual(ab.note.memberships, ba.note.memberships);
  const abc = merge(shell(ab), c);
  const cb = merge(shell(merge(null, c)), b);
  const cba = merge(shell(cb), a);
  assert.deepEqual(abc.note.memberships, cba.note.memberships);
  assert.deepEqual(abc.membershipNameObservations, cba.membershipNameObservations);
  assert.equal(abc.note.memberships[0]!.boardName, "Middle");
  assert.equal(abc.note.memberships[0]!.observedAt, time3);
  assert.equal(abc.membershipNameObservations[0]!.observedAt, time2);
});

test("a rank created for an unrelated payload cannot authorize a note merge", () => {
  const note = makeNote();
  const unrelated = createValidatedSourceRank({ unrelated: true }, time1);
  assert.throws(() => mergeCanonicalNote(null, { note, sourceRank: unrelated, mediaSlots: [], mediaSetComplete: false }), SafeError);
});

test("schema fingerprint rejects missing index/column/CHECK/FK and future schema version", async () => {
  const [missingIndex, missingColumn, missingCheck, missingFk, future] = await Promise.all([tempRoot(), tempRoot(), tempRoot(), tempRoot(), tempRoot()]);
  const roots = [missingIndex, missingColumn, missingCheck, missingFk, future];
  try {
    for (const root of roots) { const store = await SqliteStateStore.init(root); store.close(); }
    const missingIndexDb = new DatabaseSync(path.join(missingIndex, "state/rednote-sync.sqlite"));
    missingIndexDb.exec("DROP INDEX manifests_account_idx"); missingIndexDb.close();
    const missingColumnDb = new DatabaseSync(path.join(missingColumn, "state/rednote-sync.sqlite"));
    missingColumnDb.exec("ALTER TABLE accounts DROP COLUMN display_name"); missingColumnDb.close();
    const missingCheckDb = new DatabaseSync(path.join(missingCheck, "state/rednote-sync.sqlite"));
    missingCheckDb.exec("PRAGMA foreign_keys=OFF; CREATE TABLE view_generations_new(account_key TEXT NOT NULL REFERENCES accounts(account_key),projector_id TEXT NOT NULL,generation INTEGER NOT NULL,complete INTEGER NOT NULL,receipts_json TEXT NOT NULL,safe_error TEXT,PRIMARY KEY(account_key,projector_id)); DROP TABLE view_generations; ALTER TABLE view_generations_new RENAME TO view_generations");
    missingCheckDb.close();
    const missingFkDb = new DatabaseSync(path.join(missingFk, "state/rednote-sync.sqlite"));
    missingFkDb.exec("PRAGMA foreign_keys=OFF; CREATE TABLE account_generations_new(account_key TEXT PRIMARY KEY,canonical_generation INTEGER NOT NULL DEFAULT 0 CHECK(canonical_generation>=0),views_dirty INTEGER NOT NULL DEFAULT 1 CHECK(views_dirty IN (0,1))); DROP TABLE account_generations; ALTER TABLE account_generations_new RENAME TO account_generations");
    missingFkDb.close();
    const futureDb = new DatabaseSync(path.join(future, "state/rednote-sync.sqlite"));
    futureDb.exec("UPDATE meta SET schema_version=999"); futureDb.close();
    for (const root of roots) await assert.rejects(SqliteStateStore.open(root), SafeError);
  } finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
});

test("old receipts are namespace-validated before any projector write or stale deletion", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const initial = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(initial, account);
    const firstRun = { ...makeRun(makeScope()), command: "repair_views", scope: null, listed: 0, done: 0 } as never;
    const first = await projectAccountInOrder(createProjectors(root, objects), initial, partition, 1, issueBusinessResult(store, initial, firstRun));
    store.finalizeAccount(initial, first);
    store.commit(initial);
    const key = accountKey(partition);
    const protectedPath = path.join(root, `accounts/${key}/data/index.json`);
    const before = await readFile(protectedPath);
    const beforeMtime = (await stat(protectedPath)).mtimeMs;
    const raw = new DatabaseSync(path.join(root, "state/rednote-sync.sqlite"));
    raw.prepare("UPDATE view_generations SET receipts_json=? WHERE account_key=? AND projector_id='notes'").run(JSON.stringify([{ projectorId: "notes", accountKey: key, generation: 1, relativePath: `accounts/${key}/data/index.json`, sha256: "0".repeat(64), byteLength: 0 }]), key);
    raw.close();
    const repair = store.beginImmediate({ command: "repair_views", account: partition });
    const repairRun = { ...makeRun(makeScope(), "sync", "protected"), command: "repair_views", scope: null, listed: 0, done: 0 } as never;
    await assert.rejects(projectAccountInOrder(createProjectors(root, objects), repair, partition, 2, issueBusinessResult(store, repair, repairRun)), SafeError);
    store.rollback(repair);
    assert.deepEqual(await readFile(protectedPath), before);
    assert.equal((await stat(protectedPath)).mtimeMs, beforeMtime);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all five projector namespaces accept only their fixed path family", () => {
  const key = accountKey({ hostId: makeAccount().hostId, accountId: makeAccount().accountId });
  const digest = "a".repeat(64);
  const paths = {
    notes: `accounts/${key}/notes/${digest}.md`,
    assets: `accounts/${key}/assets/${digest}/image-1.png`,
    index: `accounts/${key}/data/index.json`,
    failures: `accounts/${key}/data/failures.json`,
    runs: `accounts/${key}/logs/export-runs.jsonl`,
  } as const;
  for (const [id, relative] of Object.entries(paths)) {
    assert.doesNotThrow(() => assertProjectorNamespace(key, id as keyof typeof paths, relative as never));
    for (const other of Object.keys(paths)) if (other !== id) assert.throws(() => assertProjectorNamespace(key, other as keyof typeof paths, relative as never), SafeError);
  }
});

test("projection authorization ignores mutable intent inputs and patched public snapshot methods", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const account = makeAccount();
    const partition: { hostId: typeof account.hostId; accountId: typeof account.accountId } = { hostId: account.hostId, accountId: account.accountId };
    const intent = { command: "repair_views" as const, account: partition };
    const tx = store.beginImmediate(intent);
    partition.accountId = "accB" as never;
    assert.equal(tx.intent.command === "repair_views" ? tx.intent.account.accountId : null, account.accountId);
    assert.throws(() => { (tx.intent as { account: { accountId: string } }).account.accountId = "accB"; }, TypeError);
    assert.throws(() => Object.defineProperty(tx, "intent", { value: intent }), TypeError);
    store.upsertAccount(tx, account);
    const prototype = Object.getPrototypeOf(tx) as object;
    Object.defineProperty(prototype, "accountGeneration", { configurable: true, value() { throw new Error("patched public method called"); } });
    try {
      const original = { hostId: account.hostId, accountId: account.accountId };
      const run = { ...makeRun(makeScope()), runId: "private-intent", command: "repair_views", account: original, scope: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 } as never;
      const batch = await projectAccountInOrder(createProjectors(root, objects), tx, original, 1, issueBusinessResult(store, tx, run));
      store.finalizeAccount(tx, batch);
      store.commit(tx);
    } finally { delete (prototype as { accountGeneration?: unknown }).accountGeneration; }
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical plans reject foreign object issuers and rescan owned bytes with the store registry", async () => {
  const root = await tempRoot();
  try {
    const registry = new MemorySecretRegistry();
    const store = await SqliteStateStore.init(root, registry);
    const owned = store.objectStore();
    const foreign = new FileContentAddressedObjectStore(root, new MemorySecretRegistry());
    const scope = makeScope();
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const foreignManifest = await makeManifest(foreign);
    const foreignTx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(foreignTx, makeAccount());
    assert.throws(() => store.prepareCanonicalWritePlan(foreignTx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [foreignManifest], tasks: [], failures: [] })), SafeError);
    store.rollback(foreignTx);

    const ownedManifest = await makeManifest(owned);
    registry.register("note_id: ");
    const secretTx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(secretTx, makeAccount());
    assert.throws(() => store.prepareCanonicalWritePlan(secretTx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [ownedManifest], tasks: [], failures: [] })), SafeError);
    store.rollback(secretTx);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a self-consistent but non-normalized manifest cannot become a canonical write plan", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const raw: Note = { ...makeNote(), tags: ["z", "a", "z"] };
    const note = Object.freeze({ ...raw, contentHash: computeContentHash(raw) });
    const rank = createValidatedNoteRank(note, time1);
    const json = await objects.put(bytesIterable(renderNoteJsonBytes(note)), null, new AbortController().signal);
    const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(note)), null, new AbortController().signal);
    const manifest: NoteManifest = Object.freeze({ schemaVersion: 1, revision: 1, accountId: note.accountId, hostId: note.hostId, noteId: note.noteId, canonicalNote: note, semanticSourceRank: rank, membershipNameObservations: deriveMembershipNameObservations(note), mediaSlots: [], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) });
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, makeAccount());
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [manifest], tasks: [], failures: [] })), SafeError);
    store.rollback(tx); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical media extension must match the complete object magic", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const object = await objects.put(bytesIterable(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])), null, new AbortController().signal);
    const media: Media = { mediaId: "image-1", kind: "image", ordinal: 1, status: "stored", extension: "jpg", object };
    const raw: Note = { ...makeNote(), noteType: "image", media: [media] };
    const note = Object.freeze({ ...raw, contentHash: computeContentHash(raw) });
    const rank = createValidatedNoteRank(note, time1);
    const json = await objects.put(bytesIterable(renderNoteJsonBytes(note)), null, new AbortController().signal);
    const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(note)), null, new AbortController().signal);
    const manifest: NoteManifest = Object.freeze({ schemaVersion: 1, revision: 1, accountId: note.accountId, hostId: note.hostId, noteId: note.noteId, canonicalNote: note, semanticSourceRank: rank, membershipNameObservations: deriveMembershipNameObservations(note), mediaSlots: [{ slot: { kind: "image" as const, ordinal: 1 }, sourceRank: rank, media, tombstone: false }], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) });
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, makeAccount());
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state, manifests: [manifest], tasks: [], failures: [] })), SafeError);
    store.rollback(tx); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical factory merges a low-rank candidate against a reopened prior without treating the final manifest as the candidate", async () => {
  const root = await tempRoot();
  try {
    const first = await SqliteStateStore.init(root);
    const firstObjects = first.objectStore();
    const scope = makeScope();
    const partition = accountPartition(scope);
    const manifest = await makeManifest(firstObjects);
    const state1: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const task = Object.freeze({ schemaVersion: 1 as const, scope, noteId: manifest.noteId, status: "done" as const, attemptCount: 1, failureIds: [], skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time1 });
    const tx1 = first.beginImmediate({ command: "sync", scope });
    first.upsertAccount(tx1, makeAccount());
    first.putCanonicalMutation(tx1, first.prepareCanonicalWritePlan(tx1, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state1, manifests: [manifest], tasks: [task], failures: [] })));
    const firstBatch = await projectAccountInOrder(createProjectors(root, firstObjects), tx1, partition, 1, issueBusinessResult(first, tx1, makeRun(scope), [task.noteId]));
    first.finalizeAccount(tx1, firstBatch); first.commit(tx1); first.close();

    const reopened = await SqliteStateStore.open(root);
    const objects = reopened.objectStore();
    const read = reopened.openReadSnapshot();
    const prior = read.loadManifest(partition, manifest.noteId)!;
    read.close();
    const lowTime = "2025-12-31T00:00:00.000Z" as never;
    const lowRaw: Note = { ...makeNote("accA", "noteA", lowTime, "low-rank body"), tags: ["low-rank"], metrics: { liked: 99, collected: null, commented: 0, shared: null } };
    const lowNote = Object.freeze({ ...lowRaw, contentHash: computeContentHash(lowRaw) });
    const lowRank = createValidatedNoteRank(lowNote, lowTime);
    const merged = mergeCanonicalNote(prior, { note: lowNote, sourceRank: lowRank, mediaSlots: [], mediaSetComplete: false });
    assert.equal(merged.note.body, prior.canonicalNote.body);
    assert.deepEqual(merged.note.tags, prior.canonicalNote.tags);
    assert.deepEqual(merged.note.metrics, prior.canonicalNote.metrics);
    const json = await objects.put(bytesIterable(renderNoteJsonBytes(merged.note)), null, new AbortController().signal);
    const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(merged.note)), null, new AbortController().signal);
    const expected: NoteManifest = Object.freeze({ ...prior, revision: 2, canonicalNote: merged.note, semanticSourceRank: merged.sourceRank, membershipNameObservations: merged.membershipNameObservations, mediaSlots: merged.mediaSlots, artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(merged.note), csvRowSha256: noteCsvRowDigest(merged.note) });
    const state2: SyncState = Object.freeze({ ...state1, revision: 2, lastAttemptAt: time2 });
    const tx2 = reopened.beginImmediate({ command: "sync", scope });
    const request = { scope, expectedStateRevision: 1, expectedManifestRevisions: { noteA: 1 }, nextState: state2, candidates: [{ note: lowNote, sourceRank: lowRank, mediaSlots: [], mediaSetComplete: false }], manifests: [expected], tasks: [{ ...task, updatedAt: time2 }], failureOccurrences: [], failureResolutions: [], failures: [] };
    const plan = reopened.prepareCanonicalWritePlan(tx2, request);
    reopened.putCanonicalMutation(tx2, plan);
    reopened.rollback(tx2); reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reopened media failure occurrences merge attempt and rank exactly and require the note candidate", async () => {
  const root = await tempRoot();
  try {
    let store = await SqliteStateStore.init(root);
    let objects = store.objectStore();
    const scope = makeScope();
    const partition = accountPartition(scope);
    const base = await makeManifest(objects);
    const object = await objects.put(bytesIterable(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2])), null, new AbortController().signal);
    const media: Media = { mediaId: "image-1", kind: "image", ordinal: 1, status: "stored", extension: "png", object };
    const raw: Note = { ...base.canonicalNote, noteType: "image", media: [media] };
    const note = Object.freeze({ ...raw, contentHash: computeContentHash(raw) });
    const lowRank = createValidatedNoteRank(note, time1);
    const json = await objects.put(bytesIterable(renderNoteJsonBytes(note)), null, new AbortController().signal);
    const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(note)), null, new AbortController().signal);
    const lowSlot = { slot: { kind: "image" as const, ordinal: 1 }, sourceRank: lowRank, media, tombstone: false };
    const manifest1: NoteManifest = Object.freeze({ ...base, canonicalNote: note, semanticSourceRank: lowRank, mediaSlots: [lowSlot], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) });
    const failureBase = { scope, noteId: note.noteId, mediaSlot: { kind: "image" as const, ordinal: 1 }, category: "MEDIA" as const, stage: "media" as const };
    const failure1 = Object.freeze({ schemaVersion: 1 as const, failureId: computeFailureId(failureBase), ...failureBase, sourceRank: lowRank, safeMessage: "media unavailable", retryable: true, attemptCount: 1, firstOccurredAt: time1, lastOccurredAt: time1, retryAt: null, resolvedAt: null, resolvedReason: null });
    const task1 = Object.freeze({ schemaVersion: 1 as const, scope, noteId: note.noteId, status: "partial" as const, attemptCount: 1, failureIds: [failure1.failureId], skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time1 });
    const state1: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: null, nextAllowedAt: null }) as SyncState;
    const tx1 = store.beginImmediate({ command: "sync", scope }); store.upsertAccount(tx1, makeAccount());
    store.putCanonicalMutation(tx1, store.prepareCanonicalWritePlan(tx1, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { noteA: null }, nextState: state1, manifests: [manifest1], tasks: [task1], failures: [failure1] })));
    const run1 = { ...makeRun(scope, "sync", "occ1"), done: 0, partial: 1 };
    const batch1 = await projectAccountInOrder(createProjectors(root, objects), tx1, partition, 1, issueBusinessResult(store, tx1, run1, [note.noteId])); store.finalizeAccount(tx1, batch1); store.commit(tx1); store.close();

    store = await SqliteStateStore.open(root); objects = store.objectStore();
    const highNote = { ...note, capturedAt: time2 };
    const highRank = createValidatedNoteRank(highNote, time2);
    const highSlot = { ...lowSlot, sourceRank: highRank };
    const mergedHigh = mergeCanonicalNote(manifest1, { note: highNote, sourceRank: highRank, mediaSlots: [highSlot], mediaSetComplete: false });
    const manifest2: NoteManifest = Object.freeze({ ...manifest1, revision: 2, canonicalNote: mergedHigh.note, semanticSourceRank: mergedHigh.sourceRank, mediaSlots: mergedHigh.mediaSlots });
    const occurrence2 = Object.freeze({ ...failure1, sourceRank: highRank, lastOccurredAt: time2 });
    const failure2 = mergeFailure(failure1, occurrence2);
    assert.equal(failure2.attemptCount, 2);
    const task2 = Object.freeze({ ...task1, attemptCount: 2, updatedAt: time2 });
    const state2: SyncState = Object.freeze({ ...state1, revision: 2, lastAttemptAt: time2 });
    const tx2 = store.beginImmediate({ command: "sync", scope });
    const highRequest = withMergeCandidates({ scope, expectedStateRevision: 1, expectedManifestRevisions: { noteA: 1 }, nextState: state2, manifests: [manifest2], tasks: [task2], failures: [failure2] }, false);
    const highRaw = { ...highRequest, candidates: [{ note: highNote, sourceRank: highRank, mediaSlots: [highSlot], mediaSetComplete: false }], failureOccurrences: [{ failure: occurrence2 }], failureResolutions: [] };
    store.putCanonicalMutation(tx2, store.prepareCanonicalWritePlan(tx2, highRaw));
    const run2 = { ...makeRun(scope, "sync", "occ2"), done: 0, partial: 1 };
    const batch2 = await projectAccountInOrder(createProjectors(root, objects, undefined, "notes"), tx2, partition, 2, issueBusinessResult(store, tx2, run2, [note.noteId]));
    assert.deepEqual([batch2.finalRun.outcome, batch2.finalRun.safeErrorCategory], ["committed_with_warnings", "MEDIA"]);
    store.finalizeAccount(tx2, batch2); store.commit(tx2); store.close();

    store = await SqliteStateStore.open(root);
    const occurrence3 = Object.freeze({ ...failure1, lastOccurredAt: time2 });
    const failure3 = mergeFailure(failure2, occurrence3);
    assert.deepEqual([failure3.attemptCount, failure3.sourceRank], [3, highRank]);
    const mergedLow = mergeCanonicalNote(manifest2, { note, sourceRank: lowRank, mediaSlots: [lowSlot], mediaSetComplete: false });
    const manifest3: NoteManifest = Object.freeze({ ...manifest2, revision: 3, semanticSourceRank: mergedLow.sourceRank, mediaSlots: mergedLow.mediaSlots });
    const state3: SyncState = Object.freeze({ ...state2, revision: 3 });
    const task3 = Object.freeze({ ...task2, attemptCount: 3 });
    const tx3 = store.beginImmediate({ command: "sync", scope });
    const lowRequest = { scope, expectedStateRevision: 2, expectedManifestRevisions: { noteA: 2 }, nextState: state3, candidates: [{ note, sourceRank: lowRank, mediaSlots: [lowSlot], mediaSetComplete: false }], manifests: [manifest3], tasks: [task3], failureOccurrences: [{ failure: occurrence3 }], failureResolutions: [], failures: [failure3] };
    assert.throws(() => store.prepareCanonicalWritePlan(tx3, { ...lowRequest, candidates: [], manifests: [], expectedManifestRevisions: {} }), SafeError);
    store.putCanonicalMutation(tx3, store.prepareCanonicalWritePlan(tx3, lowRequest));
    store.rollback(tx3); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
