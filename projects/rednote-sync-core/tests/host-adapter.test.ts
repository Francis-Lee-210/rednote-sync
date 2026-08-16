import assert from "node:assert/strict";
import test from "node:test";
import { getHostAdapter } from "../src/host-adapter.ts";
import { decodeNoteId } from "../src/types.ts";

test("HostAdapter rebuilds canonical note URLs for both reviewed static hosts", () => {
  const noteId = decodeNoteId("笔记 id");
  const xhs = getHostAdapter("xhs");
  assert.equal(xhs.webOrigin, "https://www.xiaohongshu.com");
  assert.equal(xhs.parseNoteId("笔记 id"), noteId);
  assert.equal(xhs.parseBoardId("board"), "board");
  assert.equal(xhs.publicNoteUrl(noteId), "https://www.xiaohongshu.com/explore/%E7%AC%94%E8%AE%B0%20id");
  assert.equal(getHostAdapter("rednote").publicNoteUrl(noteId), "https://www.rednote.com/explore/%E7%AC%94%E8%AE%B0%20id");
});

test("HostAdapter rejects similar origins, ports, credentials, query, fragment, and mismatched note ids", () => {
  const adapter = getHostAdapter("xhs");
  const noteId = decodeNoteId("note");
  for (const value of [
    "http://www.xiaohongshu.com/explore/note",
    "https://xiaohongshu.com/explore/note",
    "https://www.xiaohongshu.com.evil.invalid/explore/note",
    "https://www.xiaohongshu.com:444/explore/note",
    "https://user@www.xiaohongshu.com/explore/note",
    "https://www.xiaohongshu.com/explore/note?token=blocked",
    "https://www.xiaohongshu.com/explore/note#fragment",
    "https://www.xiaohongshu.com/explore/other",
  ]) assert.throws(() => adapter.sanitizeImportedNoteUrl(value, noteId));
});

test("HostAdapter normalizes safe author URLs and rejects tokenized/cross-host author URLs", () => {
  const adapter = getHostAdapter("rednote");
  assert.equal(adapter.sanitizeImportedAuthorUrl("https://www.rednote.com/user/%E7%94%A8%E6%88%B7"), "https://www.rednote.com/user/%E7%94%A8%E6%88%B7");
  assert.equal(adapter.sanitizeImportedAuthorUrl(null), null);
  assert.throws(() => adapter.sanitizeImportedAuthorUrl("https://www.rednote.com/user/a?token=blocked"));
  assert.throws(() => adapter.sanitizeImportedAuthorUrl("https://www.xiaohongshu.com/user/a"));
});
