import assert from "node:assert/strict";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import test from "node:test";
import {
  MemorySecretRegistry,
  SafeError,
  assertPersistenceSafe,
  assertValidatedSourceRank,
  consumePrivateNoteAccess,
  createPrivateNoteAccess,
  createSafeLogger,
  createValidatedSourceRank,
  decodePartitionScope,
  decodeNote,
  decodeRelativePath,
  isPrivateNoteAccess,
  isValidatedSourceRank,
  ensureSecureRoot,
  openVerifiedInput,
  resolveDigestPath,
  resolveUnderRoot,
  validateSafeReason,
} from "../src/index.ts";
import { makeNote, makeScope, tempRoot, time1 } from "./helpers.ts";
import { requestScopePause } from "../src/control.ts";

test("exact discriminated scope decoder rejects extras and board mismatch", () => {
  assert.deepEqual(decodePartitionScope({ hostId: "xhs", accountId: "a", target: "liked", boardId: null }), { hostId: "xhs", accountId: "a", target: "liked", boardId: null });
  assert.throws(() => decodePartitionScope({ hostId: "xhs", accountId: "a", target: "liked", boardId: "b" }), SafeError);
  assert.throws(() => decodePartitionScope({ hostId: "xhs", accountId: "a", target: "collected_album", boardId: null }), SafeError);
  assert.throws(() => decodePartitionScope({ hostId: "xhs", accountId: "a", target: "liked", boardId: null, extra: 1 }), SafeError);
});

test("canonical Note decoding requires the HostAdapter URL and a same-origin safe author URL", () => {
  const note = makeNote();
  assert.throws(() => decodeNote({ ...note, publicUrl: "https://example.invalid/explore/noteA" }), SafeError);
  assert.throws(() => decodeNote({ ...note, publicUrl: `${note.publicUrl}?token=blocked` }), SafeError);
  assert.throws(() => decodeNote({ ...note, author: { ...note.author, publicUrl: "javascript:alert(1)" } }), SafeError);
  assert.throws(() => decodeNote({ ...note, author: { ...note.author, publicUrl: "https://www.rednote.com/user/authorA" } }), SafeError);
  assert.doesNotThrow(() => decodeNote({ ...note, author: { ...note.author, publicUrl: "https://www.xiaohongshu.com/user/authorA" } }));
});

test("PrivateNoteAccess is WeakSet/WeakMap backed and blocked on every serialization boundary", () => {
  const access = createPrivateNoteAccess("secret-value-7");
  assert.equal(isPrivateNoteAccess(access), true);
  assert.equal(Object.keys(access).length, 0);
  assert.equal(consumePrivateNoteAccess(access, (value) => value), "secret-value-7");
  assert.throws(() => JSON.stringify(access), SafeError);
  assert.throws(() => structuredClone(access));
  assert.match(inspect(access), /rejected/);
  const fake = Object.freeze({ use: access.use, toJSON: access.toJSON });
  assert.equal(isPrivateNoteAccess(fake), false);
  assert.throws(() => assertPersistenceSafe({ access }, new MemorySecretRegistry()), SafeError);
});

test("validated source rank cannot be forged, copied, serialized, or cloned", () => {
  const payload = { title: "safe", body: "payload" };
  const rank = createValidatedSourceRank(payload, time1);
  assert.equal(isValidatedSourceRank(rank), true);
  assert.doesNotThrow(() => assertValidatedSourceRank(rank));
  const plain = JSON.parse(JSON.stringify(rank));
  assert.equal(isValidatedSourceRank(plain), false);
  assert.throws(() => assertValidatedSourceRank(plain), SafeError);
  assert.equal(isValidatedSourceRank({ ...rank }), false);
  assert.equal(isValidatedSourceRank(structuredClone(rank)), false);
  assert.throws(() => createValidatedSourceRank(payload, time1, "0".repeat(64)), SafeError);
  assert.throws(() => createValidatedSourceRank(payload, "2026-02-30T00:00:00.000Z"), SafeError);
});

test("dynamic secrets and canaries never reach logger, reason, or persistence", () => {
  const registry = new MemorySecretRegistry();
  registry.register("session-9-secret");
  assert.throws(() => assertPersistenceSafe({ title: "session-9-secret" }, registry), SafeError);
  assert.throws(() => assertPersistenceSafe({ cookie: "x" }, registry), SafeError);
  assert.throws(() => assertPersistenceSafe("REDNOTE_SECRET_CANARY", registry), SafeError);
  assert.throws(() => assertPersistenceSafe("https://example.invalid/n?token=x", registry), SafeError);
  assert.throws(() => validateSafeReason("token=value", registry), SafeError);
  const lines: string[] = [];
  const logger = createSafeLogger(registry, (line) => lines.push(line));
  assert.throws(() => logger.info("event", { title: "session-9-secret" }), SafeError);
  logger.info("safe_event", { noteId: "noteA" });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /secret/);
});

test("serialized secret scanning cannot be bypassed by chunk boundaries", async () => {
  const registry = new MemorySecretRegistry();
  registry.register("split-session-42-value");
  const root = await tempRoot();
  try {
    const { FileContentAddressedObjectStore } = await import("../src/object-store.ts");
    const store = new FileContentAddressedObjectStore(root, registry);
    async function* split() { yield Buffer.from("prefix split-session-"); yield Buffer.from("42-value suffix"); }
    await assert.rejects(store.put(split(), null, new AbortController().signal), SafeError);
    async function* tokenSplit() { yield Buffer.from("prefix AbCdEf1234"); yield Buffer.from("567890XyZ suffix"); }
    await assert.rejects(store.put(tokenSplit(), null, new AbortController().signal), SafeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("path resolver rejects traversal, symlinks, and Unicode/case identity collisions", async () => {
  const root = await tempRoot();
  try {
    assert.throws(() => decodeRelativePath("../escape"), SafeError);
    assert.throws(() => decodeRelativePath("/absolute"), SafeError);
    assert.throws(() => decodeRelativePath("C:/absolute"), SafeError);
    assert.throws(() => decodeRelativePath("media\\item.gif"), SafeError);
    assert.throws(() => decodeRelativePath("media/\u0001item.gif"), SafeError);
    await mkdir(`${root}/safe`, { mode: 0o700 });
    await writeFile(`${root}/safe/file.txt`, "safe");
    const handle = await openVerifiedInput(root, "safe/file.txt");
    await handle.close();
    await symlink(`${root}/safe`, `${root}/link`);
    await assert.rejects(resolveUnderRoot(root, decodeRelativePath("link/file.txt")), SafeError);
    await mkdir(`${root}/Case`, { mode: 0o700 });
    await assert.rejects(resolveUnderRoot(root, decodeRelativePath("case/item"), true), SafeError);
    const digest = "a".repeat(64);
    assert.match(await resolveDigestPath(root, `objects/sha256/aa/${digest}`, true), new RegExp(digest));
    await assert.rejects(resolveDigestPath(root, "objects/raw-account/item", true), SafeError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("secure output root rejects a symlink in any intermediate ancestor", async () => {
  const parent = await tempRoot("rednote-root-ancestor-");
  try {
    await mkdir(`${parent}/real-parent`, { mode: 0o700 });
    await symlink(`${parent}/real-parent`, `${parent}/linked-parent`);
    const unsafeRoot = `${parent}/linked-parent/nested-root`;
    await assert.rejects(ensureSecureRoot(unsafeRoot), (error: unknown) => error instanceof SafeError && error.code === "SECURITY_BOUNDARY");
    const { SqliteStateStore } = await import("../src/state-store.ts");
    await assert.rejects(SqliteStateStore.init(unsafeRoot), SafeError);
    const { FileContentAddressedObjectStore } = await import("../src/object-store.ts");
    await assert.rejects(new FileContentAddressedObjectStore(unsafeRoot).initialize(), SafeError);
    await assert.rejects(requestScopePause(unsafeRoot, makeScope("ancestor-control")), SafeError);
    await assert.rejects(resolveUnderRoot(unsafeRoot, decodeRelativePath(`accounts/${"a".repeat(64)}/data/index.json`), true), SafeError);
    await assert.rejects(access(`${parent}/real-parent/nested-root`), "a rejected ancestor must not create directories through the symlink target");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
