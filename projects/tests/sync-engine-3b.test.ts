import assert from "node:assert/strict";
import test from "node:test";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { requestScopePause, resumeScope } from "../src/control.ts";
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

test("a pause during export retains committed notes and finishes their derived views", async () => {
  const root = await init("rednote-export-pause-");
  const scope = makeScope("export-pause");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["saved-note"])]);
  const controller = new AbortController();
  let interrupted = false;
  const result = await new SyncEngine({
    root, scope, session, clock,
    projectionBoundaryObserver: async (point) => {
      if (interrupted || point.projectorId !== "notes" || point.phase !== "after_stable_file") return;
      interrupted = true;
      controller.abort();
      await requestScopePause(root, scope);
    },
  }).runAll(controller.signal);
  assert.equal(interrupted, true);
  assert.equal(result.exitCode, 0);
  assert.equal((await stateAt(root, scope)).tasks[0]?.status, "done");
  const partition = accountPartition(scope);
  const digest = noteKey(partition, decodeNoteId("saved-note"));
  await access(path.join(root, "accounts", accountKey(partition), "notes", `${digest}.md`));
  await access(path.join(root, "accounts", accountKey(partition), "data", "notes", `${digest}.json`));
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

test("one failed detail preserves its retry task and does not block later items or the list cursor", async () => {
  const root = await init("rednote-detail-blocker-");
  const scope = makeScope("detail-blocker");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["done-first", "fails-second", "done-third"], {
    nextCursor: "response-cursor", hasMore: true,
    details: [fixtureDetail(scope, "done-first"), { noteId: "fails-second", failure: fixtureFailure("DETAIL") }, fixtureDetail(scope, "done-third")],
  })]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 5);
  const snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.cursor, "response-cursor");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "done-first")?.status, "done");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "fails-second")?.status, "failed");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "done-third")?.status, "done");
  assert.equal(session.usage().detailCalls, 3);
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

test("a pause requested between items retains completed work and pending tasks behind the saved cursor", async () => {
  const root = await init("rednote-mid-pause-");
  const scope = makeScope("mid-pause-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["first", "second"], { hasMore: true, nextCursor: "next-page" })]);
  const pausingClock = Object.freeze({ now: () => stage3bNow, async sleep() { await requestScopePause(root, scope); } });
  const result = await new SyncEngine({ root, scope, session, clock: pausingClock, itemDelayMs: 1, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 7);
  const snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.cursor, "next-page");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "first")?.status, "done");
  assert.equal(snapshot.tasks.find((task) => task.noteId === "second")?.status, "pending");
  assert.equal(session.usage().detailCalls, 1);
  await resumeScope(root, scope);
  session.close();
  const resumed = await openStage3bFixture(root, scope, [fixturePage(scope, "next-page", ["third"])], [{ scope, noteId: "second", detail: fixtureDetail(scope, "second") }]);
  const completed = await new SyncEngine({ root, scope, session: resumed, clock }).runAll(new AbortController().signal);
  assert.equal(completed.exitCode, 0);
  const final = await stateAt(root, scope);
  assert.deepEqual(final.tasks.map((task) => [task.noteId, task.status]).sort((a, b) => a[0]!.localeCompare(b[0]!)), [["first", "done"], ["second", "done"], ["third", "done"]]);
  assert.equal(final.tasks.find((task) => task.noteId === "first")?.attempts?.length, 1);
  assert.equal(final.state?.progress.reachedEnd, true);
  resumed.close();
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

test("AbortSignal at the item pacing boundary retains the accepted list checkpoint", async () => {
  const root = await init("rednote-abort-boundary-");
  const scope = makeScope("abort-boundary-account");
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["first", "second"], { hasMore: true, nextCursor: "next-page" })]);
  const controller = new AbortController();
  const abortingClock = Object.freeze({ now: () => stage3bNow, async sleep() { controller.abort(); throw new Error("interrupted"); } });
  const result = await new SyncEngine({ root, scope, session, clock: abortingClock, itemDelayMs: 1, minimumIntervalMs: 0 }).runPage(controller.signal);
  assert.equal(result.exitCode, 7);
  const snapshot = await stateAt(root, scope);
  assert.equal(snapshot.state?.progress.cursor, "next-page");
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
  assert.equal((await stateAt(root, scope)).state?.progress.reachedEnd, true);
  assert.equal((await stateAt(root, scope)).tasks[0]?.status, "failed");
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

test("each list request records its actual collector including a failed continuation", async () => {
  const root = await init("rednote-list-provenance-");
  const scope = makeScope("list-owner");
  const owner = accountPartition(scope);
  const secondary = { ...owner, accountId: "secondary" };
  const pages = [
    { ...(fixturePage(scope, null, [], { hasMore: true, nextCursor: "next" }) as Record<string, unknown>), listCollector: owner },
    { ...(fixturePage(scope, "next", [], { listFailure: fixtureFailure("AUTH_REQUIRED") }) as Record<string, unknown>), listCollector: secondary },
  ];
  const session = await openStage3bFixture(root, scope, pages);
  const result = await new SyncEngine({ root, scope, session, clock }).runAll(new AbortController().signal);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.run.listAttempts?.map((attempt) => [attempt.collector, attempt.outcome, attempt.category]), [[owner, "done", null], [secondary, "failed", "AUTH_REQUIRED"]]);
  assert.deepEqual((await stateAt(root, scope)).runs.at(-1)?.listAttempts, result.run.listAttempts);
  session.close();
});
