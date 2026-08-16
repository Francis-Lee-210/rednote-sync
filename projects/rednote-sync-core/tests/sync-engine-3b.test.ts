import assert from "node:assert/strict";
import test from "node:test";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { requestScopePause, resumeScope } from "../src/control.ts";
import { PROJECTOR_ORDER, type ProjectorId } from "../src/view-types.ts";
import { SqliteAccountStore, SqliteStateStore } from "../src/state-store.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { accountKey, accountPartition, decodeNoteId, decodePartitionScope, initialProgress, noteKey } from "../src/types.ts";
import { makeScope, tempRoot } from "./helpers.ts";
import { fixtureDetail, fixtureFailure, fixturePage, openStage3bFixture, stage3bNow } from "./stage3b-fixtures.ts";

const clock = Object.freeze({ now: () => stage3bNow, sleep: async (_milliseconds: number, signal: AbortSignal) => { if (signal.aborted) throw new Error("aborted"); } });

async function init(label: string): Promise<string> {
  const root = await tempRoot(label);
  (await SqliteStateStore.init(root)).close();
  return root;
}

async function stateAt(root: string, scope: ReturnType<typeof makeScope>) {
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  try {
    return {
      account: new SqliteAccountStore().load(snapshot, scope.hostId, scope.accountId),
      state: snapshot.loadState(scope),
      tasks: [...snapshot.enumerateAccountTasks(accountPartition(scope))],
      failures: [...snapshot.enumerateUnresolvedFailures(accountPartition(scope))],
      runs: [...snapshot.enumerateRuns(accountPartition(scope))],
    };
  } finally { snapshot.close(); store.close(); }
}

async function generationAt(root: string) {
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  try { return [...snapshot.enumerateAccountsWithGenerations()][0]; }
  finally { snapshot.close(); store.close(); }
}

async function exerciseProjectionBoundaryPause(mode: "pause_file" | "abort", projectorId: ProjectorId, requestedPhase: "before_projector" | "after_projector" | "before_render_item" | "after_stable_file" | null = null): Promise<void> {
  const root = await init(`rednote-projection-${mode}-${projectorId}-`);
  const scope = makeScope(`${mode}-${projectorId}`);
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["old-note"])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  session.close();
  const before = await stateAt(root, scope);
  const beforeGeneration = await generationAt(root);
  const controller = new AbortController();
  let triggered = false;
  const changedAccount = { schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, displayName: "Must Not Merge", firstSeenAt: "2026-02-01T00:00:00.000Z", lastSeenAt: "2026-03-03T00:00:00.000Z" };
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["new-note"], { details: [{ noteId: "new-note", failure: fixtureFailure("DETAIL") }] })], [], "fixture", "changed-account.json", changedAccount);
  const result = await new SyncEngine({
    root, scope, session, clock, minimumIntervalMs: 0,
    projectionBoundaryObserver: async (point) => {
      assert.equal(Object.isFrozen(point), true);
      const phase = requestedPhase ?? (mode === "pause_file" ? "before_projector" : "after_projector");
      if (triggered || point.projectorId !== projectorId || point.phase !== phase) return;
      triggered = true;
      if (mode === "abort") controller.abort();
      else await requestScopePause(root, scope);
    },
  }).runPage(controller.signal);
  assert.equal(triggered, true);
  assert.equal(result.exitCode, 7);
  assert.equal(result.run.outcome, "paused");
  assert.equal(result.run.safeErrorCategory, "PAUSED");
  assert.deepEqual({ listed: result.run.listed, done: result.run.done, partial: result.run.partial, failed: result.run.failed, skipped: result.run.skipped }, { listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 });
  const after = await stateAt(root, scope);
  assert.deepEqual(after.account, before.account);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.failures, before.failures);
  assert.equal(after.tasks.some((task) => task.noteId === "new-note"), false);
  assert.equal((await generationAt(root))?.canonicalGeneration, (beforeGeneration?.canonicalGeneration ?? 0) + 1);
  if (mode === "pause_file") await resumeScope(root, scope);
  session.close();
}

for (const projectorId of PROJECTOR_ORDER) {
  test(`projection pause file at ${projectorId} rolls back canonical progress and commits only a paused run`, async () => exerciseProjectionBoundaryPause("pause_file", projectorId));
  test(`projection AbortSignal at ${projectorId} rolls back canonical progress and commits only a paused run`, async () => exerciseProjectionBoundaryPause("abort", projectorId));
}

test("pause recovery covers render-item and stable-file boundaries for all five projectors", async () => {
  for (const projectorId of PROJECTOR_ORDER) {
    await exerciseProjectionBoundaryPause("pause_file", projectorId, "before_render_item");
    await exerciseProjectionBoundaryPause("abort", projectorId, "after_stable_file");
  }
});

test("a pause after publishing a new stable note file removes the ahead projection footprint", async () => {
  const root = await init("rednote-projection-footprint-");
  const scope = makeScope("projection-footprint");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["old-note"])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  session.close();
  const before = await stateAt(root, scope);
  let stableWrites = 0;
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["new-note"])]);
  const result = await new SyncEngine({
    root, scope, session, clock, minimumIntervalMs: 0,
    projectionBoundaryObserver: async (point) => {
      if (point.projectorId === "notes" && point.phase === "after_stable_file" && ++stableWrites === 3) await requestScopePause(root, scope);
    },
  }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 7);
  assert.deepEqual((await stateAt(root, scope)).state, before.state);
  const partition = accountPartition(scope);
  const digest = noteKey(partition, decodeNoteId("new-note"));
  const key = accountKey(partition);
  await assert.rejects(access(path.join(root, "accounts", key, "notes", `${digest}.md`)));
  await assert.rejects(access(path.join(root, "accounts", key, "data", "notes", `${digest}.json`)));
  await resumeScope(root, scope);
  session.close();
});

test("projection pause recovery also covers a list blocker and an empty retry run", async () => {
  for (const command of ["sync", "retry"] as const) {
    const root = await init(`rednote-projection-${command}-seal-`);
    const scope = makeScope(`projection-${command}-seal`);
    let seed = await openStage3bFixture(root, scope, [fixturePage(scope, null, [])], [], "fixture", "seed.json");
    await new SyncEngine({ root, scope, session: seed, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    seed.close();
    const before = await stateAt(root, scope);
    let triggered = false;
    const pages = command === "sync" ? [fixturePage(scope, null, [], { listFailure: fixtureFailure("NETWORK") })] : [];
    const changedAccount = { schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, displayName: "Must Not Merge", firstSeenAt: "2026-02-01T00:00:00.000Z", lastSeenAt: "2026-03-03T00:00:00.000Z" };
    const session = await openStage3bFixture(root, scope, pages, [], "fixture", "changed.json", changedAccount);
    const engine = new SyncEngine({
      root, scope, session, clock, minimumIntervalMs: 600_000,
      projectionBoundaryObserver: async (point) => {
        if (!triggered && point.projectorId === "runs" && point.phase === "before_projector") { triggered = true; await requestScopePause(root, scope); }
      },
    });
    const result = command === "sync" ? await engine.runPage(new AbortController().signal) : await engine.retryFailures(new AbortController().signal);
    assert.equal(triggered, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.run.outcome, "paused");
    const after = await stateAt(root, scope);
    assert.deepEqual(after.account, before.account);
    assert.deepEqual(after.state, before.state, "rolled-back blocker/empty retry must not persist a state mutation");
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.failures, before.failures);
    await resumeScope(root, scope);
    session.close();
  }
});

test("a first projection pause creates only the minimum account and paused generation", async () => {
  const root = await init("rednote-first-projection-pause-");
  const scope = makeScope("first-projection-pause");
  let triggered = false;
  const account = { schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, displayName: "First Account", firstSeenAt: "2026-02-01T00:00:00.000Z", lastSeenAt: stage3bNow };
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["new-note"])], [], "fixture", "first.json", account);
  const result = await new SyncEngine({
    root, scope, session, clock, minimumIntervalMs: 0,
    projectionBoundaryObserver: async (point) => {
      if (!triggered && point.projectorId === "notes" && point.phase === "before_projector") { triggered = true; await requestScopePause(root, scope); }
    },
  }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 7);
  const after = await stateAt(root, scope);
  assert.deepEqual(after.account, account);
  assert.equal(after.state, null);
  assert.deepEqual(after.tasks, []);
  assert.deepEqual(after.failures, []);
  assert.equal((await generationAt(root))?.canonicalGeneration, 1);
  await resumeScope(root, scope);
  session.close();
});

test("runPage persists list AUTH/RATE/PROTOCOL stops, preserves progress, and never calls detail", async () => {
  for (const [category, exitCode] of [["AUTH_REQUIRED", 3], ["RATE_LIMITED", 4], ["PROTOCOL", 5]] as const) {
    const root = await init(`rednote-list-${category.toLowerCase()}-`);
    const scope = makeScope(`list-${category.toLowerCase()}`);
    const retryAt = category === "RATE_LIMITED" ? "2026-03-01T01:00:00.000Z" : null;
    const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [], { listFailure: fixtureFailure(category, retryAt) })]);
    const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    assert.equal(result.exitCode, exitCode);
    assert.deepEqual(session.usage(), { listCalls: 1, detailCalls: 0, retryCalls: 0 });
    const snapshot = await stateAt(root, scope);
    assert.deepEqual(snapshot.state?.progress, initialProgress());
    assert.equal(snapshot.state?.stopReason, category);
    assert.equal(snapshot.state?.nextAllowedAt, retryAt);
    assert.equal(snapshot.runs.at(-1)?.safeErrorCategory, category);
    session.close();
  }
});

test("detail blocker keeps the full progress tuple while committing earlier success and failure view", async () => {
  const root = await init("rednote-detail-blocker-");
  const scope = makeScope("detail-blocker");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["done-first", "fails-second"], {
    nextCursor: "response-cursor", hasMore: true,
    details: [fixtureDetail(scope, "done-first"), { noteId: "fails-second", failure: fixtureFailure("DETAIL") }],
  })]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 5);
  const snapshot = await stateAt(root, scope);
  assert.deepEqual(snapshot.state?.progress, initialProgress());
  assert.equal(snapshot.tasks.find((task) => task.noteId === "done-first")?.status, "done");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "fails-second")?.status, "failed");
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.failures[0]?.category, "DETAIL");
  session.close();
});

test("media partial advances a successful page, persists a ranked failure, and exits 9", async () => {
  const root = await init("rednote-media-partial-");
  const scope = makeScope("media-partial");
  const detail = fixtureDetail(scope, "partial-note", { media: [{ kind: "image", ordinal: 1, mediaId: "media-one", failure: fixtureFailure("MEDIA") }] });
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["partial-note"], { details: [detail] })]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 9);
  const snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.phase, "head");
  assert.equal(snapshot.tasks[0]?.status, "partial");
  assert.equal(snapshot.failures[0]?.category, "MEDIA");
  assert.notEqual(snapshot.failures[0]?.sourceRank, null);
  session.close();
});

test("head and catchup persist one page per run through a third-page frontier", async () => {
  const root = await init("rednote-head-catchup-");
  const scope = makeScope("head-catchup");
  const pages = [
    fixturePage(scope, null, ["old"]),
    fixturePage(scope, null, ["new-1"], { hasMore: true, nextCursor: "cursor-1" }),
    fixturePage(scope, "cursor-1", ["new-2"], { hasMore: true, nextCursor: "cursor-2" }),
    fixturePage(scope, "cursor-2", ["old"], { hasMore: true, nextCursor: "cursor-3" }),
  ];
  for (let index = 0; index < pages.length; index += 1) {
    const session = await openStage3bFixture(root, scope, [pages[index]!], [], "fixture", `page-${index}.json`);
    await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    assert.equal(session.usage().listCalls, 1);
    session.close();
  }
  const snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.phase, "head");
  assert.deepEqual(snapshot.state?.progress.headFrontier, [decodeNoteId("new-1")]);
  assert.equal(snapshot.tasks.filter((task) => task.status === "done").length, 3);
});

test("a pinned old item plus new items enters service_end catchup and empty continuation advances only by response cursor", async () => {
  const root = await init("rednote-pinned-");
  const scope = makeScope("pinned");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["old"])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["old", "new"], { hasMore: true, nextCursor: "cursor-a" })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  let snapshot = await stateAt(root, scope);
  assert.deepEqual(snapshot.state?.progress.catchupStop, { kind: "service_end" });
  session = await openStage3bFixture(root, scope, [fixturePage(scope, "cursor-a", [], { hasMore: true, nextCursor: "cursor-b" })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.cursor, "cursor-b");
  assert.deepEqual(snapshot.state?.progress.pendingHeadFrontier, [decodeNoteId("old"), decodeNoteId("new")]);
});

test("retry uses only explicit retry source, preserves progress, and repairs a detail failure", async () => {
  const root = await init("rednote-retry-");
  const scope = makeScope("retry");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["retry-note"], { details: [{ noteId: "retry-note", failure: fixtureFailure("DETAIL") }] })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const before = (await stateAt(root, scope)).state!.progress;
  session = await openStage3bFixture(root, scope, [], [{ scope, noteId: "retry-note", detail: fixtureDetail(scope, "retry-note", { body: "repaired" }) }]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).retryFailures(new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(session.usage(), { listCalls: 0, detailCalls: 0, retryCalls: 1 });
  const after = await stateAt(root, scope);
  assert.deepEqual(after.state?.progress, before);
  assert.equal(after.tasks[0]?.status, "done");
  assert.equal(after.failures.length, 0);
  session.close();
});

test("retry detail blocker remains exit 5, preserves progress, and increments the same failure", async () => {
  const root = await init("rednote-retry-blocker-");
  const scope = makeScope("retry-blocker");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["retry-note"], { details: [{ noteId: "retry-note", failure: fixtureFailure("DETAIL") }] })]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const before = await stateAt(root, scope);
  session = await openStage3bFixture(root, scope, [], [{ scope, noteId: "retry-note", detail: { failure: fixtureFailure("DETAIL") } }]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).retryFailures(new AbortController().signal);
  assert.equal(result.exitCode, 5);
  const after = await stateAt(root, scope);
  assert.deepEqual(after.state?.progress, before.state?.progress);
  assert.equal(after.failures[0]?.failureId, before.failures[0]?.failureId);
  assert.equal(after.failures[0]?.attemptCount, 2);
  session.close();
});

test("not_due is a zero-client safe run", async () => {
  const root = await init("rednote-not-due-");
  const scope = makeScope("not-due");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [])]);
  await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 600_000 }).runPage(new AbortController().signal); session.close();
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["must-not-list"])]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 600_000 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.equal(result.run.outcome, "not_due");
  assert.equal(session.usage().listCalls, 0);
  session.close();
});

test("a pause requested between items commits completed work but preserves progress", async () => {
  const root = await init("rednote-mid-pause-");
  const scope = makeScope("mid-pause-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["first", "second"], { hasMore: true, nextCursor: "next-page" })]);
  const pausingClock = Object.freeze({ now: () => stage3bNow, async sleep() { await requestScopePause(root, scope); } });
  const result = await new SyncEngine({ root, scope, session, clock: pausingClock, itemDelayMs: 1, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 7);
  const snapshot = await stateAt(root, scope);
  assert.deepEqual(snapshot.state?.progress, initialProgress());
  assert.equal(snapshot.tasks.find((task) => task.noteId === "first")?.status, "done");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "second")?.status, "paused");
  assert.equal(session.usage().detailCalls, 1);
  await resumeScope(root, scope);
  session.close();
});

test("retry limit is exact and unresolved detail work returns exit 5 without listPage", async () => {
  const root = await init("rednote-retry-limit-");
  const scope = makeScope("retry-limit-account");
  for (const noteId of ["alpha", "beta"]) {
    const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [noteId], { details: [{ noteId, failure: fixtureFailure("DETAIL") }] })], [], "fixture", `seed-${noteId}.json`);
    await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    session.close();
  }
  const session = await openStage3bFixture(root, scope, [], [
    { scope, noteId: "alpha", detail: fixtureDetail(scope, "alpha", { body: "fixed alpha" }) },
    { scope, noteId: "beta", detail: fixtureDetail(scope, "beta", { body: "fixed beta" }) },
  ]);
  const result = await new SyncEngine({ root, scope, session, limit: 1, clock, minimumIntervalMs: 0 }).retryFailures(new AbortController().signal);
  assert.equal(result.exitCode, 5);
  assert.deepEqual(session.usage(), { listCalls: 0, detailCalls: 0, retryCalls: 1 });
  assert.equal((await stateAt(root, scope)).failures.length, 1);
  session.close();
});

test("accepted higher-rank media in another target repairs the original target task atomically", async () => {
  const root = await init("rednote-cross-target-engine-");
  const liked = makeScope("cross-target-account", "liked");
  const collected = makeScope("cross-target-account", "collected");
  let detail = fixtureDetail(liked, "shared-note", { media: [{ kind: "image", ordinal: 1, mediaId: "shared-media", failure: fixtureFailure("MEDIA") }] });
  let session = await openStage3bFixture(root, liked, [fixturePage(liked, null, ["shared-note"], { details: [detail] })], [], "fixture", "liked.json");
  assert.equal((await new SyncEngine({ root, scope: liked, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal)).exitCode, 9);
  session.close();
  await writeFile(`${root}/tiny.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  detail = fixtureDetail(collected, "shared-note", { revisionAt: "2026-03-02T00:00:00.000Z", media: [{ kind: "image", ordinal: 1, mediaId: "shared-media", relativePath: "tiny.png" }] });
  session = await openStage3bFixture(root, collected, [fixturePage(collected, null, ["shared-note"], { details: [detail] })], [], "fixture", "collected.json");
  assert.equal((await new SyncEngine({ root, scope: collected, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal)).exitCode, 0);
  session.close();
  const snapshot = await stateAt(root, liked);
  assert.equal(snapshot.failures.length, 0);
  assert.equal(snapshot.tasks.find((task) => task.scope.target === "liked")?.status, "done");
  assert.equal(snapshot.tasks.find((task) => task.scope.target === "collected")?.status, "done");
});

test("album scope persists its board independently from cursor and ordinary account state", async () => {
  const root = await init("rednote-album-engine-");
  const album = makeScope("album-account", "collected_album", "board_with_separator");
  const session = await openStage3bFixture(root, album, [fixturePage(album, null, ["album-note"], { hasMore: true, nextCursor: "server-cursor" })]);
  await new SyncEngine({ root, scope: album, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const snapshot = await stateAt(root, album);
  assert.equal(snapshot.state?.boardId, "board_with_separator");
  assert.equal(snapshot.state?.progress.cursor, "server-cursor");
  assert.notEqual(snapshot.state?.boardId, snapshot.state?.progress.cursor);
});

test("AbortSignal at the item pacing boundary commits a paused run and leaves progress unchanged", async () => {
  const root = await init("rednote-abort-boundary-");
  const scope = makeScope("abort-boundary-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["first", "second"], { hasMore: true, nextCursor: "next-page" })]);
  const controller = new AbortController();
  const abortingClock = Object.freeze({ now: () => stage3bNow, async sleep() { controller.abort(); throw new Error("interrupted"); } });
  const result = await new SyncEngine({ root, scope, session, clock: abortingClock, itemDelayMs: 1, minimumIntervalMs: 0 }).runPage(controller.signal);
  assert.equal(result.exitCode, 7);
  const snapshot = await stateAt(root, scope);
  assert.deepEqual(snapshot.state?.progress, initialProgress());
  assert.equal(snapshot.tasks.find((task) => task.noteId === "first")?.status, "done");
  session.close();
});

test("detail AUTH failure persists the exact stop and retry media failure remains exit 9", async () => {
  const root = await init("rednote-detail-auth-");
  const scope = makeScope("detail-auth-account");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["auth-note"], { details: [{ noteId: "auth-note", failure: fixtureFailure("AUTH_REQUIRED") }] })]);
  let result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 3);
  assert.equal((await stateAt(root, scope)).state?.stopReason, "AUTH_REQUIRED");
  session.close();
  const { acknowledgeStop } = await import("../src/commands.ts");
  await acknowledgeStop(root, scope, "AUTH_REQUIRED", clock);
  session = await openStage3bFixture(root, scope, [], [{ scope, noteId: "auth-note", detail: fixtureDetail(scope, "auth-note", { media: [{ kind: "image", ordinal: 1, mediaId: "media", failure: fixtureFailure("MEDIA") }] }) }]);
  result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).retryFailures(new AbortController().signal);
  assert.equal(result.exitCode, 9);
  assert.equal((await stateAt(root, scope)).failures.some((failure) => failure.category === "MEDIA"), true);
  session.close();
});

test("list NETWORK applies minimum pacing and the immediate not_due run is a true zero mutation", async () => {
  const root = await init("rednote-network-pacing-");
  const scope = makeScope("network-pacing-account");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [], { listFailure: fixtureFailure("NETWORK") })]);
  const first = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 600_000 }).runPage(new AbortController().signal);
  assert.equal(first.exitCode, 5);
  session.close();
  const before = await stateAt(root, scope);
  const beforeStore = await SqliteStateStore.openReadOnly(root);
  const beforeSnapshot = beforeStore.openReadSnapshot();
  const beforeGeneration = [...beforeSnapshot.enumerateAccountsWithGenerations()][0];
  beforeSnapshot.close(); beforeStore.close();
  assert.equal(before.state?.nextAllowedAt, "2026-03-01T00:10:00.000Z");
  const changedAccount = { schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, displayName: "Changed Name", firstSeenAt: stage3bNow, lastSeenAt: "2026-03-03T00:00:00.000Z" };
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["must-not-list"])], [], "fixture", "not-due.json", changedAccount);
  const second = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 600_000 }).runPage(new AbortController().signal);
  assert.equal(second.run.outcome, "not_due");
  assert.equal(session.usage().listCalls, 0);
  const after = await stateAt(root, scope);
  assert.equal(after.runs.length, before.runs.length);
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const persisted = new SqliteAccountStore().load(snapshot, scope.hostId, scope.accountId);
  assert.equal(persisted?.displayName, "Synthetic");
  assert.equal(persisted?.lastSeenAt, stage3bNow);
  assert.deepEqual([...snapshot.enumerateAccountsWithGenerations()][0], beforeGeneration);
  snapshot.close(); store.close(); session.close();
});

test("detail EXPORT is a persistence blocker with exit 6", async () => {
  const root = await init("rednote-export-blocker-");
  const scope = makeScope("export-blocker-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["note"], { details: [{ noteId: "note", failure: fixtureFailure("EXPORT") }] })]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 6);
  assert.equal(result.run.safeErrorCategory, "EXPORT");
  assert.deepEqual((await stateAt(root, scope)).state?.progress, initialProgress());
  session.close();
});

test("a full limit head page with more new items enters catchup without dropping the next page", async () => {
  const root = await init("rednote-full-limit-");
  const scope = makeScope("full-limit-account");
  let session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["old"])]);
  await new SyncEngine({ root, scope, session, limit: 2, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["newa", "newb"], { hasMore: true, nextCursor: "next-full" })]);
  await new SyncEngine({ root, scope, session, limit: 2, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  assert.equal((await stateAt(root, scope)).state?.progress.phase, "catchup");
  session = await openStage3bFixture(root, scope, [fixturePage(scope, "next-full", ["newc", "old"], { hasMore: false })]);
  await new SyncEngine({ root, scope, session, limit: 2, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal); session.close();
  const final = await stateAt(root, scope);
  assert.equal(final.state?.progress.phase, "head");
  assert.equal(final.tasks.filter((task) => task.status === "done").length, 4);
});

test("the same raw account and note ids stay isolated across both reviewed hosts", async () => {
  const root = await init("rednote-dual-host-");
  const xhs = makeScope("shared-account");
  const rednote = decodePartitionScope({ hostId: "rednote", accountId: "shared-account", target: "liked", boardId: null });
  for (const scope of [xhs, rednote]) {
    const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["shared-note"])]);
    await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    session.close();
  }
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const generations = [...snapshot.enumerateAccountsWithGenerations()];
  assert.equal(generations.length, 2);
  const xhsManifest = snapshot.loadManifest(accountPartition(xhs), decodeNoteId("shared-note"));
  const rednoteManifest = snapshot.loadManifest(accountPartition(rednote), decodeNoteId("shared-note"));
  assert.equal(xhsManifest?.canonicalNote.publicUrl, "https://www.xiaohongshu.com/explore/shared-note");
  assert.equal(rednoteManifest?.canonicalNote.publicUrl, "https://www.rednote.com/explore/shared-note");
  assert.notEqual(accountKey(accountPartition(xhs)), accountKey(accountPartition(rednote)));
  snapshot.close(); store.close();
});
