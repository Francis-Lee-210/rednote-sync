import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { acknowledgeStop, repairViews, skipTask } from "../src/commands.ts";
import { resumeScope } from "../src/control.ts";
import { MemorySecretRegistry } from "../src/secrets.ts";
import { createProjectors, projectAccountInOrder } from "../src/projectors.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { accountKey, accountPartition, decodeNoteId } from "../src/types.ts";
import { readStatus, verifyRoot } from "../src/verify.ts";
import { makeScope, tempRoot } from "./helpers.ts";
import { fixtureDetail, fixtureFailure, fixturePage, openStage3bFixture, stage3bNow } from "./stage3b-fixtures.ts";

const clock = Object.freeze({ now: () => stage3bNow, sleep: async () => {} });

async function init(label: string): Promise<string> { const root = await tempRoot(label); (await SqliteStateStore.init(root)).close(); return root; }

async function dbSnapshot(root: string, scope: ReturnType<typeof makeScope>) {
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  try {
    const generation = [...snapshot.enumerateAccountsWithGenerations()].find((item) => item.accountKey === accountKey(scope)) ?? null;
    return { generation, state: snapshot.loadState(scope), task: snapshot.loadTask(scope, decodeNoteId("note")), failures: [...snapshot.enumerateUnresolvedFailures(accountPartition(scope))], runs: [...snapshot.enumerateRuns(accountPartition(scope))] };
  } finally { snapshot.close(); store.close(); }
}

test("acknowledge-stop is exact: wrong reason is zero mutation and matching reason clears atomically", async () => {
  const root = await init("rednote-ack-");
  const scope = makeScope("ack-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [], { listFailure: fixtureFailure("AUTH_REQUIRED") })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const before = await dbSnapshot(root, scope);
  const mismatch = await acknowledgeStop(root, scope, "PROTOCOL", clock);
  assert.deepEqual(mismatch, { run: null, exitCode: 0 });
  assert.deepEqual(await dbSnapshot(root, scope), before);
  await resumeScope(root, scope);
  assert.equal((await dbSnapshot(root, scope)).state?.stopReason, "AUTH_REQUIRED", "resume does not clear durable stop");
  const matched = await acknowledgeStop(root, scope, "AUTH_REQUIRED", clock);
  assert.equal(matched.exitCode, 0);
  assert.equal((await dbSnapshot(root, scope)).state?.stopReason, null);
});

test("skip resolves only the full-scope task failures and direct API enforces the safe reason contract", async () => {
  const root = await init("rednote-skip-");
  const scope = makeScope("skip-account");
  const detail = fixtureDetail(scope, "note", { media: [{ kind: "image", ordinal: 1, mediaId: "media", failure: fixtureFailure("MEDIA") }] });
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["note"], { details: [detail] })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const registry = new MemorySecretRegistry();
  registry.register("dynamic-secret-value");
  for (const reason of ["界".repeat(81), "https://fixture.invalid/reason", "dynamic-secret-value"]) {
    await assert.rejects(skipTask(root, scope, decodeNoteId("note"), reason, clock, registry));
  }
  const result = await skipTask(root, scope, decodeNoteId("note"), "known duplicate", clock, registry);
  assert.equal(result.exitCode, 0);
  const after = await dbSnapshot(root, scope);
  assert.equal(after.task?.status, "skipped");
  assert.equal(after.task?.skipReason, "known duplicate");
  assert.equal(after.failures.length, 0);
});

test("verify is read-only, reports a missing receipt, and full-account repair restores it", async () => {
  const root = await init("rednote-verify-repair-");
  const scope = makeScope("verify-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["note"])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  assert.equal((await verifyRoot(root)).exitCode, 0);
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const generation = [...snapshot.enumerateAccountsWithGenerations()][0]!;
  const notes = snapshot.enumerateViewGenerations(generation.accountKey).find((view) => view.projectorId === "notes")!;
  const damaged = notes.receipts[0]!;
  const beforeGeneration = generation.canonicalGeneration;
  snapshot.close(); store.close();
  await unlink(path.join(root, damaged.relativePath));
  const marker = path.join(root, `accounts/${generation.accountKey}/.views/notes.generation.json`);
  const markerMtime = (await stat(marker)).mtimeMs;
  const report = await verifyRoot(root);
  assert.equal(report.exitCode, 9);
  assert.equal((await stat(marker)).mtimeMs, markerMtime, "verify never rewrites markers");
  assert.equal((await dbSnapshot(root, scope)).generation?.canonicalGeneration, beforeGeneration, "verify never advances generation");
  assert.equal((await repairViews(root, accountPartition(scope), clock)).exitCode, 0);
  assert.equal((await verifyRoot(root)).exitCode, 0);
  assert.equal((await dbSnapshot(root, scope)).generation?.canonicalGeneration, beforeGeneration + 1);
});

test("verify performs G/close/G2 retry and returns 9 after two continuously changing snapshots", async () => {
  const root = await init("rednote-verify-g2-");
  const scope = makeScope("verify-generation-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  let changes = 0;
  const stable = await verifyRoot(root, { async afterFirstSnapshot(attempt) { if (attempt === 1) { changes += 1; await repairViews(root, accountPartition(scope), clock); } } });
  assert.equal(stable.attempts, 2);
  assert.equal(stable.exitCode, 0);
  assert.equal(changes, 1);
  const changing = await verifyRoot(root, { async afterFirstSnapshot() { await repairViews(root, accountPartition(scope), clock); } });
  assert.equal(changing.attempts, 2);
  assert.equal(changing.exitCode, 9);
});

test("status reads exact scope state without changing generation or views", async () => {
  const root = await init("rednote-status-");
  const scope = makeScope("status-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const before = await dbSnapshot(root, scope);
  const status = await readStatus(root, scope) as { readonly state: unknown };
  assert.deepEqual(status.state, before.state);
  assert.deepEqual(await dbSnapshot(root, scope), before);
});

test("verify reports a committed incomplete projector and repair clears the warning", async () => {
  const root = await init("rednote-verify-incomplete-");
  const scope = makeScope("verify-incomplete-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const store = await SqliteStateStore.open(root);
  const objects = store.objectStore();
  const tx = store.beginImmediate({ command: "repair_views", account: accountPartition(scope) });
  const business = store.prepareBusinessResult(tx, { runId: "incomplete-run", outcome: "committed", startedAt: stage3bNow, finishedAt: stage3bNow, safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0, primaryNoteIds: [] });
  const batch = await projectAccountInOrder(createProjectors(root, objects, objects.registry, "notes"), tx, accountPartition(scope), tx.accountGeneration(accountPartition(scope)) + 1, business);
  store.finalizeAccount(tx, batch);
  store.commit(tx);
  store.close();
  const report = await verifyRoot(root);
  assert.equal(report.exitCode, 9);
  assert.ok(report.warnings.some((warning) => warning.projectorId === "notes" && warning.code === "VIEW_INCOMPLETE"));
  assert.equal((await repairViews(root, accountPartition(scope), clock)).exitCode, 0);
  assert.equal((await verifyRoot(root)).exitCode, 0);
});

test("verify reports viewsDirty disagreement in both directions without mutating canonical state", async () => {
  const root = await init("rednote-verify-dirty-");
  const scope = makeScope("verify-dirty-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["note"])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const databasePath = path.join(root, "state", "rednote-sync.sqlite");
  let database = new DatabaseSync(databasePath);
  database.prepare("UPDATE account_generations SET views_dirty=1 WHERE account_key=?").run(accountKey(scope));
  database.close();
  const dirtyBefore = await dbSnapshot(root, scope);
  let report = await verifyRoot(root);
  assert.equal(report.exitCode, 9);
  assert.ok(report.warnings.some((warning) => warning.projectorId === null && warning.code === "VIEW_STALE"));
  assert.deepEqual(await dbSnapshot(root, scope), dirtyBefore, "verify must not clear a stale viewsDirty bit");

  database = new DatabaseSync(databasePath);
  database.prepare("UPDATE account_generations SET views_dirty=0 WHERE account_key=?").run(accountKey(scope));
  database.prepare("UPDATE view_generations SET complete=0,safe_error='test incomplete' WHERE account_key=? AND projector_id='notes'").run(accountKey(scope));
  database.close();
  const incompleteBefore = await dbSnapshot(root, scope);
  report = await verifyRoot(root);
  assert.equal(report.exitCode, 9);
  assert.ok(report.warnings.some((warning) => warning.projectorId === "notes" && warning.code === "VIEW_INCOMPLETE"));
  assert.ok(report.warnings.some((warning) => warning.projectorId === null && warning.code === "VIEW_STALE"));
  assert.deepEqual(await dbSnapshot(root, scope), incompleteBefore, "verify must not repair an incomplete view or set viewsDirty");
});
