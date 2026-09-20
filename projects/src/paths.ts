import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SafeError } from "./errors.ts";
import { type RelativePath } from "./types.ts";

function identity(value: string): string { return value.normalize("NFC").toLocaleLowerCase("en-US"); }

export function decodeRelativePath(value: unknown): RelativePath {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || /^[A-Za-z]:\//u.test(value)
    || /[\\\u0000-\u001f\u007f]/u.test(value)) throw new SafeError("INVALID_INPUT", "invalid relative path");
  const normalized = value.normalize("NFC");
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part !== part.normalize("NFC"))) throw new SafeError("INVALID_INPUT", "invalid relative path");
  return parts.join("/") as RelativePath;
}

async function assertDirectoryNoFollow(candidate: string): Promise<void> {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe path ancestor");
}

async function rejectIdentityCollision(parent: string, next: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const wanted = identity(next);
  for (const entry of entries) {
    if (identity(entry) === wanted && entry !== next) throw new SafeError("SECURITY_BOUNDARY", "Unicode or case path collision");
  }
}

export async function ensureSecureRoot(root: string): Promise<string> {
  if (root.includes("\0") || !path.isAbsolute(root)) throw new SafeError("INVALID_INPUT", "root must be absolute");
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const identities: Array<{ readonly path: string; readonly dev: number; readonly ino: number }> = [];
  let current = parsed.root;
  const inspect = async (candidate: string, rootDirectory: boolean): Promise<void> => {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SafeError("SECURITY_BOUNDARY", "root path contains a symlink or non-directory ancestor");
    if (rootDirectory && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)) throw new SafeError("SECURITY_BOUNDARY", "unsafe root permissions");
    identities.push(Object.freeze({ path: candidate, dev: info.dev, ino: info.ino }));
  };
  await inspect(current, false);
  for (const [index, component] of components.entries()) {
    await rejectIdentityCollision(current, component);
    current = path.join(current, component);
    try { await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 }).catch((mkdirError) => { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; });
    }
    await inspect(current, index === components.length - 1);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new SafeError("SECURITY_BOUNDARY", "root path identity is not canonical");
  for (const expected of identities) {
    const info = await lstat(expected.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino) throw new SafeError("SECURITY_BOUNDARY", "root ancestor changed during validation");
  }
  return resolved;
}

export async function resolveUnderRoot(root: string, relative: RelativePath, createParents = false): Promise<string> {
  const trustedRoot = await ensureSecureRoot(root);
  const parts = relative.split("/");
  let current = trustedRoot;
  await assertDirectoryNoFollow(current);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    await rejectIdentityCollision(current, part);
    const next = path.join(current, part);
    if (createParents) await mkdir(next, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await assertDirectoryNoFollow(next);
    current = next;
  }
  await rejectIdentityCollision(current, parts.at(-1)!);
  const result = path.join(current, parts.at(-1)!);
  if (!result.startsWith(`${trustedRoot}${path.sep}`)) throw new SafeError("SECURITY_BOUNDARY", "path escaped root");
  return result;
}

const managedRoots = new Set<string>();

/** Resolve a path produced by the archive itself. External paths use resolveUnderRoot. */
export async function resolveManagedPath(root: string, relativeInput: string, createParents = false): Promise<string> {
  const relative = decodeRelativePath(relativeInput);
  if (!/^[a-z0-9./_-]+$/.test(relative)) throw new SafeError("SECURITY_BOUNDARY", "invalid managed path");
  const resolved = path.resolve(root);
  if (!managedRoots.has(resolved)) { await ensureSecureRoot(root); managedRoots.add(resolved); }
  await assertDirectoryNoFollow(resolved);
  const parts = relative.split("/");
  let current = resolved;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (createParents) await mkdir(current, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await assertDirectoryNoFollow(current);
  }
  return path.join(current, parts.at(-1)!);
}

export async function resolveDigestPath(root: string, relative: string, createParents = false): Promise<string> {
  const parsed = decodeRelativePath(relative);
  const staticParts = new Set(["objects", "sha256", "accounts", "state", "data", "notes", "assets", "logs", ".views", "control"]);
  for (const part of parsed.split("/")) {
    if (!staticParts.has(part) && !/^(?:[0-9a-f]{2}|[0-9a-f]{64}|[0-9]+(?:-[0-9]+)?\.(?:json|jsonl|csv|md|bin|png|jpg|gif|webp|mp4)|[0-9a-f]{64}\.(?:json|md))$/.test(part)) {
      throw new SafeError("SECURITY_BOUNDARY", "non-digest path component blocked");
    }
  }
  return resolveUnderRoot(root, parsed, createParents);
}

export async function openVerifiedInput(root: string, relative: unknown) {
  const target = await resolveUnderRoot(root, decodeRelativePath(relative), false);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new SafeError("SECURITY_BOUNDARY", "input must be a regular file");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "input changed during open");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertRegularNoFollow(target: string): Promise<void> {
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new SafeError("SECURITY_BOUNDARY", "unsafe file");
  const after = await stat(target);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "file identity changed");
}
