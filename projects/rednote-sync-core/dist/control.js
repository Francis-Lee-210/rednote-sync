import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { SafeError, normalizeSafeError } from "./errors.js";
import { decodeRelativePath, resolveUnderRoot } from "./paths.js";
import { MemorySecretRegistry, assertSerializedPersistenceSafe } from "./secrets.js";
import { decodePartitionScope, sameScope, scopeKey,                                        } from "./types.js";

function pauseRelativePath(scope                )               {
  return decodeRelativePath(`control/${scopeKey(scope)}.pause`);
}

function pauseBytes(scope                , registry                      )             {
  const bytes = Buffer.from(`${canonicalJson({ schemaVersion: 1, scope })}\n`, "utf8");
  assertSerializedPersistenceSafe(bytes, registry);
  return bytes;
}

async function readPauseFile(target        , expected                )                   {
  let handle;
  try {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("SECURITY_BOUNDARY", "unsafe pause control file");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "pause control identity changed");
    const parsed = JSON.parse((await handle.readFile()).toString("utf8"))           ;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SafeError("INVALID_INPUT", "invalid pause control");
    const record = parsed                           ;
    if (Object.keys(record).sort().join(",") !== "schemaVersion,scope" || record.schemaVersion !== 1) throw new SafeError("INVALID_INPUT", "invalid pause control");
    const scope = decodePartitionScope(record.scope);
    if (!sameScope(scope, expected)) throw new SafeError("SECURITY_BOUNDARY", "pause control scope mismatch");
    return true;
  } catch (error) {
    if ((error                         ).code === "ENOENT") return false;
    throw normalizeSafeError(error, "INVALID_INPUT", "invalid pause control");
  } finally { await handle?.close().catch(() => {}); }
}

export async function isScopePaused(root        , scopeInput                )                   {
  const scope = decodePartitionScope(scopeInput);
  let target        ;
  try { target = await resolveUnderRoot(root, pauseRelativePath(scope), false); }
  catch (error) { if ((error                         ).code === "ENOENT") return false; throw error; }
  return readPauseFile(target, scope);
}

export async function requestScopePause(root        , scopeInput                , registry = new MemorySecretRegistry())                {
  const scope = decodePartitionScope(scopeInput);
  const target = await resolveUnderRoot(root, pauseRelativePath(scope), true);
  const bytes = pauseBytes(scope, registry);
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if ((error                         ).code === "EEXIST") { if (!await readPauseFile(target, scope)) throw new SafeError("STATE", "pause control disappeared"); return; }
    throw normalizeSafeError(error, "STATE", "pause request failed");
  } finally { await handle?.close().catch(() => {}); }
}

export async function resumeScope(root        , scopeInput                )                {
  const scope = decodePartitionScope(scopeInput);
  let target        ;
  try { target = await resolveUnderRoot(root, pauseRelativePath(scope), false); }
  catch (error) { if ((error                         ).code === "ENOENT") return; throw error; }
  if (!await readPauseFile(target, scope)) return;
  try { await unlink(target); }
  catch (error) { if ((error                         ).code !== "ENOENT") throw normalizeSafeError(error, "STATE", "resume failed"); }
}
