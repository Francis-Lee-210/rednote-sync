import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  FileContentAddressedObjectStore,
  FileMediaStore,
  SafeError,
  bytesIterable,
  canResolveMediaFailure,
  compareSourceRank,
  computeContentHash,
  createValidatedSourceRank,
  createValidatedNoteRank,
  detectMagicType,
  decodeIsoDateTime,
  decodeSha256,
  mergeAccount,
  mergeCanonicalNote,
  mergeFailure,
  sha256Bytes,
  type FailureRecord,
  type Media,
  type Note,
  type NoteManifest,
} from "../src/index.ts";
import { makeAccount, makeNote, makeScope, tempRoot, time1, time2 } from "./helpers.ts";

function shellManifest(result: ReturnType<typeof mergeCanonicalNote>): NoteManifest {
  const zero = { sha256: decodeSha256("0".repeat(64)), byteLength: 0, mimeType: "application/octet-stream" };
  return { schemaVersion: 1, revision: 1, accountId: result.note.accountId, hostId: result.note.hostId, noteId: result.note.noteId, canonicalNote: result.note, semanticSourceRank: result.sourceRank, membershipNameObservations: result.membershipNameObservations, mediaSlots: result.mediaSlots, artifacts: { json: zero, markdown: zero }, indexEntrySha256: zero.sha256, csvRowSha256: zero.sha256 };
}

test("object store is immutable, no-clobber, and MIME derives only from magic bytes", async () => {
  const root = await tempRoot();
  try {
    const store = new FileContentAddressedObjectStore(root);
    const signal = new AbortController().signal;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const first = await store.put(bytesIterable(png), "video/mp4", signal);
    const same = await store.put(bytesIterable(png), "text/plain", signal);
    assert.deepEqual(first, same);
    assert.equal(first.mimeType, "image/png");
    const oldBytes = await readFile(store.objectPath(first.sha256));
    const updated = await store.put(bytesIterable(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])), null, signal);
    assert.notEqual(updated.sha256, first.sha256);
    assert.equal(updated.mimeType, "image/jpeg");
    assert.deepEqual(await readFile(store.objectPath(first.sha256)), oldBytes);
    assert.equal(await store.verify(first), true);
    assert.equal(await store.verify(updated), true);
    const unknownA = await store.put(bytesIterable(Buffer.from([0, 1, 2, 3])), "image/png", signal);
    const unknownB = await store.put(bytesIterable(Buffer.from([0, 1, 2, 3])), null, signal);
    assert.deepEqual(unknownA, unknownB);
    assert.equal(unknownA.mimeType, "application/octet-stream");
    assert.equal((await stat(store.objectPath(first.sha256))).mode & 0o777, 0o400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded MIME prefix, pre-abort, and stream errors are safe and clean staging temps", async () => {
  const root = await tempRoot();
  try {
    const store = new FileContentAddressedObjectStore(root);
    const longJson = Buffer.from(JSON.stringify({ values: "汉".repeat(100_000) }));
    const ref = await store.put(bytesIterable(longJson), "text/plain", new AbortController().signal);
    assert.equal(ref.mimeType, "application/json");
    assert.equal(await store.verify(ref), true, "legacy UTF-8 JSON remains readable across a split prefix code point");
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(store.put((async function* () {})(), null, aborted.signal), SafeError);
    await assert.rejects(store.put((async function* () { yield Buffer.from("partial"); throw new Error("raw stream failure"); })(), null, new AbortController().signal), (error: unknown) => error instanceof SafeError && !error.message.includes("raw stream"));
    const postStreamBytes = Buffer.from("post-stream-cleanup");
    const postStreamDigest = sha256Bytes(postStreamBytes);
    const unsafeBucket = `${root}/objects/sha256/${postStreamDigest.slice(0, 2)}`;
    await mkdir(unsafeBucket, { mode: 0o700 });
    await chmod(unsafeBucket, 0o777);
    await assert.rejects(store.put(bytesIterable(postStreamBytes), null, new AbortController().signal), SafeError);
    const staging = `${root}/objects/sha256/.staging`;
    assert.deepEqual((await readdir(staging)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ftyp MIME classification requires an explicit MP4 major or compatible brand", () => {
  function ftyp(major: string, compatible: readonly string[] = []): Uint8Array {
    const bytes = Buffer.alloc(16 + compatible.length * 4);
    bytes.writeUInt32BE(bytes.byteLength, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write(major, 8, "ascii");
    for (let index = 0; index < compatible.length; index += 1) bytes.write(compatible[index]!, 16 + index * 4, "ascii");
    return bytes;
  }
  assert.deepEqual(detectMagicType(ftyp("mp42")), { mimeType: "video/mp4", extension: "mp4" });
  assert.deepEqual(detectMagicType(ftyp("zzzz", ["isom"])), { mimeType: "video/mp4", extension: "mp4" });
  assert.deepEqual(detectMagicType(ftyp("avif", ["avif"])), { mimeType: "application/octet-stream", extension: "bin" });
  assert.deepEqual(detectMagicType(ftyp("heic", ["mif1"])), { mimeType: "application/octet-stream", extension: "bin" });
});

test("MediaStore rejects text and JSON objects as media", async () => {
  const root = await tempRoot();
  try {
    const objects = new FileContentAddressedObjectStore(root);
    const media = new FileMediaStore(objects);
    for (const bytes of [Buffer.from("plain text"), Buffer.from('{"valid":true}')]) {
      await assert.rejects(media.put({ slot: { kind: "image", ordinal: 1 }, suggestedMimeType: "image/png", async open() { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); } }, new AbortController().signal), SafeError);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dated updates are selected independent of import order and observation time is excluded from hash", () => {
  const early = makeNote("accA", "noteA", time1, "body A");
  const late = { ...makeNote("accA", "noteA", time2, "body B"), tags: ["z", "a"], metrics: { liked: 7, collected: 2, commented: 0, shared: null }, memberships: [{ target: "collected_album" as const, boardId: "boardA" as never, boardName: "New", observedAt: time2 }] };
  const rankA = createValidatedNoteRank(early, time1);
  const rankB = createValidatedNoteRank(late, time2);
  const aThenB1 = mergeCanonicalNote(null, { note: early, sourceRank: rankA, mediaSlots: [], mediaSetComplete: false });
  const aThenB = mergeCanonicalNote(shellManifest(aThenB1), { note: late, sourceRank: rankB, mediaSlots: [], mediaSetComplete: false });
  const bThenA1 = mergeCanonicalNote(null, { note: late, sourceRank: rankB, mediaSlots: [], mediaSetComplete: false });
  const bThenA = mergeCanonicalNote(shellManifest(bThenA1), { note: early, sourceRank: rankA, mediaSlots: [], mediaSetComplete: false });
  assert.equal(aThenB.note.contentHash, bThenA.note.contentHash);
  assert.deepEqual(aThenB.note.tags, bThenA.note.tags);
  assert.deepEqual(aThenB.note.metrics, bThenA.note.metrics);
  assert.equal(aThenB.note.capturedAt, time2);
  const capturedOnly = { ...early, capturedAt: time2, memberships: early.memberships.map((m) => ({ ...m, observedAt: time2 })) };
  assert.equal(computeContentHash(early), computeContentHash(capturedOnly));
});

test("Account merge follows the latest complete observation, including unknown names", () => {
  const a = makeAccount("accA", "Alpha", time2, time2);
  const b = makeAccount("accA", "Zulu", time1, time1);
  const c = makeAccount("accA", null, time1, decodeIsoDateTime("2026-01-03T00:00:00.000Z"));
  assert.deepEqual(mergeAccount(a, b), mergeAccount(b, a));
  assert.deepEqual(mergeAccount(mergeAccount(a, b), c), mergeAccount(a, mergeAccount(b, c)));
  assert.deepEqual(mergeAccount(a, a), a);
  assert.equal(mergeAccount(a, c).displayName, null);
  assert.equal(mergeAccount(a, b).displayName, "Alpha");
});

test("new observations replace source tags and allow declining metrics without stale replays", () => {
  const first = { ...makeNote("owner", "post", time1, "old body"), tags: ["removed", "kept"], metrics: { liked: 20, collected: 3, commented: 2, shared: 1 } };
  const second = { ...makeNote("owner", "post", time2, "new body"), tags: ["kept"], metrics: { liked: 15, collected: 0, commented: null, shared: null } };
  const candidate = (note: typeof first | typeof second) => ({ note, sourceRank: createValidatedNoteRank(note, null), mediaSlots: [], mediaSetComplete: false });
  const before = mergeCanonicalNote(null, candidate(first));
  const after = mergeCanonicalNote(shellManifest(before), candidate(second));
  assert.equal(after.note.body, "new body");
  assert.deepEqual(after.note.tags, ["kept"]);
  assert.deepEqual(after.note.metrics, second.metrics);
  const replay = mergeCanonicalNote(shellManifest(after), candidate(first));
  assert.deepEqual(replay.note, after.note);
});

test("a hash cannot select a winner for conflicting content observed at the same time", () => {
  const first = makeNote("owner", "post", time1, "first observation");
  const conflict = makeNote("owner", "post", time1, "different body at the same observation time");
  const prior = mergeCanonicalNote(null, { note: first, sourceRank: createValidatedNoteRank(first, time1), mediaSlots: [], mediaSetComplete: false });
  const result = mergeCanonicalNote(shellManifest(prior), { note: conflict, sourceRank: createValidatedNoteRank(conflict, time1), mediaSlots: [], mediaSetComplete: false });
  assert.equal(result.note.body, first.body);
  assert.equal(compareSourceRank(prior.sourceRank, createValidatedNoteRank(conflict, time1)), 0);
});

test("media LKG survives failures and complete high-rank removal creates a tombstone", () => {
  const mediaObject = { sha256: decodeSha256("1".repeat(64)), byteLength: 3, mimeType: "image/png" };
  const media: Media = { mediaId: "image-1", kind: "image", ordinal: 1, status: "stored", extension: "png", object: mediaObject };
  const note = { ...makeNote(), media: [media] };
  const storedNote = { ...note, contentHash: computeContentHash(note) };
  const low = createValidatedNoteRank(storedNote, time1);
  const removalNote = makeNote("accA", "noteA", time2);
  const high = createValidatedNoteRank(removalNote, time2);
  const stored = mergeCanonicalNote(null, { note: storedNote, sourceRank: low, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: low, media, tombstone: false }], mediaSetComplete: false });
  const failedMedia: Media = { mediaId: "image-1", kind: "image", ordinal: 1, status: "failed", extension: null, object: null };
  const failed = mergeCanonicalNote(shellManifest(stored), { note: removalNote, sourceRank: high, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: high, media: failedMedia, tombstone: false }], mediaSetComplete: false });
  assert.equal(failed.mediaSlots[0]!.media?.status, "stored");
  assert.equal(failed.mediaSlots[0]!.media?.object?.sha256, mediaObject.sha256);
  const removed = mergeCanonicalNote(shellManifest(stored), { note: removalNote, sourceRank: high, mediaSlots: [], mediaSetComplete: true });
  assert.equal(removed.mediaSlots[0]!.tombstone, true);
  assert.equal(removed.note.media.length, 0);
  const lowReplay = mergeCanonicalNote(shellManifest(removed), { note: storedNote, sourceRank: low, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: low, media, tombstone: false }], mediaSetComplete: false });
  assert.equal(lowReplay.mediaSlots[0]!.tombstone, true);
});

test("older identical payloads never lower the observation rank or revive removed media", () => {
  const time3 = decodeIsoDateTime("2026-01-03T00:00:00.000Z");
  const candidate = (at: typeof time1, body = "same content", stored = false) => {
    const note = makeNote("accA", "noteA", at, body);
    const rank = createValidatedNoteRank(note, null);
    const media: Media = { mediaId: "image-1", kind: "image", ordinal: 1, status: "stored", extension: "png", object: { sha256: decodeSha256("1".repeat(64)), byteLength: 3, mimeType: "image/png" } };
    return { note, sourceRank: rank, mediaSlots: stored ? [{ slot: { kind: "image" as const, ordinal: 1 }, sourceRank: rank, media, tombstone: false }] : [], mediaSetComplete: true };
  };
  const latest = mergeCanonicalNote(null, candidate(time3));
  const identicalReplay = mergeCanonicalNote(shellManifest(latest), candidate(time1));
  assert.equal(identicalReplay.sourceRank.observedAt, time3);
  const stale = mergeCanonicalNote(shellManifest(identicalReplay), candidate(time2, "stale body"));
  assert.equal(stale.note.body, "same content");
  const stored = mergeCanonicalNote(null, candidate(time1, "same content", true));
  const removed = mergeCanonicalNote(shellManifest(stored), candidate(time3));
  const removalReplay = mergeCanonicalNote(shellManifest(removed), candidate(time1));
  const storedReplay = mergeCanonicalNote(shellManifest(removalReplay), candidate(time2, "same content", true));
  assert.equal(storedReplay.note.media.length, 0);
  assert.equal(storedReplay.mediaSlots[0]!.sourceRank.observedAt, time3);
});

test("mixed source revisions and null fields use one observation order across three inputs", () => {
  const time3 = decodeIsoDateTime("2026-01-03T00:00:00.000Z");
  const notes: Note[] = [makeNote("accA", "noteA", time1, "first"), makeNote("accA", "noteA", time2, "middle"), { ...makeNote("accA", "noteA", time3, "latest"), title: null, author: { id: null, name: null, publicUrl: null }, metrics: { liked: null, collected: null, commented: null, shared: null } }];
  const candidates = notes.map((note, index) => ({ note, sourceRank: createValidatedNoteRank(note, index === 1 ? null : time1), mediaSlots: [], mediaSetComplete: false }));
  for (const order of [[0, 1, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0]]) {
    let manifest: NoteManifest | null = null;
    for (const index of order) manifest = shellManifest(mergeCanonicalNote(manifest, candidates[index]!));
    assert.equal(manifest!.canonicalNote.body, "latest");
    assert.equal(manifest!.canonicalNote.title, null);
    assert.equal(manifest!.canonicalNote.author.name, null);
    assert.equal(manifest!.canonicalNote.metrics.liked, null);
  }
});

test("valid whitespace survives rank validation and media inherits its candidate observation", () => {
  const note = { ...makeNote(), title: " padded title ", author: { id: "author", name: " padded name ", publicUrl: null }, tags: [" padded tag "] };
  const rank = createValidatedNoteRank(note, null);
  const media: Media = { mediaId: "image", kind: "image", ordinal: 1, status: "stored", extension: "png", object: { sha256: decodeSha256("1".repeat(64)), byteLength: 3, mimeType: "image/png" } };
  const result = mergeCanonicalNote(null, { note, sourceRank: rank, mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: { ...rank, observedAt: time2 }, media, tombstone: false }], mediaSetComplete: true });
  assert.equal(result.note.title, note.title);
  assert.equal(result.note.author.name, note.author.name);
  assert.deepEqual(result.note.tags, note.tags);
  assert.equal(result.mediaSlots[0]!.sourceRank.observedAt, note.capturedAt);
});

test("media failure rank is monotonic and only accepted sufficient-rank repair resolves", () => {
  const scope = makeScope();
  const low = createValidatedSourceRank({ p: "low" }, time1);
  const high = createValidatedSourceRank({ p: "high" }, time2);
  const base: FailureRecord = { schemaVersion: 1, failureId: "failureA", scope, noteId: "noteA" as never, mediaSlot: { kind: "image", ordinal: 1 }, sourceRank: high, category: "MEDIA", stage: "media", safeMessage: "media unavailable", retryable: true, attemptCount: 1, firstOccurredAt: time1, lastOccurredAt: time1, retryAt: null, resolvedAt: null, resolvedReason: null };
  const lowFailure = { ...base, sourceRank: low, lastOccurredAt: time2 };
  const merged = mergeFailure(base, lowFailure);
  assert.equal(compareSourceRank(merged.sourceRank!, high), 0);
  assert.equal(merged.attemptCount, 2);
  assert.equal(canResolveMediaFailure(merged, low, true), false);
  assert.equal(canResolveMediaFailure(merged, high, false), false);
  assert.equal(canResolveMediaFailure(merged, high, true), true);
  const detail = { ...base, failureId: "detailA", stage: "detail" as const, category: "DETAIL" as const, mediaSlot: null, sourceRank: null };
  assert.throws(() => mergeFailure(detail, { ...detail, sourceRank: low }), SafeError);
});
