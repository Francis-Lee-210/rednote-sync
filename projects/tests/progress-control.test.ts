import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, readFile } from "node:fs/promises";
import { isScopePaused, requestScopePause, resumeScope } from "../src/control.ts";
import { transitionSyncProgress } from "../src/progress.ts";
import { decodeNoteId, decodeServerCursor, initialProgress, scopeKey } from "../src/types.ts";
import { makeScope, tempRoot } from "./helpers.ts";

const n = (id: string) => decodeNoteId(id);
const c = (id: string) => decodeServerCursor(id);

test("pause control uses only scope digest and exact no-follow record", async () => {
  const root = await tempRoot("rednote-control-");
  await chmod(root, 0o700);
  const scope = makeScope("raw-account-id");
  await requestScopePause(root, scope);
  assert.equal(await isScopePaused(root, scope), true);
  const target = `${root}/control/${scopeKey(scope)}.pause`;
  assert.doesNotMatch(target, /raw-account-id/);
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { schemaVersion: 1, scope });
  await requestScopePause(root, scope);
  await resumeScope(root, scope);
  assert.equal(await isScopePaused(root, scope), false);
});

test("backfill response cursor is independent from note id and reaches head", () => {
  const first = transitionSyncProgress(initialProgress(), { requestCursor: null, nextCursor: c("cursor-1"), hasMore: true, noteIds: [n("note-1")], newNoteIds: [n("note-1")] });
  assert.equal(first.cursor, "cursor-1");
  assert.notEqual(first.cursor, first.headFrontier[0]);
  const end = transitionSyncProgress(first, { requestCursor: c("cursor-1"), nextCursor: null, hasMore: false, noteIds: [], newNoteIds: [] });
  assert.deepEqual(end, { phase: "head", cursor: null, cursorSource: null, reachedEnd: true, headFrontier: [n("note-1")], catchupStop: null, pendingHeadFrontier: [] });
});

test("head pinned frontier plus new page uses service_end catchup", () => {
  const head = Object.freeze({ phase: "head" as const, cursor: null, cursorSource: null, reachedEnd: true, headFrontier: Object.freeze([n("old")]), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
  const next = transitionSyncProgress(head, { requestCursor: null, nextCursor: c("response-cursor"), hasMore: true, noteIds: [n("old"), n("new")], newNoteIds: [n("new")] });
  assert.equal(next.phase, "catchup");
  assert.deepEqual(next.catchupStop, { kind: "service_end" });
  assert.deepEqual(next.pendingHeadFrontier, [n("old"), n("new")]);
});

test("head new page without old frontier uses frontier stop and continues independently of content", () => {
  const head = Object.freeze({ phase: "head" as const, cursor: null, cursorSource: null, reachedEnd: true, headFrontier: Object.freeze([n("old")]), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
  const next = transitionSyncProgress(head, { requestCursor: null, nextCursor: c("next"), hasMore: true, noteIds: [n("new")], newNoteIds: [n("new")] });
  assert.deepEqual(next.catchupStop, { kind: "frontier", noteIds: [n("old")] });
  const continued = transitionSyncProgress(next, { requestCursor: c("next"), nextCursor: c("later"), hasMore: true, noteIds: [n("later")], newNoteIds: [n("later")] });
  assert.equal(continued.cursor, "later");
});

test("head empty frontier conservatively catches up and missing frontier ends at service end", () => {
  const emptyHead = Object.freeze({ phase: "head" as const, cursor: null, cursorSource: null, reachedEnd: true, headFrontier: Object.freeze([]), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
  const catchup = transitionSyncProgress(emptyHead, { requestCursor: null, nextCursor: c("next"), hasMore: true, noteIds: [], newNoteIds: [] });
  assert.deepEqual(catchup.catchupStop, { kind: "service_end" });
  assert.deepEqual(transitionSyncProgress(catchup, { requestCursor: c("next"), nextCursor: null, hasMore: false, noteIds: [], newNoteIds: [] }), emptyHead);
});

test("continued page rejects missing or repeated response cursor", () => {
  assert.throws(() => transitionSyncProgress(initialProgress(), { requestCursor: null, nextCursor: null, hasMore: true, noteIds: [], newNoteIds: [] }));
  assert.throws(() => transitionSyncProgress(initialProgress(), { requestCursor: c("same"), nextCursor: c("same"), hasMore: true, noteIds: [], newNoteIds: [] }));
});
