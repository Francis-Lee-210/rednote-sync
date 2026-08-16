import test from "node:test";
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { FixtureSession } from "../src/offline-input.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { accountPartition, decodeAccountId, decodeIsoDateTime, decodeNoteId } from "../src/types.ts";
import { makeScope, tempRoot } from "./helpers.ts";

const now = decodeIsoDateTime("2026-02-01T00:00:00.000Z");
const clock = Object.freeze({ now: () => now, sleep: async () => {} });

function account(id: string) {
  return { schemaVersion: 1, hostId: "xhs", accountId: id, displayName: "Synthetic", firstSeenAt: now, lastSeenAt: now };
}

function detail(scope: ReturnType<typeof makeScope>, noteId: string) {
  return {
    note: {
      schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, noteId,
      publicUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      title: "Synthetic", body: "offline body", noteType: "text",
      author: { id: "author", name: "Author", publicUrl: null },
      publishedAt: now, updatedAt: now, capturedAt: now, tags: ["offline"],
      metrics: { liked: 1, collected: 0, commented: 0, shared: 0 },
      memberships: [{ target: scope.target, boardId: scope.boardId, boardName: null, observedAt: now }],
    },
    revisionAt: now, claimedPayloadSha256: null, mediaSetComplete: true, media: [],
  };
}

async function fixture(root: string, scope: ReturnType<typeof makeScope>, items: string[], hasMore = false, nextCursor: string | null = null): Promise<FixtureSession> {
  const inputFile = "fixture.json";
  await writeFile(`${root}/${inputFile}`, JSON.stringify({
    schemaVersion: 1,
    mode: "fixture",
    account: account(scope.accountId),
    pages: [{ scope, requestCursor: null, nextCursor, hasMore, items: items.map((noteId) => ({ noteId })), details: items.map((noteId) => detail(scope, noteId)) }],
    retryItems: [],
  }));
  return FixtureSession.open({ inputRoot: await realpath(root), inputFile, mode: "fixture", account: accountPartition(scope) });
}

test("runPage executes one page through canonical plan, projections, finalization, and commit", async () => {
  const root = await tempRoot("rednote-engine-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("engine-account");
  const session = await fixture(root, scope, ["noteA"]);
  const result = await new SyncEngine({ root, scope, session, limit: 5, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  session.close();
  assert.equal(result.exitCode, 0);
  assert.equal(result.run.listed, 1);
  assert.equal(result.run.done, 1);
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const state = snapshot.loadState(scope)!;
  assert.equal(state.progress.phase, "head");
  assert.deepEqual(state.progress.headFrontier, [decodeNoteId("noteA")]);
  assert.equal(snapshot.loadTask(scope, decodeNoteId("noteA"))?.status, "done");
  assert.equal(snapshot.loadManifest(accountPartition(scope), decodeNoteId("noteA"))?.canonicalNote.body, "offline body");
  const generation = [...snapshot.enumerateAccountsWithGenerations()][0]!;
  assert.equal(generation.canonicalGeneration, 1);
  assert.equal(generation.viewsDirty, false);
  snapshot.close(); store.close();
});

test("terminal duplicate is verified and committed without a second detail mutation", async () => {
  const root = await tempRoot("rednote-engine-duplicate-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("engine-duplicate");
  const first = await fixture(root, scope, ["noteA"]);
  await new SyncEngine({ root, scope, session: first, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  first.close();
  const second = await fixture(root, scope, ["noteA"]);
  const result = await new SyncEngine({ root, scope, session: second, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  second.close();
  assert.equal(result.exitCode, 0);
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  assert.equal(snapshot.loadManifest(accountPartition(scope), decodeNoteId("noteA"))?.revision, 1);
  assert.equal(snapshot.loadTask(scope, decodeNoteId("noteA"))?.attemptCount, 1);
  assert.equal([...snapshot.enumerateRuns(accountPartition(scope))].length, 2);
  snapshot.close(); store.close();
});

test("pre-existing pause commits a paused run without calling listPage", async () => {
  const root = await tempRoot("rednote-engine-pause-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("engine-pause");
  const session = await fixture(root, scope, []);
  const { requestScopePause } = await import("../src/control.ts");
  await requestScopePause(root, scope);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 7);
  assert.equal(result.run.outcome, "paused");
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  assert.equal(snapshot.loadState(scope), null, "first pause initializes no sync state");
  const generation = [...snapshot.enumerateAccountsWithGenerations()][0]!;
  assert.equal(generation.canonicalGeneration, 1, "first pause creates only the account and its paused projection generation");
  assert.equal(generation.viewsDirty, false);
  assert.equal([...snapshot.enumerateRuns(accountPartition(scope))].length, 1);
  snapshot.close(); store.close();
  session.close();
});
