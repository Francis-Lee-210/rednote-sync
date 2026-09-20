import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FileContentAddressedObjectStore, FileMediaStore, bytesIterable, readableStreamToAsync } from "../src/object-store.ts";
import { exportAccount } from "../src/projectors.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { accountKey, accountPartition, initialProgress, noteKey, type Media, type Note, type NoteManifest, type SyncState } from "../src/types.ts";
import { computeContentHash, deriveMembershipNameObservations, indexEntryDigest, noteCsvRowDigest } from "../src/merge.ts";
import { renderNoteJsonBytes, renderNoteMarkdownBytes } from "../src/exporters.ts";
import { createValidatedNoteRank } from "../src/rank.ts";
import { verifyRoot } from "../src/verify.ts";
import { makeAccount, makeNote, makeScope, tempRoot, time1, time2, withMergeCandidates } from "./helpers.ts";

const scope = makeScope("storage-fixture");
const account = accountPartition(scope);

async function addNote(store: SqliteStateStore, id: string, size = 128 * 1024): Promise<NoteManifest> {
  const objects = store.objectStore();
  const bytes = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); Buffer.from(id).copy(bytes, 16);
  const signal = new AbortController().signal;
  const blob = await objects.put(bytesIterable(bytes), null, signal);
  const media: Media = { mediaId: id, kind: "image", ordinal: 1, status: "stored", extension: "png", object: blob };
  const raw: Note = { ...makeNote(scope.accountId, id), noteType: "image", media: [media] };
  const note = { ...raw, contentHash: computeContentHash(raw) };
  const rank = createValidatedNoteRank(note, time1);
  const json = await objects.put(bytesIterable(renderNoteJsonBytes(note)), null, signal);
  const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(note)), null, signal);
  const manifest: NoteManifest = { schemaVersion: 1, revision: 1, accountId: account.accountId, hostId: account.hostId, noteId: note.noteId, canonicalNote: note, semanticSourceRank: rank, membershipNameObservations: deriveMembershipNameObservations(note), mediaSlots: [{ slot: { kind: "image", ordinal: 1 }, sourceRank: rank, media, tombstone: false }], artifacts: { json, markdown }, indexEntrySha256: indexEntryDigest(note), csvRowSha256: noteCsvRowDigest(note) };
  const tx = store.beginImmediate({ command: "sync", scope });
  store.upsertAccount(tx, makeAccount(scope.accountId));
  const prior = tx.loadState(scope);
  const nextState = { ...scope, schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, progress: prior?.progress ?? initialProgress(), stopReason: null, lastAttemptAt: time2, lastSuccessfulAt: time2, nextAllowedAt: null } as SyncState;
  const task = { schemaVersion: 1 as const, scope, noteId: note.noteId, status: "done" as const, attemptCount: 1, failureIds: [], skipReason: null, skippedAt: null, firstSeenAt: time1, updatedAt: time2 };
  store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, withMergeCandidates({ scope, expectedStateRevision: prior?.revision ?? 0, expectedManifestRevisions: { [note.noteId]: null }, nextState, manifests: [manifest], tasks: [task], failures: [] })));
  store.commitCanonical(tx);
  return manifest;
}

test("fresh media is hashed while streaming without whole-file readback", async () => {
  const root = await tempRoot("rednote-stream-");
  try {
    class NoReadbackStore extends FileContentAddressedObjectStore {
      override async readBytes(): Promise<Uint8Array> { throw new Error("unexpected whole-file read"); }
      override async verify(): Promise<boolean> { throw new Error("unexpected readback"); }
    }
    const objects = new NoReadbackStore(root);
    const data = Buffer.alloc(4 * 1024 * 1024); Buffer.from("GIF89a").copy(data);
    const stored = await new FileMediaStore(objects).put({ slot: { kind: "image", ordinal: 1 }, suggestedMimeType: null, async open() { return new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }); } }, new AbortController().signal);
    assert.equal(stored.extension, "gif");
    let length = 0; let chunks = 0;
    for await (const chunk of readableStreamToAsync(await objects.open(stored.object!))) { assert.ok(chunk.byteLength <= 64 * 1024); length += chunk.byteLength; chunks += 1; }
    assert.equal(length, data.byteLength); assert.ok(chunks > 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adding a note does not reopen unchanged notes or media and leaves their mtimes", async () => {
  const root = await tempRoot("rednote-incremental-");
  const store = await SqliteStateStore.init(root);
  try {
    const first = await addNote(store, "note-one");
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    const key = accountKey(account); const digest = noteKey(account, first.noteId);
    const paths = [`accounts/${key}/notes/${digest}.md`, `accounts/${key}/data/notes/${digest}.json`, `accounts/${key}/assets/${digest}/image-1.png`];
    const mtimes = await Promise.all(paths.map(async (relative) => (await stat(path.join(root, relative))).mtimeMs));
    await addNote(store, "note-two");
    const oldHashes = new Set([first.artifacts.json.sha256, first.artifacts.markdown.sha256, first.mediaSlots[0]!.media!.object!.sha256]);
    const original = FileContentAddressedObjectStore.prototype.open;
    let opened = 0;
    FileContentAddressedObjectStore.prototype.open = async function(ref) { assert.equal(oldHashes.has(ref.sha256), false, "unchanged object was reopened"); opened += 1; return original.call(this, ref); };
    try { assert.equal((await exportAccount(root, account)).exitCode, 0); } finally { FileContentAddressedObjectStore.prototype.open = original; }
    assert.equal(opened, 3, "only the new note's two artifacts and media are copied");
    assert.deepEqual(await Promise.all(paths.map(async (relative) => (await stat(path.join(root, relative))).mtimeMs)), mtimes);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("export cancellation retains committed facts and resumes without a database writer lock", async () => {
  const root = await tempRoot("rednote-export-pause-");
  const store = await SqliteStateStore.init(root);
  try {
    const manifest = await addNote(store, "committed-note");
    const abort = new AbortController(); let checked = false;
    const result = await exportAccount(root, account, { signal: abort.signal, async onCheckpoint(point) {
      if (!checked) {
        checked = true;
        const second = await SqliteStateStore.open(root);
        try { const tx = second.beginImmediate({ command: "sync", scope }); second.rollback(tx); } finally { second.close(); }
      }
      if (point.projectorId === "assets" && point.phase === "before_stable_file") abort.abort();
    } });
    assert.equal(result.exitCode, 9); assert.equal(checked, true);
    const read = store.openReadSnapshot();
    assert.equal(read.loadManifest(account, manifest.noteId)?.canonicalNote.body, manifest.canonicalNote.body);
    assert.equal([...read.enumerateAccountsWithGenerations()][0]!.viewsDirty, true); read.close();
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit verify detects same-size damage and full repair rebuilds derived media", async () => {
  const root = await tempRoot("rednote-audit-repair-"); const store = await SqliteStateStore.init(root);
  try {
    const manifest = await addNote(store, "repair-note"); await exportAccount(root, account);
    const asset = path.join(root, `accounts/${accountKey(account)}/assets/${noteKey(account, manifest.noteId)}/image-1.png`);
    const original = await readFile(asset); const damaged = Buffer.from(original); damaged[damaged.length - 1] = 42; await writeFile(asset, damaged);
    assert.equal((await verifyRoot(root)).exitCode, 9);
    assert.equal((await exportAccount(root, account, { full: true })).exitCode, 0);
    assert.deepEqual(await readFile(asset), original);
    const object = store.objectStore().objectPath(manifest.mediaSlots[0]!.media!.object!.sha256);
    await chmod(object, 0o600); await writeFile(object, damaged);
    await assert.rejects(verifyRoot(root), /canonical object failed verification/);
    await assert.rejects(exportAccount(root, account, { full: true }), /canonical object failed verification/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a killed export leaves committed facts recoverable and a stale export lock is reclaimed", async () => {
  const root = await tempRoot("rednote-export-crash-"); const store = await SqliteStateStore.init(root);
  try {
    const manifest = await addNote(store, "crash-note");
    const worker = spawn(process.execPath, [path.resolve("tests/export-worker.ts"), root, scope.accountId], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; worker.stderr?.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.once("exit", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(stderr || "worker did not reach export"))); });
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("worker export timeout")), 10_000); worker.once("message", () => { clearTimeout(timeout); worker.kill("SIGKILL"); resolve(); }); worker.once("error", reject); });
    await exited;
    const read = store.openReadSnapshot(); assert.ok(read.loadManifest(account, manifest.noteId)); read.close();
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});


test("verify never recreates missing object directories", async () => {
  for (const relative of ["objects", "objects/sha256"]) {
    const root = await tempRoot("rednote-readonly-verify-");
    const store = await SqliteStateStore.init(root);
    try {
      await addNote(store, "readonly-note");
      await rm(path.join(root, relative), { recursive: true });
      await assert.rejects(verifyRoot(root), /canonical object failed verification/);
      await assert.rejects(stat(path.join(root, relative)), { code: "ENOENT" });
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  }
});
