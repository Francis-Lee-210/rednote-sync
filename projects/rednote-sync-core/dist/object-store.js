import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "./canonical.js";
import { SafeError, normalizeSafeError } from "./errors.js";
import { ensureSecureRoot } from "./paths.js";
import { MemorySecretRegistry, assertPersistenceSafe, assertSerializedPersistenceSafe } from "./secrets.js";
import { decodeSha256,                                                         } from "./types.js";

                                              
                                                                                                                   
                                           
                                                            
 

                                       
                           
                                            
                                                                 
 

                             
                                                                         
                                         
 

                                                                                    

const MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"]);

export function detectMagicType(bytes            )            {
  const b = bytes;
  if (b.length >= 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", extension: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg" };
  if (b.length >= 6 && (Buffer.from(b.subarray(0, 6)).toString("ascii") === "GIF87a" || Buffer.from(b.subarray(0, 6)).toString("ascii") === "GIF89a")) return { mimeType: "image/gif", extension: "gif" };
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("ascii") === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  if (b.length >= 16 && Buffer.from(b.subarray(4, 8)).toString("ascii") === "ftyp") {
    const boxLength = Buffer.from(b.subarray(0, 4)).readUInt32BE(0);
    if (boxLength >= 16 && boxLength <= b.length) {
      const brands = [Buffer.from(b.subarray(8, 12)).toString("ascii")];
      for (let offset = 16; offset + 4 <= boxLength; offset += 4) brands.push(Buffer.from(b.subarray(offset, offset + 4)).toString("ascii"));
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

async function fsyncDirectory(directory        )                {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAll(handle                                  , chunk            )                {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten <= 0) throw new SafeError("CANONICAL_INTEGRITY", "object write failed");
    offset += result.bytesWritten;
  }
}

export async function* readableStreamToAsync(stream                            )                            {
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally { reader.releaseLock(); }
}

                                                                                                
const OBJECT_STORE_IDENTITIES = new WeakMap                             ();
const OBJECT_REF_ISSUERS = new WeakMap                ();

export class FileContentAddressedObjectStore                                        {
           root        ;
           registry                      ;

  constructor(root        , registry = new MemorySecretRegistry()) {
    this.root = root;
    this.registry = registry;
    OBJECT_STORE_IDENTITIES.set(this, Object.freeze({ root: path.resolve(root), registry }));
    Object.freeze(this);
  }

  owns(ref           )          { return OBJECT_REF_ISSUERS.get(ref) === this; }

  async initialize()                {
    const trusted = await ensureSecureRoot(this.root);
    const objects = path.join(trusted, "objects");
    const sha = path.join(objects, "sha256");
    await mkdir(objects, { mode: 0o700 }).catch((error) => { if ((error                         ).code !== "EEXIST") throw error; });
    await mkdir(sha, { mode: 0o700 }).catch((error) => { if ((error                         ).code !== "EEXIST") throw error; });
    for (const candidate of [objects, sha]) {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object directory");
    }
  }

  objectPath(hash        )         {
    const digest = decodeSha256(hash);
    return path.join(this.root, "objects", "sha256", digest.slice(0, 2), digest);
  }

  async put(bytes                           , suggestedMimeType               , signal             )                     {
    if (signal.aborted) throw new SafeError("STATE", "object write aborted");
    await this.initialize();
    if (suggestedMimeType !== null) assertPersistenceSafe(suggestedMimeType, this.registry);
    const staging = path.join(this.root, "objects", "sha256", ".staging");
    await mkdir(staging, { mode: 0o700 }).catch((error) => { if ((error                         ).code !== "EEXIST") throw error; });
    const stagingInfo = await lstat(staging);
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory() || stagingInfo.uid !== process.getuid?.() || (stagingInfo.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object staging directory");
    const temp = path.join(staging, `${randomBytes(16).toString("hex")}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    let scanTail = Buffer.alloc(0);
    try {
      for await (const raw of bytes) {
        if (signal.aborted) throw new SafeError("STATE", "object write aborted");
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const scanBytes = Buffer.concat([scanTail, Buffer.from(chunk)]);
        assertSerializedPersistenceSafe(scanBytes, this.registry);
        scanTail = scanBytes.subarray(Math.max(0, scanBytes.byteLength - this.registry.scanWindowSize));
        await writeAll(handle, chunk);
        hash.update(chunk);
        byteLength += chunk.byteLength;
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temp).catch(() => {});
      throw normalizeSafeError(error, "CANONICAL_INTEGRITY", "object source failed");
    }
    await handle.close();
    if (signal.aborted) { await unlink(temp).catch(() => {}); throw new SafeError("STATE", "object write aborted"); }
    try {
      const digest = decodeSha256(hash.digest("hex"));
      const tempHandle = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      let fullBytes            ;
      try { fullBytes = await tempHandle.readFile(); } finally { await tempHandle.close(); }
      const magic = detectMagicType(fullBytes);
      const ref            = Object.freeze({ sha256: digest, byteLength, mimeType: magic.mimeType });
      const directory = path.join(this.root, "objects", "sha256", digest.slice(0, 2));
      await mkdir(directory, { mode: 0o700 }).catch((error) => { if ((error                         ).code !== "EEXIST") throw error; });
      const dirInfo = await lstat(directory);
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || dirInfo.uid !== process.getuid?.() || (dirInfo.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe object bucket");
      const target = this.objectPath(digest);
      await chmod(temp, 0o400);
      try {
        await link(temp, target);
        await fsyncDirectory(directory);
      } catch (error) {
        if ((error                         ).code !== "EEXIST") throw normalizeSafeError(error, "CANONICAL_INTEGRITY", "object publish failed");
        if (!(await this.verify(ref))) throw new SafeError("CANONICAL_INTEGRITY", "existing object failed verification");
      }
      if (!(await this.verify(ref))) throw new SafeError("CANONICAL_INTEGRITY", "published object failed verification");
      OBJECT_REF_ISSUERS.set(ref, this);
      return ref;
    } catch (error) {
      throw normalizeSafeError(error, "CANONICAL_INTEGRITY", "object finalization failed");
    } finally {
      await unlink(temp).catch(() => {});
      await fsyncDirectory(staging).catch(() => {});
    }
  }

  async verify(ref           )                   {
    try { await this.#readVerified(ref); return true; } catch { return false; }
  }

  async open(ref           )                                      {
    const bytes = await this.#readVerified(ref);
    return new ReadableStream            ({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async readBytes(ref           )                      {
    return this.#readVerified(ref);
  }

  async #readVerified(ref           )                      {
    decodeSha256(ref.sha256);
    await this.initialize();
    const bucket = path.join(this.root, "objects", "sha256", ref.sha256.slice(0, 2));
    const bucketInfo = await lstat(bucket);
    if (bucketInfo.isSymbolicLink() || !bucketInfo.isDirectory() || bucketInfo.uid !== process.getuid?.() || (bucketInfo.mode & 0o777) !== 0o700) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object bucket");
    const target = this.objectPath(ref.sha256);
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.()) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object file");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size !== ref.byteLength) throw new SafeError("CANONICAL_INTEGRITY", "object metadata mismatch");
      const content = await handle.readFile();
      if (sha256Bytes(content) !== ref.sha256 || detectMagicType(content).mimeType !== ref.mimeType) throw new SafeError("CANONICAL_INTEGRITY", "object digest mismatch");
      assertSerializedPersistenceSafe(content, this.registry);
      return content;
    } finally { await handle.close(); }
  }

  verifySync(ref           )          {
    try { this.readBytesSync(ref); return true; } catch { return false; }
  }

  readBytesSync(ref           )             {
    decodeSha256(ref.sha256);
    const components = [this.root, path.join(this.root, "objects"), path.join(this.root, "objects", "sha256"), path.join(this.root, "objects", "sha256", ref.sha256.slice(0, 2))];
    for (const [index, candidate] of components.entries()) {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object ancestor");
      if (index === 0 && path.resolve(candidate) !== path.resolve(this.root)) throw new SafeError("CANONICAL_INTEGRITY", "object root mismatch");
    }
    const target = this.objectPath(ref.sha256);
    const before = lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.()) throw new SafeError("CANONICAL_INTEGRITY", "unsafe object file");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = fstatSync(fd);
      const content = readFileSync(fd);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || content.byteLength !== ref.byteLength || sha256Bytes(content) !== ref.sha256 || detectMagicType(content).mimeType !== ref.mimeType) throw new SafeError("CANONICAL_INTEGRITY", "object verification failed");
      assertSerializedPersistenceSafe(content, this.registry);
      return content;
    } finally { closeSync(fd); }
  }
}

export class FileMediaStore                       {
           objects                                 ;
  constructor(objects                                 ) { this.objects = objects; }

  async put(source                      , signal             )                 {
    if (!Number.isSafeInteger(source.slot.ordinal) || source.slot.ordinal <= 0 || !["cover", "image", "video"].includes(source.slot.kind)) throw new SafeError("INVALID_INPUT", "invalid media slot");
    const stream = await source.open(signal);
    const object = await this.objects.put(readableStreamToAsync(stream), source.suggestedMimeType, signal);
    const extension = detectMagicType(await this.objects.readBytes(object)).extension;
    if (!["png", "jpg", "gif", "webp", "mp4"].includes(extension)) throw new SafeError("INVALID_INPUT", "media source has unsupported magic bytes");
    return Object.freeze({ mediaId: `${source.slot.kind}-${source.slot.ordinal}-${object.sha256}`, kind: source.slot.kind, ordinal: source.slot.ordinal, status: "stored", extension, object });
  }

  async verify(media       )                   {
    return media.status === "stored" && media.object !== null && media.extension === detectMagicType(await this.objects.readBytes(media.object)).extension && await this.objects.verify(media.object);
  }
}

export async function* bytesIterable(bytes            )                            { yield bytes; }
