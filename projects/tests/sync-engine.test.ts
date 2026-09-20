import test from "node:test";
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { FixtureSession, OfflineAdapterError } from "../src/offline-input.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { createValidatedNoteRank } from "../src/rank.ts";
import { computeContentHash } from "../src/merge.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { accountPartition, decodeAccountId, decodeIsoDateTime, decodeNoteId } from "../src/types.ts";
import { makeAccount, makeNote, makeScope, tempRoot, time1, time2 } from "./helpers.ts";

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
  assert.ok(generation.canonicalGeneration > 0);
  assert.equal(generation.viewsDirty, false);
  snapshot.close(); store.close();
});

test("repeated observations retain content and record every capture attempt", async () => {
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
  assert.equal(snapshot.loadManifest(accountPartition(scope), decodeNoteId("noteA"))?.canonicalNote.body, "offline body");
  assert.equal(snapshot.loadTask(scope, decodeNoteId("noteA"))?.attemptCount, 2);
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
  assert.ok(generation.canonicalGeneration > 0);
  assert.equal(generation.viewsDirty, false);
  assert.equal([...snapshot.enumerateRuns(accountPartition(scope))].length, 1);
  snapshot.close(); store.close();
  session.close();
});

function transient(note: import("../src/types.ts").Note, mediaSources: import("../src/offline-input.ts").TransientNote["mediaSources"] = []): import("../src/offline-input.ts").TransientNote {
  const { media: _media, contentHash: _contentHash, ...semantic } = note;
  return { note: semantic, semanticNote: note, sourceRank: createValidatedNoteRank(note, null), mediaSetComplete: true, mediaSources };
}

function singleSource(scope: ReturnType<typeof makeScope>, result: import("../src/offline-input.ts").TransientNote): import("../src/offline-input.ts").SyncSource {
  const partition = accountPartition(scope);
  return {
    account: makeAccount(scope.accountId),
    client: {
      account: partition,
      async listPage() { return { scope, requestCursor: null, nextCursor: null, hasMore: false, items: [{ noteId: result.note.noteId }] }; },
      async getDetail() { return result; },
    },
  };
}

test("injected sources collect detail and stream media while another writer can acquire the database", async () => {
  const root = await tempRoot("rednote-source-injection-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("source-owner");
  let writerChecks = 0;
  const checkWriter = async () => {
    const independent = await SqliteStateStore.open(root);
    try {
      const tx = independent.beginImmediate({ command: "sync", scope });
      independent.rollback(tx);
      writerChecks += 1;
    } finally { independent.close(); }
  };
  const detail = transient(makeNote(scope.accountId, "note"), [{
    mediaId: "image-one", slot: { kind: "image", ordinal: 1 }, suggestedMimeType: null,
    async open() {
      await checkWriter();
      return new ReadableStream({ start(controller) { controller.enqueue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); controller.close(); } });
    },
  }]);
  const source = singleSource(scope, detail);
  source.client.getDetail = async () => { await checkWriter(); return detail; };
  const result = await new SyncEngine({ root, scope, source, clock }).runAll(new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.equal(writerChecks, 2);
  assert.equal(result.run.done, 1);
});

test("sync accepts newer observations and replaying an older capture preserves the newer body, tags, and metrics", async () => {
  const root = await tempRoot("rednote-observation-order-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("observation-owner");
  const old = { ...makeNote(scope.accountId, "note", time1, "old body"), tags: ["removed"], metrics: { liked: 90, collected: 8, commented: 7, shared: 1 } };
  const newer = { ...makeNote(scope.accountId, "note", time2, "new body"), tags: ["current"], metrics: { liked: 5, collected: 2, commented: 1, shared: 0 } };
  for (const note of [old, newer, old]) {
    const valid = { ...note, contentHash: computeContentHash(note) };
    const result = await new SyncEngine({ root, scope, source: singleSource(scope, transient(valid)), clock }).runAll(new AbortController().signal);
    assert.equal(result.exitCode, 0);
  }
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  try {
    const note = snapshot.loadManifest(accountPartition(scope), decodeNoteId("note"))!.canonicalNote;
    assert.equal(note.body, "new body");
    assert.deepEqual(note.tags, ["current"]);
    assert.equal(note.metrics.liked, 5);
    const task = snapshot.loadTask(scope, decodeNoteId("note"))!;
    assert.equal(task.attempts?.length, 3);
    assert.deepEqual(task.attempts?.map((attempt) => attempt.collector), [null, null, null]);
  } finally { snapshot.close(); store.close(); }
});

test("a secondary collector can fill owner relationships and the owner retry fetches only missing media", async () => {
  const root = await tempRoot("rednote-collector-retry-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("main-owner");
  const owner = accountPartition(scope);
  const secondary = { ...owner, accountId: decodeAccountId("secondary-collector") };
  let firstMediaReads = 0;
  let secondMediaReads = 0;
  const media = (ordinal: number, open: () => Promise<ReadableStream<Uint8Array>>) => ({ mediaId: `media-${ordinal}`, slot: { kind: "image" as const, ordinal }, suggestedMimeType: null, open });
  const bytes = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); controller.close(); } });
  const note = makeNote(scope.accountId, "note");
  const initial = transient(note, [
    media(1, async () => { firstMediaReads += 1; return bytes(); }),
    media(2, async () => { throw new OfflineAdapterError("MEDIA", null); }),
  ]);
  const firstSource = { ...singleSource(scope, initial), listCollector: owner, contentCollector: secondary };
  assert.equal((await new SyncEngine({ root, scope, source: firstSource, clock }).runAll(new AbortController().signal)).exitCode, 9);
  const repaired = transient(note, [
    media(1, async () => { throw new Error("already stored media must not be fetched again"); }),
    media(2, async () => { secondMediaReads += 1; return bytes(); }),
  ]);
  const retrySource = { ...singleSource(scope, repaired), contentCollector: owner };
  retrySource.client.listPage = async () => { throw new Error("retry must not list"); };
  retrySource.client.getDetail = async (_scope, _id, needed) => {
    assert.equal(needed?.detail, false);
    assert.deepEqual(needed?.mediaSlots, [{ kind: "image", ordinal: 2 }]);
    return repaired;
  };
  const retried = await new SyncEngine({ root, scope, source: retrySource, clock }).retryFailures(new AbortController().signal);
  assert.equal(retried.exitCode, 0);
  assert.equal(firstMediaReads, 1);
  assert.equal(secondMediaReads, 1);
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  try {
    const task = snapshot.loadTask(scope, decodeNoteId("note"))!;
    assert.equal(task.status, "done");
    assert.deepEqual(task.listCollector, owner);
    assert.deepEqual(task.attempts?.map((attempt) => [attempt.collector, attempt.outcome]), [[secondary, "partial"], [owner, "done"]]);
    assert.equal(snapshot.loadManifest(owner, decodeNoteId("note"))?.canonicalNote.accountId, owner.accountId);
    assert.equal([...snapshot.enumerateUnresolvedFailures(owner)].length, 0);
  } finally { snapshot.close(); store.close(); }
});

test("a listed refresh stays pending across a pause and resumes before moving on", async () => {
  const root = await tempRoot("rednote-refresh-resume-");
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope("refresh-owner");
  await new SyncEngine({ root, scope, source: singleSource(scope, transient(makeNote(scope.accountId, "note", time1, "old"))), clock }).runAll(new AbortController().signal);
  const fresh = transient(makeNote(scope.accountId, "note", time2, "fresh"));
  const source = singleSource(scope, fresh);
  const controller = new AbortController();
  const list = source.client.listPage;
  source.client.listPage = async (...args) => { const page = await list(...args); controller.abort(); return page; };
  const paused = await new SyncEngine({ root, scope, source, clock }).runAll(controller.signal);
  assert.equal(paused.exitCode, 7);
  let store = await SqliteStateStore.openReadOnly(root);
  let snapshot = store.openReadSnapshot();
  try {
    assert.equal(snapshot.loadTask(scope, decodeNoteId("note"))?.status, "pending");
    assert.equal(snapshot.loadManifest(accountPartition(scope), decodeNoteId("note"))?.canonicalNote.body, "old");
  } finally { snapshot.close(); store.close(); }
  const resumed = await new SyncEngine({ root, scope, source: singleSource(scope, fresh), clock }).runAll(new AbortController().signal);
  assert.equal(resumed.exitCode, 0);
  store = await SqliteStateStore.openReadOnly(root);
  snapshot = store.openReadSnapshot();
  try {
    assert.equal(snapshot.loadManifest(accountPartition(scope), decodeNoteId("note"))?.canonicalNote.body, "fresh");
    assert.equal(snapshot.loadTask(scope, decodeNoteId("note"))?.attempts?.length, 2);
    assert.equal(snapshot.loadTask(scope, decodeNoteId("note"))?.status, "done");
  } finally { snapshot.close(); store.close(); }
});
