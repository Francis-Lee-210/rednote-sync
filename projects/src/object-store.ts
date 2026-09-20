import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "./canonical.ts";
import { SafeError, normalizeSafeError } from "./errors.ts";
import { ensureSecureRoot } from "./paths.ts";
import { MemorySecretRegistry, assertPersistenceSafe, assertKnownSecretBytes } from "./secrets.ts";
import { decodeSha256, type Media, type MediaSlot, type ObjectRef, type Sha256 } from "./types.ts";

export interface ContentAddressedObjectStore {
  put(bytes: AsyncIterable<Uint8Array>, suggestedMimeType: string | null, signal: AbortSignal): Promise<ObjectRef>;
  verify(ref: ObjectRef): Promise<boolean>;
  open(ref: ObjectRef): Promise<ReadableStream<Uint8Array>>;
}

export interface TransientMediaSource {
  readonly slot: MediaSlot;
  readonly suggestedMimeType: string | null;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface MediaStore {
  put(source: TransientMediaSource, signal: AbortSignal): Promise<Media>;
  verify(media: Media): Promise<boolean>;
}

export interface MagicType { readonly mimeType: string; readonly extension: string }

const MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"]);

export function detectMagicType(bytes: Uint8Array, totalByteLength = bytes.byteLength): MagicType {
  const b = bytes;
  if (b.length >= 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", extension: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg" };
  if (b.length >= 6 && (Buffer.from(b.subarray(0, 6)).toString("ascii") === "GIF87a" || Buffer.from(b.subarray(0, 6)).toString("ascii") === "GIF89a")) return { mimeType: "image/gif", extension: "gif" };
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("ascii") === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  if (b.length >= 16 && Buffer.from(b.subarray(4, 8)).toString("ascii") === "ftyp") {
    const boxLength = Buffer.from(b.subarray(0, 4)).readUInt32BE(0);
    if (boxLength >= 16 && boxLength <= totalByteLength) {
      const brands = [Buffer.from(b.subarray(8, 12)).toString("ascii")];
      for (let offset = 16; offset + 4 <= Math.min(boxLength, b.length); offset += 4) brands.push(Buffer.from(b.subarray(offset, offset + 4)).toString("ascii"));
      if (brands.some((brand) => MP4_BRANDS.has(brand))) return { mimeType: "video/mp4", extension: "mp4" };
    }
  }
  const text = Buffer.from(b).toString("utf8");
  if (!text.includes("\ufffd") && Buffer.from(text, "utf8").equals(Buffer.from(b))) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { JSON.parse(text); return { mimeType: "application/json", extension: "json" }; } catch { /* canonical fallback */ }
    }
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return { mimeType: "text/plain; charset=utf-8", extension: "txt" };
  }
  return { mimeType: "application/octet-stream", extension: "bin" };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) throw new SafeError("CANONICAL_INTEGRITY", "object write failed");
    offset += result.bytesWritten;
  }
}

export async function* readableStreamToAsync(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { complete = true; return; }
      yield item.value;
    }
  } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4",
  "application/json": "json", "text/plain; charset=utf-8": "txt", "application/octet-stream": "bin",
});
const SNIFF_BYTES = 64 * 1024;

function sniffType(prefix: Uint8Array, byteLength: number): MagicType {
  const raw = detectMagicType(prefix, byteLength);
  if (byteLength <= prefix.byteLength || !raw.mimeType.startsWith("text/") && raw.mimeType !== "application/octet-stream") return raw;
  // Streaming UTF-8 decoding omits a possibly incomplete final code point.
  // Metadata is recognized from its bounded prefix; parsers validate structure
  // before canonical artifacts reach this store.
  const text = new TextDecoder("utf-8").decode(prefix, { stream: true });
  const detected = detectMagicType(Buffer.from(text));
  if (detected.mimeType.startsWith("text/") && /^[\s]*[\[{]/.test(text)) return { mimeType: "application/json", extension: "json" };
  return detected.mimeType.startsWith("text/") || detected.mimeType === "application/json" ? detected : raw;
}

export function objectExtension(ref: ObjectRef): string { return MIME_EXTENSIONS[ref.mimeType] ?? "bin"; }

/** Files are hashed on ingestion; normal reads trust immutable published objects.
 * Explicit verify performs the expensive byte-level audit. */
export class FileContentAddressedObjectStore implements ContentAddressedObjectStore {
  readonly root: string;
  readonly registry: MemorySecretRegistry;
  #initialized: Promise<void> | null = null;
  #issued = new WeakSet<object>();

  constructor(root: string, registry = new MemorySecretRegistry()) { this.root = root; this.registry = registry; }
  owns(ref: ObjectRef): boolean { return this.#issued.has(ref); }

  async initialize(): Promise<void> {
    if (!this.#initialized) this.#initialized = (async () => {
      const trusted = await ensureSecureRoot(this.root);
      for (const candidate of [path.join(trusted, "objects"), path.join(trusted, "objects", "sha256")]) {
        await mkdir(candidate, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object directory");
      }
    })().catch((error) => { this.#initialized = null; throw error; });
    await this.#initialized;
    for (const candidate of [this.root, path.join(this.root, "objects"), path.join(this.root, "objects", "sha256")]) {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object directory");
    }
  }

  objectPath(hash: Sha256): string { const digest = decodeSha256(hash); return path.join(this.root, "objects", "sha256", digest.slice(0, 2), digest); }

  async put(bytes: AsyncIterable<Uint8Array>, suggestedMimeType: string | null, signal: AbortSignal): Promise<ObjectRef> {
    if (signal.aborted) throw new SafeError("STATE", "object write aborted");
    await this.initialize();
    if (suggestedMimeType !== null) assertPersistenceSafe(suggestedMimeType, this.registry);
    const staging = path.join(this.root, "objects", "sha256", ".staging");
    await mkdir(staging, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(staging);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object staging directory");
    const temp = path.join(staging, `${randomBytes(16).toString("hex")}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    let prefix = Buffer.alloc(0);
    let scanTail = Buffer.alloc(0);
    try {
      for await (const raw of bytes) {
        if (signal.aborted) throw new SafeError("STATE", "object write aborted");
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const scanBytes = Buffer.concat([scanTail, chunk]);
        assertKnownSecretBytes(scanBytes, this.registry);
        scanTail = Buffer.from(scanBytes.subarray(Math.max(0, scanBytes.byteLength - this.registry.scanWindowSize)));
        if (prefix.byteLength < SNIFF_BYTES) prefix = Buffer.concat([prefix, chunk.subarray(0, SNIFF_BYTES - prefix.byteLength)]);
        await writeAll(handle, chunk); hash.update(chunk); byteLength += chunk.byteLength;
      }
      if (signal.aborted) throw new SafeError("STATE", "object write aborted");
      await handle.sync();
      await handle.close();
      const digest = decodeSha256(hash.digest("hex"));
      const ref: ObjectRef = Object.freeze({ sha256: digest, byteLength, mimeType: sniffType(prefix, byteLength).mimeType });
      const directory = path.dirname(this.objectPath(digest));
      await mkdir(directory, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      const bucket = await lstat(directory);
      if (bucket.isSymbolicLink() || !bucket.isDirectory() || bucket.uid !== process.getuid?.() || (bucket.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object bucket");
      await chmod(temp, 0o400);
      try { await link(temp, this.objectPath(digest)); await fsyncDirectory(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Only a pre-existing file needs a read-back; newly published bytes were
        // already hashed in the stream above.
        if (!await this.verify(ref)) throw new SafeError("CANONICAL_INTEGRITY", "existing object failed verification");
      }
      this.#issued.add(ref);
      return ref;
    } catch (error) { throw normalizeSafeError(error, "CANONICAL_INTEGRITY", "object write failed"); }
    finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }

  async #openFile(ref: ObjectRef) {
    const target = this.objectPath(ref.sha256);
    // Reading an archive never initializes or repairs its filesystem.
    for (const candidate of [this.root, path.join(this.root, "objects"), path.join(this.root, "objects", "sha256"), path.dirname(target)]) {
      const info = await lstat(candidate).catch((error) => { throw normalizeSafeError(error, "CANONICAL_INTEGRITY", "object directory is missing"); });
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object directory");
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size !== ref.byteLength) throw new SafeError("CANONICAL_INTEGRITY", "object metadata mismatch");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async open(ref: ObjectRef): Promise<ReadableStream<Uint8Array>> {
    const handle = await this.#openFile(ref);
    let count = 0;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await handle.close(); } };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) {
            await close();
            if (count !== ref.byteLength) throw new SafeError("CANONICAL_INTEGRITY", "object length changed");
            controller.close(); return;
          }
          count += bytesRead; controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) { await close(); controller.error(error); }
      },
      async cancel() { await close(); },
    });
  }

  async readBytes(ref: ObjectRef): Promise<Uint8Array> {
    const handle = await this.#openFile(ref);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }

  async verify(ref: ObjectRef): Promise<boolean> {
    try {
      const hash = createHash("sha256");
      let prefix = Buffer.alloc(0);
      let length = 0;
      let tail = Buffer.alloc(0);
      for await (const chunk of readableStreamToAsync(await this.open(ref))) {
        hash.update(chunk); length += chunk.byteLength;
        if (prefix.byteLength < SNIFF_BYTES) prefix = Buffer.concat([prefix, chunk.subarray(0, SNIFF_BYTES - prefix.byteLength)]);
        const scan = Buffer.concat([tail, chunk]); assertKnownSecretBytes(scan, this.registry);
        tail = Buffer.from(scan.subarray(Math.max(0, scan.byteLength - this.registry.scanWindowSize)));
      }
      return length === ref.byteLength && hash.digest("hex") === ref.sha256 && sniffType(prefix, length).mimeType === ref.mimeType;
    } catch { return false; }
  }

  verifySync(ref: ObjectRef): boolean {
    try { const bytes = this.readBytesSync(ref); return sha256Bytes(bytes) === ref.sha256 && sniffType(bytes.subarray(0, SNIFF_BYTES), bytes.byteLength).mimeType === ref.mimeType; } catch { return false; }
  }

  readBytesSync(ref: ObjectRef): Uint8Array {
    const target = this.objectPath(ref.sha256);
    for (const candidate of [this.root, path.join(this.root, "objects"), path.join(this.root, "objects", "sha256"), path.dirname(target)]) {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object directory");
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size !== ref.byteLength) throw new SafeError("CANONICAL_INTEGRITY", "object metadata mismatch");
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
}

export class FileMediaStore implements MediaStore {
  readonly objects: FileContentAddressedObjectStore;
  constructor(objects: FileContentAddressedObjectStore) { this.objects = objects; }
  async put(source: TransientMediaSource, signal: AbortSignal): Promise<Media> {
    if (!Number.isSafeInteger(source.slot.ordinal) || source.slot.ordinal <= 0 || !["cover", "image", "video"].includes(source.slot.kind)) throw new SafeError("INVALID_INPUT", "invalid media slot");
    const object = await this.objects.put(readableStreamToAsync(await source.open(signal)), source.suggestedMimeType, signal);
    const extension = objectExtension(object);
    if (!["png", "jpg", "gif", "webp", "mp4"].includes(extension)) throw new SafeError("INVALID_INPUT", "media source has unsupported magic bytes");
    return Object.freeze({ mediaId: `${source.slot.kind}-${source.slot.ordinal}-${object.sha256}`, kind: source.slot.kind, ordinal: source.slot.ordinal, status: "stored", extension, object });
  }
  async verify(media: Media): Promise<boolean> { return media.status === "stored" && media.object !== null && media.extension === objectExtension(media.object) && await this.objects.verify(media.object); }
}

export async function* bytesIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
