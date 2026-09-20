import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  FileContentAddressedObjectStore,
  SafeError,
  SqliteStateStore,
  accountKey,
  accountPartition,
  applySequentialMigrations,
  createProjectors,
  computeFailureId,
  computeContentHash,
  createValidatedNoteRank,
  indexEntryDigest,
  noteCsvRowDigest,
  renderNoteJsonBytes,
  renderNoteMarkdownBytes,
  bytesIterable,
  initialProgress,
  projectAccountInOrder,
  type AccountPartition,
  type AlbumState,
  type FinalizeStep,
  type RunRecord,
  type SyncState,
} from "../src/index.ts";
import { issueBusinessResult, makeAccount, makeManifest, makeRun, makeScope, tempRoot, time1, time2, withMergeCandidates } from "./helpers.ts";

function repairRun(account: AccountPartition, id = "repairA"): RunRecord {
  return Object.freeze({ runId: id, command: "repair_views", account, scope: null, outcome: "committed", startedAt: time1, finishedAt: time2, safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 });
}

async function initAccount(root: string, id = "accA"): Promise<void> {
  const store = await SqliteStateStore.init(root);
  const objects = store.objectStore();
  const account = makeAccount(id);
  const partition = { hostId: account.hostId, accountId: account.accountId };
  const tx = store.beginImmediate({ command: "repair_views", account: partition });
  store.upsertAccount(tx, account);
  const generation = tx.accountGeneration(partition) + 1;
  const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, generation, issueBusinessResult(store, tx, repairRun(partition)));
  store.finalizeAccount(tx, batch);
  store.commit(tx);
  store.close();
}

test("empty schema init is atomic, secure, and half-schema init is refused", async () => {
  const root = await tempRoot();
  const half = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const dbMode = (await stat(path.join(root, "state/rednote-sync.sqlite"))).mode & 0o777;
    const dirMode = (await stat(path.join(root, "state"))).mode & 0o777;
    assert.equal(dbMode, 0o600);
    assert.equal(dirMode, 0o700);
    store.close();
    const inspectDb = new DatabaseSync(path.join(root, "state/rednote-sync.sqlite"));
    const tables = inspectDb.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get() as { n: number };
    assert.ok(Number(tables.n) >= 14);
    const migration = inspectDb.prepare("SELECT command,outcome FROM schema_migrations").get() as Record<string, unknown>;
    assert.deepEqual([migration.command, migration.outcome], ["init_schema", "committed"]);
    inspectDb.close();

    await mkdir(path.join(half, "state"), { mode: 0o700 });
    const raw = new DatabaseSync(path.join(half, "state/rednote-sync.sqlite"));
    raw.exec("CREATE TABLE partial(value TEXT)"); raw.close();
    await assert.rejects(SqliteStateStore.init(half), SafeError);
  } finally { await rm(root, { recursive: true, force: true }); await rm(half, { recursive: true, force: true }); }
});

test("strict sequential migration applies N+1/N+2 in one transaction and rolls back gaps", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE meta(schema_version INTEGER); INSERT INTO meta VALUES(0); CREATE TABLE events(v INTEGER)");
    applySequentialMigrations(db, 0, 2, new Map([
      [1, (database: DatabaseSync) => database.exec("INSERT INTO events VALUES(1)")],
      [2, (database: DatabaseSync) => database.exec("INSERT INTO events VALUES(2)")],
    ]));
    assert.deepEqual((db.prepare("SELECT v FROM events ORDER BY v").all() as { v: number }[]).map((row) => Number(row.v)), [1, 2]);
    assert.equal(Number((db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version), 2);
    assert.throws(() => applySequentialMigrations(db, 2, 4, new Map([[3, (database: DatabaseSync) => database.exec("INSERT INTO events VALUES(3)")]])), SafeError);
    assert.deepEqual((db.prepare("SELECT v FROM events ORDER BY v").all() as { v: number }[]).map((row) => Number(row.v)), [1, 2]);
  } finally { db.close(); }
});

test("formal migrate_schema records its step, rejects ordinary open, and rolls back injected failure", async () => {
  const root = await tempRoot();
  try {
    const initialized = await SqliteStateStore.init(root);
    initialized.close();
    const dbPath = path.join(root, "state/rednote-sync.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("ALTER TABLE meta RENAME TO meta_v1; CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version = 0)); INSERT INTO meta VALUES(0); DROP TABLE meta_v1; DELETE FROM schema_migrations");
    legacy.close();
    await assert.rejects(SqliteStateStore.open(root), SafeError);
    await assert.rejects(SqliteStateStore.migrate(root, undefined, { beforeFinalValidation() { throw new Error("raw injected migration detail"); } }), (error: unknown) => error instanceof SafeError && !error.message.includes("raw injected"));
    const afterFailure = new DatabaseSync(dbPath);
    assert.equal(Number((afterFailure.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version), 0);
    assert.equal(Number((afterFailure.prepare("SELECT count(*) AS n FROM schema_migrations WHERE command='migrate_schema'").get() as { n: number }).n), 0);
    afterFailure.close();
    const migrated = await SqliteStateStore.migrate(root);
    migrated.close();
    const inspect = new DatabaseSync(dbPath);
    const row = inspect.prepare("SELECT from_version,to_version,outcome FROM schema_migrations WHERE command='migrate_schema'").get() as Record<string, unknown>;
    assert.deepEqual([Number(row.from_version), Number(row.to_version), row.outcome], [0, 1, "committed"]);
    inspect.close();
    await assert.rejects(SqliteStateStore.migrate(root), SafeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema migration records are exact, sequential, and transaction-command bound", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const tx = store.beginSchemaImmediate("migrate_schema");
    const record = { migrationId: "migrate-v0-v1", command: "migrate_schema" as const, fromVersion: 0, toVersion: 1, startedAt: time1, finishedAt: time2, outcome: "committed" as const, safeErrorCategory: null };
    assert.throws(() => store.putSchemaMigration(tx, { ...record, extra: true } as never), SafeError);
    assert.throws(() => store.putSchemaMigration(tx, record), SafeError);
    store.rollback(tx); store.close();
    const raw = new DatabaseSync(path.join(root, "state/rednote-sync.sqlite"));
    assert.equal(Number((raw.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n), 1);
    raw.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("write lifecycle requires exactly one finalization and forbids writes after it", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const unfinished = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(unfinished, account);
    assert.throws(() => store.commit(unfinished), SafeError);
    store.rollback(unfinished);
    const emptyRead = store.openReadSnapshot();
    assert.equal([...emptyRead.enumerateAccountsWithGenerations()].length, 0);
    emptyRead.close();

    const tx = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(tx, account);
    const generation = 1;
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, generation, issueBusinessResult(store, tx, repairRun(partition)));
    store.finalizeAccount(tx, batch);
    assert.throws(() => store.finalizeAccount(tx, batch), SafeError);
    assert.throws(() => store.upsertAccount(tx, account), SafeError);
    store.commit(tx);
    assert.throws(() => tx.enumerateAccountsWithGenerations(), SafeError);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("injected SQL commit failure preserves the finalized latch and permits rollback", async () => {
  const root = await tempRoot();
  try {
    let failCommit = true;
    const store = await SqliteStateStore.init(root, undefined, { beforeCommit() { if (failCommit) throw new Error("raw commit detail"); } });
    const objects = store.objectStore();
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const tx = store.beginImmediate({ command: "repair_views", account: partition });
    store.upsertAccount(tx, account);
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, repairRun(partition)));
    store.finalizeAccount(tx, batch);
    assert.throws(() => store.commit(tx), (error: unknown) => error instanceof SafeError && !error.message.includes("raw commit"));
    assert.throws(() => store.upsertAccount(tx, account), SafeError);
    failCommit = false;
    store.rollback(tx);
    const read = store.openReadSnapshot();
    assert.equal([...read.enumerateAccountsWithGenerations()].length, 0);
    read.close();
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every critical finalization SQL step fails closed and remains rollbackable", async (context) => {
  const steps: readonly FinalizeStep[] = ["run", "view:notes", "view:assets", "view:index", "view:failures", "view:runs", "generation"];
  for (const step of steps) await context.test(step, async () => {
    const root = await tempRoot(`rednote-finalize-${step.replaceAll(":", "-")}-`);
    try {
      const store = await SqliteStateStore.init(root, undefined, { beforeFinalizeStep(current) { if (current === step) throw new Error("raw finalization injection detail"); } });
      const objects = store.objectStore();
      const account = makeAccount();
      const partition = { hostId: account.hostId, accountId: account.accountId };
      const tx = store.beginImmediate({ command: "repair_views", account: partition });
      store.upsertAccount(tx, account);
      const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, repairRun(partition, `fault-${step}`)));
      assert.throws(() => store.finalizeAccount(tx, batch), (error: unknown) => error instanceof SafeError && !error.message.includes("raw finalization"));
      assert.throws(() => store.commit(tx), SafeError);
      store.rollback(tx);
      const read = store.openReadSnapshot();
      assert.equal([...read.enumerateAccountsWithGenerations()].length, 0);
      read.close(); store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("foreign keys rollback and a second writer receives BUSY immediately", async () => {
  const root = await tempRoot();
  try {
    await initAccount(root);
    const first = await SqliteStateStore.open(root);
    const second = await SqliteStateStore.open(root);
    const scope = makeScope();
    const tx = first.beginImmediate({ command: "sync", scope });
    assert.throws(() => second.beginImmediate({ command: "sync", scope }), (error: unknown) => error instanceof SafeError && error.code === "BUSY");
    first.rollback(tx);
    first.close(); second.close();
    const raw = new DatabaseSync(path.join(root, "state/rednote-sync.sqlite"));
    raw.exec("PRAGMA foreign_keys=ON");
    assert.throws(() => raw.prepare("INSERT INTO account_generations(account_key,canonical_generation,views_dirty) VALUES(?,0,1)").run("f".repeat(64)));
    assert.equal(raw.prepare("SELECT count(*) n FROM account_generations").get()?.n, 1);
    raw.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical mutation, all projectors, final run, and formal snapshot enumerators are atomic", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const account = makeAccount();
    const partition = accountPartition(scope);
    const manifest = await makeManifest(objects);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time2, lastSuccessfulAt: time2, nextAllowedAt: null }) as SyncState;
    const task = Object.freeze({ schemaVersion: 1 as const, scope, noteId: manifest.noteId, status: "done" as const, attemptCount: 1, failureIds: Object.freeze([]), skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time2 });
    const run = makeRun(scope);
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, account);
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { [manifest.noteId]: null }, nextState: state, manifests: [manifest], tasks: [task, task], failures: [] })), SafeError);
    store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: { [manifest.noteId]: null }, nextState: state, manifests: [manifest], tasks: [task], failures: [] })));
    const generation = tx.accountGeneration(partition) + 1;
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, generation, issueBusinessResult(store, tx, run, [task.noteId]));
    assert.deepEqual(batch.outcomes.map((outcome) => [outcome.projectorId, outcome.complete]), [["notes", true], ["assets", true], ["index", true], ["failures", true], ["runs", true]]);
    store.finalizeAccount(tx, batch);
    store.commit(tx);

    const read = store.openReadSnapshot();
    assert.equal([...read.enumerateAccountsWithGenerations()].length, 1);
    assert.equal([...read.enumerateAccountManifests(partition)].length, 1);
    assert.equal([...read.enumerateAccountTasks(partition)].length, 1);
    assert.equal([...read.enumerateObjectRefs(partition)].length, 2);
    assert.equal([...read.enumerateRuns(partition)].length, 1);
    assert.equal(read.enumerateViewGenerations(accountKey(partition)).every((row) => row.complete && row.generation === 1), true);
    assert.equal(read.loadState(scope)?.revision, 1);
    assert.equal(read.loadManifest(partition, manifest.noteId)?.canonicalNote.contentHash, manifest.canonicalNote.contentHash);
    read.close();
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("formal reads reject structured-column and exact-receipt divergence", async () => {
  const root = await tempRoot();
  try {
    await initAccount(root);
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const raw = new DatabaseSync(path.join(root, "state/rednote-sync.sqlite"));
    raw.prepare("UPDATE runs SET outcome='failed' WHERE run_id='repairA'").run();
    raw.prepare("UPDATE view_generations SET receipts_json=? WHERE projector_id='notes'").run('[{"extra":true}]');
    raw.close();
    const store = await SqliteStateStore.open(root);
    const read = store.openReadSnapshot();
    assert.throws(() => read.enumerateViewGenerations(accountKey(partition)), SafeError);
    assert.throws(() => [...read.enumerateRuns(partition)], SafeError);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projector failure commits dirty state for only the intended account", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    for (const id of ["accA", "accB"]) {
      const account = makeAccount(id);
      const partition = { hostId: account.hostId, accountId: account.accountId };
      const tx = store.beginImmediate({ command: "repair_views", account: partition });
      store.upsertAccount(tx, account);
      const generation = 1;
      const batch = await projectAccountInOrder(createProjectors(root, objects, undefined, id === "accA" ? "assets" : null), tx, partition, generation, issueBusinessResult(store, tx, repairRun(partition, `repair-${id}`)));
      store.finalizeAccount(tx, batch);
      store.commit(tx);
    }
    const read = store.openReadSnapshot();
    const rows = [...read.enumerateAccountsWithGenerations()];
    assert.equal(rows.length, 2);
    const a = rows.find((row) => row.account.accountId === "accA")!;
    const b = rows.find((row) => row.account.accountId === "accB")!;
    assert.equal(a.viewsDirty, true); assert.equal(b.viewsDirty, false);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite DB/WAL symlinks and unsafe state permissions are rejected before open", async () => {
  const roots = [await tempRoot(), await tempRoot(), await tempRoot()];
  const outside = path.join(roots[0]!, "outside-file");
  try {
    await writeFile(outside, "not a database", { mode: 0o600 });
    await mkdir(path.join(roots[0]!, "state"), { mode: 0o700 });
    await symlink(outside, path.join(roots[0]!, "state/rednote-sync.sqlite"));
    await assert.rejects(SqliteStateStore.init(roots[0]!), SafeError);

    await initAccount(roots[1]!);
    await symlink(outside, path.join(roots[1]!, "state/rednote-sync.sqlite-wal"));
    await assert.rejects(SqliteStateStore.open(roots[1]!), SafeError);

    await initAccount(roots[2]!);
    await chmod(path.join(roots[2]!, "state"), 0o777);
    await assert.rejects(SqliteStateStore.open(roots[2]!), SafeError);
  } finally { for (const root of roots) await rm(root, { recursive: true, force: true }); }
});

test("blocker-style task/failure persists without a manifest and retry enumeration is scoped and stable", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const account = makeAccount();
    const partition = accountPartition(scope);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time2, lastSuccessfulAt: null, nextAllowedAt: null }) as SyncState;
    const failureBase = { scope, noteId: "noteMissing" as never, mediaSlot: null, category: "DETAIL" as const, stage: "detail" as const };
    const failure = Object.freeze({ schemaVersion: 1 as const, failureId: computeFailureId(failureBase), ...failureBase, sourceRank: null, safeMessage: "detail unavailable", retryable: true, attemptCount: 1, firstOccurredAt: time1, lastOccurredAt: time2, retryAt: null, resolvedAt: null, resolvedReason: null });
    const task = Object.freeze({ schemaVersion: 1 as const, scope, noteId: failure.noteId, status: "partial" as const, attemptCount: 1, failureIds: Object.freeze([failure.failureId]), skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time2 });
    const tx = store.beginImmediate({ command: "sync", scope });
    store.upsertAccount(tx, account);
    assert.throws(() => store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: {}, nextState: state, manifests: [], tasks: [task], failures: [failure, failure] })), SafeError);
    store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: {}, nextState: state, manifests: [], tasks: [task], failures: [failure] })));
    const run = makeRun(scope, "sync", "runBlocker");
    const businessRun = Object.freeze({ ...run, outcome: "blocked" as const, safeErrorCategory: "DETAIL" as const, done: 0, partial: 1 });
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, businessRun, [task.noteId]));
    assert.equal(batch.finalRun.outcome, "blocked");
    assert.equal(batch.finalRun.safeErrorCategory, "DETAIL");
    store.finalizeAccount(tx, batch);
    store.commit(tx);
    const read = store.openReadSnapshot();
    assert.equal(read.loadManifest(partition, failure.noteId), null);
    assert.equal(read.loadTask(scope, failure.noteId)?.failureIds[0], failure.failureId);
    assert.equal([...read.enumerateUnresolvedFailures(partition)].length, 1);
    assert.equal(read.retryCandidates(scope, 1)[0]?.failureId, failure.failureId);
    assert.throws(() => read.retryCandidates(scope, 11), SafeError);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("foreign and closed snapshots cannot query or mutate another connection", async () => {
  const firstRoot = await tempRoot();
  const secondRoot = await tempRoot();
  try {
    const first = await SqliteStateStore.init(firstRoot);
    const second = await SqliteStateStore.init(secondRoot);
    const account = makeAccount();
    const partition = { hostId: account.hostId, accountId: account.accountId };
    const tx = first.beginImmediate({ command: "repair_views", account: partition });
    assert.throws(() => second.upsertAccount(tx, account), SafeError);
    first.rollback(tx);
    assert.throws(() => tx.enumerateAccountsWithGenerations(), SafeError);
    first.close(); second.close();
  } finally { await rm(firstRoot, { recursive: true, force: true }); await rm(secondRoot, { recursive: true, force: true }); }
});

test("intent account, single canonical mutation, and finalization outcome shapes are runtime enforced", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const account = makeAccount();
    const partition = accountPartition(scope);
    const tx = store.beginImmediate({ command: "sync", scope });
    assert.throws(() => store.upsertAccount(tx, makeAccount("accB")), SafeError);
    store.upsertAccount(tx, account);
    const state: SyncState = Object.freeze({ ...scope, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: time1, nextAllowedAt: null }) as SyncState;
    const mutation = withMergeCandidates({ scope, expectedStateRevision: 0, expectedManifestRevisions: {}, nextState: state, manifests: [], tasks: [], failures: [] });
    store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, mutation));
    assert.throws(() => store.prepareCanonicalWritePlan(tx, { ...mutation, expectedStateRevision: 1, nextState: { ...state, revision: 2 } }), SafeError);
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, 1, issueBusinessResult(store, tx, { ...makeRun(scope), listed: 0, done: 0 }));
    const outcomes = [...batch.outcomes] as Record<string, unknown>[];
    outcomes[0] = { ...outcomes[0], safeError: "must be null on success" };
    assert.throws(() => store.finalizeAccount(tx, { outcomes, finalRun: batch.finalRun } as never), SafeError);
    const forged = ["notes", "assets", "index", "failures", "runs"].map((projectorId) => ({ projectorId, accountKey: accountKey(partition), generation: 1, complete: true, receipts: [], safeError: null }));
    assert.throws(() => store.finalizeAccount(tx, { outcomes: forged, finalRun: makeRun(scope) } as never), SafeError);
    store.rollback(tx); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trusted zero-mutation BusinessResult preserves not_due/paused outcomes and zero counters", async () => {
  const root = await tempRoot();
  try {
    await initAccount(root);
    const store = await SqliteStateStore.open(root);
    const objects = store.objectStore();
    const scope = makeScope();
    const partition = accountPartition(scope);
    for (const [index, outcome] of (["not_due", "paused"] as const).entries()) {
      const tx = store.beginImmediate({ command: "sync", scope });
      const run = { ...makeRun(scope, "sync", `no-op-${outcome}`), outcome, safeErrorCategory: outcome === "paused" ? "PAUSED" as const : null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 };
      if (index === 0) assert.throws(() => issueBusinessResult(store, tx, run, ["noteA" as never, "noteA" as never]), SafeError);
      const result = issueBusinessResult(store, tx, run);
      await assert.rejects(projectAccountInOrder(createProjectors(root, objects), tx, partition, index + 2, { ...result } as never), SafeError);
      const batch = await projectAccountInOrder(createProjectors(root, objects), tx, partition, index + 2, result);
      assert.equal(batch.finalRun.outcome, outcome);
      assert.deepEqual([batch.finalRun.listed, batch.finalRun.done, batch.finalRun.partial, batch.finalRun.failed, batch.finalRun.skipped], [0, 0, 0, 0, 0]);
      store.finalizeAccount(tx, batch); store.commit(tx);
    }
    const read = store.openReadSnapshot();
    assert.equal(read.loadState(scope), null);
    assert.deepEqual([...read.enumerateRuns(partition)].filter((run) => run.runId.startsWith("no-op-")).map((run) => run.outcome).sort(), ["not_due", "paused"]);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepted media rank can atomically resolve a failure and task in another target of the same account", async () => {
  const root = await tempRoot();
  try {
    const store = await SqliteStateStore.init(root);
    const objects = store.objectStore();
    const liked = makeScope("accA", "liked");
    const collected = makeScope("accA", "collected");
    const account = makeAccount();
    const partition = accountPartition(liked);
    const baseManifest = await makeManifest(objects);
    const object = await objects.put((async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]); })(), null, new AbortController().signal);
    const media = { mediaId: "image-1", kind: "image" as const, ordinal: 1, status: "stored" as const, extension: "png", object };
    const rawNote = { ...baseManifest.canonicalNote, noteType: "image" as const, media: [media] };
    const note = Object.freeze({ ...rawNote, contentHash: computeContentHash(rawNote) });
    const rank = createValidatedNoteRank(note, time2);
    const signal = new AbortController().signal;
    const json = await objects.put(bytesIterable(renderNoteJsonBytes(note)), null, signal);
    const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(note)), null, signal);
    const manifest = Object.freeze({ ...baseManifest, canonicalNote: note, semanticSourceRank: rank, mediaSlots: [{ slot: { kind: "image" as const, ordinal: 1 }, sourceRank: rank, media, tombstone: false }], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) });
    const failureBase = { scope: liked, noteId: manifest.noteId, mediaSlot: { kind: "image" as const, ordinal: 1 }, category: "MEDIA" as const, stage: "media" as const };
    const failure = Object.freeze({ schemaVersion: 1 as const, failureId: computeFailureId(failureBase), ...failureBase, sourceRank: rank, safeMessage: "media unavailable", retryable: true, attemptCount: 1, firstOccurredAt: time1, lastOccurredAt: time1, retryAt: null, resolvedAt: null, resolvedReason: null });
    const partial = Object.freeze({ schemaVersion: 1 as const, scope: liked, noteId: manifest.noteId, status: "partial" as const, attemptCount: 1, failureIds: [failure.failureId], skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time1 });
    const stateLiked: SyncState = Object.freeze({ ...liked, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time1, lastSuccessfulAt: null, nextAllowedAt: null }) as SyncState;
    const first = store.beginImmediate({ command: "sync", scope: liked });
    store.upsertAccount(first, account);
    store.putCanonicalMutation(first, store.prepareCanonicalWritePlan(first, withMergeCandidates({ scope: liked, expectedStateRevision: 0, expectedManifestRevisions: { [manifest.noteId]: null }, nextState: stateLiked, manifests: [manifest], tasks: [partial], failures: [failure] })));
    const firstRun = Object.freeze({ ...makeRun(liked, "sync", "likedPartial"), done: 0, partial: 1 });
    const firstBatch = await projectAccountInOrder(createProjectors(root, objects), first, partition, 1, issueBusinessResult(store, first, firstRun, [partial.noteId]));
    assert.equal(firstBatch.finalRun.outcome, "committed_with_warnings");
    assert.equal(firstBatch.finalRun.safeErrorCategory, "MEDIA");
    store.finalizeAccount(first, firstBatch);
    store.commit(first);

    const resolved = Object.freeze({ ...failure, resolvedAt: time2, resolvedReason: "repaired" as const, lastOccurredAt: time2 });
    const doneLiked = Object.freeze({ ...partial, status: "done" as const, failureIds: [], updatedAt: time2 });
    const doneCollected = Object.freeze({ ...partial, scope: collected, status: "done" as const, failureIds: [], updatedAt: time2 });
    const stateCollected: SyncState = Object.freeze({ ...collected, schemaVersion: 1, revision: 1, progress: initialProgress(), stopReason: null, lastAttemptAt: time2, lastSuccessfulAt: time2, nextAllowedAt: null }) as SyncState;
    const secondManifest = Object.freeze({ ...manifest, revision: 2 });
    const second = store.beginImmediate({ command: "sync", scope: collected });
    store.putCanonicalMutation(second, store.prepareCanonicalWritePlan(second, withMergeCandidates({ scope: collected, expectedStateRevision: 0, expectedManifestRevisions: { [manifest.noteId]: 1 }, nextState: stateCollected, manifests: [secondManifest], tasks: [doneLiked, doneCollected], failures: [resolved] })));
    const secondRun = Object.freeze({ ...makeRun(collected, "sync", "collectedRepair") });
    const secondBatch = await projectAccountInOrder(createProjectors(root, objects), second, partition, 2, issueBusinessResult(store, second, secondRun, [doneCollected.noteId]));
    store.finalizeAccount(second, secondBatch);
    store.commit(second);
    const read = store.openReadSnapshot();
    assert.equal(read.loadTask(liked, manifest.noteId)?.status, "done");
    assert.equal(read.loadTask(collected, manifest.noteId)?.status, "done");
    assert.equal([...read.enumerateUnresolvedFailures(partition)].length, 0);
    const runs = [...read.enumerateRuns(partition)];
    const mediaRun = runs.find((run) => run.runId === "likedPartial")!;
    assert.deepEqual([mediaRun.outcome, mediaRun.safeErrorCategory, mediaRun.listed, mediaRun.partial], ["committed_with_warnings", "MEDIA", 1, 1]);
    const crossTargetRun = runs.find((run) => run.runId === "collectedRepair")!;
    assert.deepEqual([crossTargetRun.listed, crossTargetRun.done], [1, 1]);
    const jsonl = (await readFile(path.join(root, `accounts/${accountKey(partition)}/logs/export-runs.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RunRecord);
    assert.deepEqual([jsonl.find((run) => run.runId === "likedPartial")!.outcome, jsonl.find((run) => run.runId === "likedPartial")!.safeErrorCategory], ["committed_with_warnings", "MEDIA"]);
    read.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
