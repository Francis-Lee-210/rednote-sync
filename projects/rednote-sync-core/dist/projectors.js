import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, link, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Bytes, utf8Compare } from "./canonical.js";
import { SafeError } from "./errors.js";
import { publicNoteProjection, renderIndexCsvRow } from "./merge.js";
import { FileContentAddressedObjectStore } from "./object-store.js";
import { decodeRelativePath, ensureSecureRoot, resolveUnderRoot } from "./paths.js";
import { MemorySecretRegistry, assertSerializedPersistenceSafe } from "./secrets.js";
import { businessResultProvenance, projectorTransactionCapability,                                                                     } from "./state-store.js";
import { accountKey, decodeRunRecord, noteKey,                                                                           } from "./types.js";
import { PROJECTOR_ORDER, assertProjectorNamespace,                                                                                                                   } from "./view-types.js";

                                       
                           
                                                                                                                            
 

                                  
                                                  
                               
 

                                                                                                                                                                       
                                                                                                                       
                                                
                                                                   
                         
                         
                                              
                                      
 
                                            
                                                                 
                         
                         
                                                                                         
                                      
 
                                                                            

class ProjectionPaused extends Error { constructor() { super("projection paused"); this.name = "ProjectionPaused"; } }
                           
                                                                     
                                                                                                                
                         
                                                                       
                                                                                                   
                                           
 
const TRUSTED_BOUNDARIES = new WeakMap                       ();
const PAUSED_ERRORS = new WeakSet        ();
const PAUSED_ATTEMPTS = new WeakMap                                         ();

// This capability can only request a rollback; it cannot manufacture projector
// outcomes, receipts, or a commit authorization.
export function createProjectionBoundary(check                                                      , settlementObserver                                                                      = null)                     {
  if (typeof check !== "function") throw new SafeError("STATE", "projection boundary must be callable");
  if (settlementObserver !== null && typeof settlementObserver !== "function") throw new SafeError("STATE", "projection settlement observer must be callable");
  const boundary = Object.freeze({ kind: "projection_boundary"          });
  TRUSTED_BOUNDARIES.set(boundary, { check, settlementObserver, actions: [] });
  return boundary;
}

export function isProjectionPaused(error         )          { return error !== null && typeof error === "object" && PAUSED_ERRORS.has(error); }

function recordAction(boundary                           , action                             )       {
  if (action === null) return;
  if (boundary === null) return;
  const state = TRUSTED_BOUNDARIES.get(boundary);
  if (!state) throw new SafeError("STATE", "untrusted projection boundary");
  state.actions.push(action);
}

export async function restoreProjectionAttempt(error         , root        , observer                                                                          = null)                {
  if (!isProjectionPaused(error)) throw new SafeError("STATE", "untrusted projection pause cleanup");
  if (observer !== null && typeof observer !== "function") throw new SafeError("STATE", "projection recovery observer must be callable");
  const actions = PAUSED_ATTEMPTS.get(error          );
  if (!actions) throw new SafeError("STATE", "projection pause footprint missing");
  const reversed = [...actions].reverse();
  for (const [index, action] of reversed.entries()) {
    await observer?.(Object.freeze({ phase: "before_restore_action"         , index, total: reversed.length, kind: action.kind, relativePath: action.relativePath }));
    await undoProjectionAction(root, action);
    await observer?.(Object.freeze({ phase: "after_restore_action"         , index, total: reversed.length, kind: action.kind, relativePath: action.relativePath }));
  }
  PAUSED_ATTEMPTS.delete(error          );
}

export async function cleanupProjectionAttempt(error         , root        )                {
  return restoreProjectionAttempt(error, root);
}

export async function settleProjectionAttempt(boundary                           , root        )                {
  if (boundary === null) return;
  const state = TRUSTED_BOUNDARIES.get(boundary);
  if (!state) throw new SafeError("STATE", "untrusted projection boundary");
  const cleanup = state.actions.filter((action)                                                                            => action.kind !== "created");
  try {
    for (const [index, action] of cleanup.entries()) {
      await state.settlementObserver?.(Object.freeze({ phase: "before_remove_backup"         , index, total: cleanup.length, kind: action.kind, relativePath: action.relativePath }));
      await removeUndoBackup(root, action);
      await state.settlementObserver?.(Object.freeze({ phase: "after_remove_backup"         , index, total: cleanup.length, kind: action.kind, relativePath: action.relativePath }));
    }
  } catch { throw new SafeError("DERIVED_VIEW", "projection backup settlement failed"); }
  state.actions.length = 0;
}

async function checkpoint(boundary                           , point                         )                {
  if (boundary === null) return;
  const state = TRUSTED_BOUNDARIES.get(boundary);
  if (!state) throw new SafeError("STATE", "untrusted projection boundary");
  let decision         ;
  try { decision = await state.check(Object.freeze(point)); }
  catch (error) {
    if (error instanceof SafeError && (error.code === "CANONICAL_INTEGRITY" || error.code === "SECURITY_BOUNDARY" || error.code === "STATE")) throw error;
    throw new SafeError("STATE", "projection boundary failed");
  }
  if (decision !== true && decision !== false) throw new SafeError("STATE", "invalid projection pause decision");
  if (decision) {
    const error = new ProjectionPaused();
    PAUSED_ERRORS.add(error);
    PAUSED_ATTEMPTS.set(error, Object.freeze([...state.actions]));
    throw error;
  }
}

                                     
                                            
                                  
                              
                                  
                                  
                                 
                                    
                                          
                                        
 
const TRUSTED_BATCHES = new WeakMap                                   ();

export function projectionBatchProvenance(value         , transaction                     )                            {
  if (value === null || typeof value !== "object") throw new SafeError("STATE", "untrusted projection batch");
  const provenance = TRUSTED_BATCHES.get(value);
  const batch = value                   ;
  if (!provenance || provenance.transaction !== transaction || !Array.isArray(batch.outcomes)) throw new SafeError("STATE", "untrusted or foreign projection batch");
  businessResultProvenance(provenance.businessResult, transaction);
  if (provenance.outcomesSha256 !== sha256Bytes(Buffer.from(canonicalJson(batch.outcomes))) || provenance.finalRunSha256 !== sha256Bytes(Buffer.from(canonicalJson(batch.finalRun))) || provenance.summarySha256 !== sha256Bytes(Buffer.from(canonicalJson(provenance.summary))) || provenance.businessResultSha256 !== sha256Bytes(Buffer.from(canonicalJson(provenance.businessResult)))) throw new SafeError("STATE", "projection batch was altered");
  return provenance;
}

                                                                                                                                                             
const TRUSTED_OUTCOMES = new WeakMap                           ();
function issueOutcome                             (issuerId             , outcome   )    {
  const receipts = outcome.receipts ?? [];
  if (outcome.projectorId !== issuerId) throw new SafeError("STATE", "projector outcome issuer mismatch");
  for (const receipt of receipts) {
    if (receipt.projectorId !== issuerId || receipt.accountKey !== outcome.accountKey || receipt.generation !== outcome.generation) throw new SafeError("STATE", "projector receipt provenance mismatch");
    assertProjectorNamespace(outcome.accountKey, issuerId, receipt.relativePath);
  }
  const frozen = Object.freeze(outcome);
  TRUSTED_OUTCOMES.set(frozen, Object.freeze({ issuerId, accountKey: outcome.accountKey, generation: outcome.generation, receiptsSha256: sha256Bytes(Buffer.from(canonicalJson(receipts))) }));
  return frozen;
}
export function assertTrustedProjectionOutcome(value         , expected                                                                                                      )                                     {
  if (value === null || typeof value !== "object") throw new SafeError("STATE", "untrusted projection outcome");
  const provenance = TRUSTED_OUTCOMES.get(value);
  const outcome = value                     ;
  const receipts = outcome.receipts ?? [];
  if (!provenance || provenance.issuerId !== outcome.projectorId || provenance.accountKey !== outcome.accountKey || provenance.generation !== outcome.generation || provenance.receiptsSha256 !== sha256Bytes(Buffer.from(canonicalJson(receipts)))) throw new SafeError("STATE", "untrusted projection outcome");
  if (expected && (provenance.issuerId !== expected.projectorId || provenance.accountKey !== expected.accountKey || provenance.generation !== expected.generation)) throw new SafeError("STATE", "projection outcome provenance mismatch");
}

function readSafeDerivedSync(root        , relative              )             {
  const resolvedRoot = path.resolve(root);
  const rootInfo = lstatSync(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived root");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new SafeError("SECURITY_BOUNDARY", "derived receipt escaped root");
  let cursor = resolvedRoot;
  for (const part of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived ancestor");
  }
  const before = lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived receipt file");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "derived receipt identity changed");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function assertProjectionMaterialized(outcome                   , root        )       {
  assertTrustedProjectionOutcome(outcome);
  const receipts = outcome.receipts ?? [];
  for (const receipt of receipts) {
    assertProjectorNamespace(outcome.accountKey, outcome.projectorId, receipt.relativePath);
    if (!receipt.relativePath.startsWith(`accounts/${outcome.accountKey}/`)) throw new SafeError("STATE", "projection receipt account path mismatch");
    const bytes = readSafeDerivedSync(root, receipt.relativePath);
    if (bytes.byteLength !== receipt.byteLength || sha256Bytes(bytes) !== receipt.sha256) throw new SafeError("STATE", "projection receipt verification failed");
  }
  if (outcome.complete) {
    const markerPath = decodeRelativePath(`accounts/${outcome.accountKey}/.views/${outcome.projectorId}.generation.json`);
    let marker                         ;
    try { marker = JSON.parse(Buffer.from(readSafeDerivedSync(root, markerPath)).toString("utf8"))                           ; }
    catch { throw new SafeError("STATE", "projection marker is invalid"); }
    if (marker === null || typeof marker !== "object" || Array.isArray(marker) || canonicalJson(Object.keys(marker).sort(utf8Compare)) !== canonicalJson(["accountKey", "generation", "projectorId", "receipts"].sort(utf8Compare))) throw new SafeError("STATE", "projection marker shape mismatch");
    if (marker.accountKey !== outcome.accountKey || marker.projectorId !== outcome.projectorId || marker.generation !== outcome.generation || canonicalJson(marker.receipts) !== canonicalJson(receipts)) throw new SafeError("STATE", "projection marker verification failed");
  }
}

function csvCell(value         )         {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function fsyncDirectory(directory        )                {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function digestFileNoFollow(target        )                                                                            {
  let handle;
  try {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.()) throw new SafeError("SECURITY_BOUNDARY", "derived target is not a safe regular file");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) throw new SafeError("SECURITY_BOUNDARY", "derived target identity changed");
    const bytes = await handle.readFile();
    return { hash: sha256Bytes(bytes), length: bytes.byteLength, safeStandalone: before.nlink === 1 && (before.mode & 0o777) === 0o600 };
  } catch (error) {
    if ((error                         ).code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

                        
                                  
                                
                                                               

const UNDO_BACKUP_RE = /^\.rednote-sync-undo-[0-9a-f]{24}\.bak$/;

async function validateUndoBackup(target        , backupPath        )                {
  if (path.dirname(backupPath) !== path.dirname(target) || !UNDO_BACKUP_RE.test(path.basename(backupPath))) throw new SafeError("STATE", "invalid projection undo backup");
  const before = await lstat(backupPath);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("SECURITY_BOUNDARY", "unsafe projection undo backup");
  const handle = await open(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "projection undo backup identity changed");
  } finally { await handle.close(); }
}

async function createUndoBackup(target        )                  {
  const directory = path.dirname(target);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const backupPath = path.join(directory, `.rednote-sync-undo-${randomBytes(12).toString("hex")}.bak`);
    try {
      await link(target, backupPath);
      const targetInfo = await lstat(target);
      const backupInfo = await lstat(backupPath);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.uid !== process.getuid?.() || (targetInfo.mode & 0o777) !== 0o600 || targetInfo.nlink !== 2 || backupInfo.dev !== targetInfo.dev || backupInfo.ino !== targetInfo.ino || backupInfo.nlink !== 2) {
        await unlink(backupPath).catch(() => {});
        throw new SafeError("SECURITY_BOUNDARY", "unsafe projection replacement source");
      }
      return backupPath;
    } catch (error) {
      if ((error                         ).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new SafeError("STATE", "projection undo backup collision");
}

async function atomicStableWrite(root        , relative              , bytes            , registry                      , reversible         )                             {
  assertSerializedPersistenceSafe(bytes, registry);
  const target = await resolveUnderRoot(root, relative, true);
  const desiredHash = sha256Bytes(bytes);
  const existing = await digestFileNoFollow(target);
  if (existing && reversible && !existing.safeStandalone) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived replacement target");
  if (existing && existing.safeStandalone && existing.hash === desiredHash && existing.length === bytes.byteLength) return { kind: "unchanged" };
  const directory = path.dirname(target);
  const temp = path.join(directory, `.${path.basename(target)}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset);
      if (result.bytesWritten <= 0) throw new SafeError("DERIVED_VIEW", "derived write failed");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(temp, 0o600);
  let backupPath                = null;
  try {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || reversible && ((info.mode & 0o777) !== 0o600 || info.nlink !== 1)) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived replacement target");
    } catch (error) { if ((error                         ).code !== "ENOENT") throw error; }
    if (existing && reversible) backupPath = await createUndoBackup(target);
    await rename(temp, target);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (backupPath !== null) await unlink(backupPath).catch(() => {});
    throw error;
  }
  if (!existing) return { kind: "created" };
  if (!backupPath) return { kind: "replaced", backupPath: "" };
  return { kind: "replaced", backupPath };
}

async function safeDeleteDerived(root        , relative              , reversible         )                                       {
  const target = await resolveUnderRoot(root, relative, false);
  let handle;
  try {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("SECURITY_BOUNDARY", "unsafe stale derived file");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) throw new SafeError("SECURITY_BOUNDARY", "stale derived identity changed");
    await handle.close();
    handle = undefined;
    if (reversible) {
      const backupPath = path.join(path.dirname(target), `.rednote-sync-undo-${randomBytes(12).toString("hex")}.bak`);
      await rename(target, backupPath);
      await validateUndoBackup(target, backupPath);
      await fsyncDirectory(path.dirname(target));
      return { kind: "deleted", relativePath: relative, backupPath };
    }
    await unlink(target);
    await fsyncDirectory(path.dirname(target));
  } catch (error) {
    if ((error                         ).code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close().catch(() => {}); }
  return null;
}

async function removeUndoBackup(root        , action                                                                 )                {
  const target = await resolveUnderRoot(root, action.relativePath, false);
  await validateUndoBackup(target, action.backupPath);
  await unlink(action.backupPath);
  await fsyncDirectory(path.dirname(target));
}

async function undoProjectionAction(root        , action                      )                {
  const target = await resolveUnderRoot(root, action.relativePath, false);
  if (action.kind === "created") {
    await safeDeleteDerived(root, action.relativePath, false);
    return;
  }
  await validateUndoBackup(target, action.backupPath);
  if (action.kind === "replaced") await safeDeleteDerived(root, action.relativePath, false);
  else {
    try { await lstat(target); throw new SafeError("STATE", "deleted projection target was recreated"); }
    catch (error) { if ((error                         ).code !== "ENOENT") throw error; }
  }
  await rename(action.backupPath, target);
  await fsyncDirectory(path.dirname(target));
}

                                                                                                                                      

async function inspectAbandonedBackup(target        )                                    {
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("SECURITY_BOUNDARY", "unsafe abandoned projection backup");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.uid !== process.getuid?.() || (after.mode & 0o777) !== 0o600 || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("SECURITY_BOUNDARY", "abandoned projection backup identity changed");
  } finally { await handle.close(); }
  return Object.freeze({ target, directory: path.dirname(target), dev: before.dev, ino: before.ino });
}

async function managedDirectoryEntries(directory        )                                                                                                                           {
  const rootInfo = await lstat(directory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived directory");
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => utf8Compare(a.name, b.name))) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new SafeError("SECURITY_BOUNDARY", "symlink in derived account layout");
    entries.push(Object.freeze({ name: entry.name, target, info }));
  }
  return Object.freeze(entries);
}

async function cleanupAbandonedUndoBackups(root        , key            )                {
  const accountRoot = await resolveUnderRoot(root, decodeRelativePath(`accounts/${key}`), true);
  const candidates                             = [];
  const fixedLeafDirectories           = [];
  let notesDirectory                = null;
  let assetsDirectory                = null;
  let dataDirectory                = null;
  const allowedTopDirectories = new Set(["notes", "assets", "data", "logs", ".views"]);
  let accountEntries                                                     ;
  try { accountEntries = await managedDirectoryEntries(accountRoot); }
  catch (error) {
    if ((error                         ).code === "ENOENT") return;
    throw error;
  }
  for (const entry of accountEntries) {
    if (entry.info.isDirectory()) {
      if (!allowedTopDirectories.has(entry.name)) throw new SafeError("SECURITY_BOUNDARY", "unknown directory in derived account layout");
      if (entry.info.uid !== process.getuid?.() || (entry.info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived directory");
      if (entry.name === "notes") notesDirectory = entry.target;
      else if (entry.name === "assets") assetsDirectory = entry.target;
      else if (entry.name === "data") dataDirectory = entry.target;
      else fixedLeafDirectories.push(entry.target);
      continue;
    }
    if (UNDO_BACKUP_RE.test(entry.name)) candidates.push(await inspectAbandonedBackup(entry.target));
  }
  if (notesDirectory !== null) fixedLeafDirectories.push(notesDirectory);
  if (dataDirectory !== null) {
    for (const entry of await managedDirectoryEntries(dataDirectory)) {
      if (entry.info.isDirectory()) {
        if (entry.name !== "notes") throw new SafeError("SECURITY_BOUNDARY", "unknown directory in derived data layout");
        fixedLeafDirectories.push(entry.target);
      } else if (UNDO_BACKUP_RE.test(entry.name)) candidates.push(await inspectAbandonedBackup(entry.target));
    }
  }
  if (assetsDirectory !== null) {
    for (const entry of await managedDirectoryEntries(assetsDirectory)) {
      if (!entry.info.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
        if (UNDO_BACKUP_RE.test(entry.name)) throw new SafeError("SECURITY_BOUNDARY", "projection backup is outside a legal directory");
        if (entry.info.isDirectory()) throw new SafeError("SECURITY_BOUNDARY", "unknown directory in derived assets layout");
        continue;
      }
      fixedLeafDirectories.push(entry.target);
    }
  }
  for (const directory of fixedLeafDirectories) {
    for (const entry of await managedDirectoryEntries(directory)) {
      if (entry.info.isDirectory()) throw new SafeError("SECURITY_BOUNDARY", "unknown nested directory in derived layout");
      if (UNDO_BACKUP_RE.test(entry.name)) candidates.push(await inspectAbandonedBackup(entry.target));
    }
  }
  for (const candidate of candidates) {
    const current = await inspectAbandonedBackup(candidate.target);
    if (current.dev !== candidate.dev || current.ino !== candidate.ino) throw new SafeError("SECURITY_BOUNDARY", "abandoned projection backup changed before cleanup");
  }
  for (const candidate of candidates) await unlink(candidate.target);
  for (const directory of [...new Set(candidates.map((candidate) => candidate.directory))].sort(utf8Compare)) await fsyncDirectory(directory);
}

async function cleanupUnexpectedProjectedFiles(root        , key            , id             , expected                           , boundary                           )                {
  const boundaryState = boundary === null ? null : TRUSTED_BOUNDARIES.get(boundary);
  if (boundary !== null && !boundaryState) throw new SafeError("STATE", "untrusted projection boundary");
  const roots = id === "notes"
    ? [decodeRelativePath(`accounts/${key}/notes`), decodeRelativePath(`accounts/${key}/data/notes`)]
    : id === "assets"
      ? [decodeRelativePath(`accounts/${key}/assets`)]
      : [];
  for (const relativeRoot of roots) {
    let absoluteRoot        ;
    try { absoluteRoot = await resolveUnderRoot(root, relativeRoot, false); }
    catch (error) {
      if ((error                         ).code === "ENOENT") continue;
      throw error;
    }
    try {
      const info = await lstat(absoluteRoot);
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe projector tree root");
    } catch (error) {
      if ((error                         ).code === "ENOENT") continue;
      throw error;
    }
    const pending = [absoluteRoot];
    let visited = 0;
    while (pending.length > 0) {
      const directory = pending.pop() ;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 100_000) throw new SafeError("STATE", "projector tree is too large");
        const target = path.join(directory, entry.name);
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new SafeError("SECURITY_BOUNDARY", "symlink in projector tree");
        if (info.isDirectory()) {
          if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe projector tree directory");
          pending.push(target);
          continue;
        }
        if (UNDO_BACKUP_RE.test(entry.name)) {
          const action = boundaryState?.actions.find((candidate)                                                                               => candidate.kind !== "created" && candidate.backupPath === target);
          if (!action) throw new SafeError("SECURITY_BOUNDARY", "unexpected projection backup in managed tree");
          await validateUndoBackup(await resolveUnderRoot(root, action.relativePath, false), target);
          continue;
        }
        const relative = decodeRelativePath(path.relative(path.resolve(root), target).split(path.sep).join("/"));
        assertProjectorNamespace(key, id, relative);
        if (!expected.has(relative)) recordAction(boundary, await safeDeleteDerived(root, relative, boundary !== null));
      }
    }
  }
}

                                                                                        

                                                                                                                                                                                                          
const PROJECTOR_IDENTITIES = new WeakMap                           ();
function projectorIdentity(projector        )                    { const identity = PROJECTOR_IDENTITIES.get(projector); if (!identity) throw new SafeError("STATE", "untrusted projector instance"); return identity; }

         class BaseProjector                                 {
           root        ;
           objects                                 ;
           registry                      ;
           failForTest         ;
  constructor(id             , root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { this.root = root; this.objects = objects; this.registry = registry; this.failForTest = failForTest; PROJECTOR_IDENTITIES.set(this, Object.freeze({ id, root, objects, registry, failForTest })); }
  get id()              { return projectorIdentity(this).id; }
                                                                                                                                              

  async project(snapshot                     , account                  , context                   )                             {
    return runProjector(this, snapshot, account, context, null);
  }
}

async function runProjector(projector               , snapshot                     , account                  , context                   , boundary                           )                             {
    const identity = projectorIdentity(projector);
    const id = identity.id;
    const key = accountKey(account);
    const receipts                       = [];
    await checkpoint(boundary, { projectorId: id, phase: "before_projector" });
    let outcome                   ;
    try {
      const capability = projectorTransactionCapability(snapshot, account);
      if (identity.objects !== capability.objects || identity.registry !== capability.objects.registry) throw new SafeError("STATE", "projector object-store capability mismatch");
      if (!Number.isSafeInteger(context.plannedGeneration) || context.plannedGeneration !== capability.generation + 1) throw new SafeError("STATE", "projector generation mismatch");
      if (id === "runs" ? context.pendingRun === null : context.pendingRun !== null) throw new SafeError("STATE", "projector pending run mismatch");
      if (identity.failForTest) throw new SafeError("DERIVED_VIEW", "injected projector failure");
      await ensureSecureRoot(identity.root);
      const previous = capability.views.find((row) => row.projectorId === id)?.receipts ?? [];
      for (const old of previous) assertProjectorNamespace(key, id, old.relativePath);
      const renderer = INTERNAL_RENDERERS.get(id);
      if (!renderer) throw new SafeError("STATE", "projector renderer missing");
      const files = await renderer.call(projector, capability.view, context, boundary);
      for (const file of files) assertProjectorNamespace(key, id, file.relativePath);
      for (const file of files) {
        await checkpoint(boundary, { projectorId: id, phase: "before_stable_file" });
        const write = await atomicStableWrite(identity.root, file.relativePath, file.bytes, identity.registry, boundary !== null);
        if (write.kind === "created") recordAction(boundary, { kind: "created", relativePath: file.relativePath });
        if (write.kind === "replaced" && boundary !== null) {
          if (!write.backupPath) throw new SafeError("STATE", "projection replacement is not reversible");
          recordAction(boundary, { kind: "replaced", relativePath: file.relativePath, backupPath: write.backupPath });
        }
        receipts.push(Object.freeze({ projectorId: id, accountKey: key, generation: context.plannedGeneration, relativePath: file.relativePath, sha256: sha256Bytes(file.bytes)                               , byteLength: file.bytes.byteLength }));
        await checkpoint(boundary, { projectorId: id, phase: "after_stable_file" });
      }
      receipts.sort((a, b) => utf8Compare(a.relativePath, b.relativePath));
      const expected = new Set(receipts.map((receipt) => receipt.relativePath));
      for (const old of previous) if (!expected.has(old.relativePath)) {
        assertProjectorNamespace(key, id, old.relativePath);
        await checkpoint(boundary, { projectorId: id, phase: "before_stable_file" });
        recordAction(boundary, await safeDeleteDerived(identity.root, old.relativePath, boundary !== null));
        await checkpoint(boundary, { projectorId: id, phase: "after_stable_file" });
      }
      await cleanupUnexpectedProjectedFiles(identity.root, key, id, expected, boundary);
      const markerPath = decodeRelativePath(`accounts/${key}/.views/${id}.generation.json`);
      const marker = Buffer.from(`${canonicalJson({ accountKey: key, projectorId: id, generation: context.plannedGeneration, receipts })}\n`, "utf8");
      await checkpoint(boundary, { projectorId: id, phase: "before_stable_file" });
      const markerWrite = await atomicStableWrite(identity.root, markerPath, marker, identity.registry, boundary !== null);
      if (markerWrite.kind === "created") recordAction(boundary, { kind: "created", relativePath: markerPath });
      if (markerWrite.kind === "replaced" && boundary !== null) {
        if (!markerWrite.backupPath) throw new SafeError("STATE", "projection marker replacement is not reversible");
        recordAction(boundary, { kind: "replaced", relativePath: markerPath, backupPath: markerWrite.backupPath });
      }
      await checkpoint(boundary, { projectorId: id, phase: "after_stable_file" });
      outcome = issueOutcome(id, { projectorId: id, accountKey: key, generation: context.plannedGeneration, complete: true, receipts: Object.freeze(receipts), safeError: null });
    } catch (error) {
      if (isProjectionPaused(error)) throw error;
      if (error instanceof SafeError && (error.code === "CANONICAL_INTEGRITY" || error.code === "SECURITY_BOUNDARY" || error.code === "STATE")) throw error;
      outcome = issueOutcome(id, { projectorId: id, accountKey: key, generation: context.plannedGeneration, complete: false, receipts: Object.freeze(receipts), safeError: `projector ${id} failed` });
    }
    await checkpoint(boundary, { projectorId: id, phase: "after_projector" });
    return outcome;
}

export class NotesProjector extends BaseProjector {
  constructor(root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { super("notes", root, objects, registry, failForTest); Object.freeze(this); }
  async render(view                   , _context                   , boundary                           )                                   {
    const key = accountKey(view.account);
    const files                 = [];
    for (const manifest of view.manifests()) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      const digest = noteKey(view.account, manifest.noteId);
      files.push({ relativePath: decodeRelativePath(`accounts/${key}/notes/${digest}.md`), bytes: await this.objects.readBytes(manifest.artifacts.markdown) });
      files.push({ relativePath: decodeRelativePath(`accounts/${key}/data/notes/${digest}.json`), bytes: await this.objects.readBytes(manifest.artifacts.json) });
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    return files;
  }
}

export class AssetsProjector extends BaseProjector {
  constructor(root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { super("assets", root, objects, registry, failForTest); Object.freeze(this); }
  async render(view                   , _context                   , boundary                           )                                   {
    const key = accountKey(view.account);
    const files                 = [];
    for (const manifest of view.manifests()) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      const digest = noteKey(view.account, manifest.noteId);
      for (const slot of manifest.mediaSlots) {
        await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
        if (slot.tombstone || slot.media?.status !== "stored" || slot.media.object === null) continue;
        const extension = slot.media.extension;
        if (!extension || !/^[a-z0-9]{1,8}$/.test(extension)) throw new SafeError("DERIVED_VIEW", "invalid media extension");
        files.push({ relativePath: decodeRelativePath(`accounts/${key}/assets/${digest}/${slot.slot.kind}-${slot.slot.ordinal}.${extension}`), bytes: await this.objects.readBytes(slot.media.object) });
        await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
      }
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    return files;
  }
}

export class IndexProjector extends BaseProjector {
  constructor(root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { super("index", root, objects, registry, failForTest); Object.freeze(this); }
  async render(view                   , _context                   , boundary                           )                                   {
    const key = accountKey(view.account);
    const manifests = [...view.manifests()].sort((a, b) => utf8Compare(a.hostId, b.hostId) || utf8Compare(a.accountId, b.accountId) || utf8Compare(a.noteId, b.noteId));
    const entries = [];
    for (const manifest of manifests) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      entries.push(publicNoteProjection(manifest.canonicalNote));
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    const json = Buffer.from(`${canonicalJson(entries)}\n`, "utf8");
    const header = ["host_id", "account_id", "note_id", "title", "public_url", "content_hash"];
    const rows           = [];
    for (const manifest of manifests) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      rows.push(renderIndexCsvRow(manifest.canonicalNote));
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    const csv = Buffer.from(`${header.map(csvCell).join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`, "utf8");
    const account = Buffer.from(`${canonicalJson({ schemaVersion: 1, hostId: view.account.hostId, accountId: view.account.accountId })}\n`, "utf8");
    return [
      { relativePath: decodeRelativePath(`accounts/${key}/account.json`), bytes: account },
      { relativePath: decodeRelativePath(`accounts/${key}/data/index.json`), bytes: json },
      { relativePath: decodeRelativePath(`accounts/${key}/data/index.csv`), bytes: csv },
    ];
  }
}

export class FailuresProjector extends BaseProjector {
  constructor(root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { super("failures", root, objects, registry, failForTest); Object.freeze(this); }
  async render(view                   , _context                   , boundary                           )                                   {
    const key = accountKey(view.account);
    const failures = [];
    for (const failure of view.failures()) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      failures.push(failure);
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    return [{ relativePath: decodeRelativePath(`accounts/${key}/data/failures.json`), bytes: Buffer.from(`${canonicalJson(failures)}\n`, "utf8") }];
  }
}

export class RunsProjector extends BaseProjector {
  constructor(root        , objects                                 , registry = new MemorySecretRegistry(), failForTest = false) { super("runs", root, objects, registry, failForTest); Object.freeze(this); }
  async render(view                   , context                   , boundary                           )                                   {
    if (!context.pendingRun) throw new SafeError("STATE", "runs projector requires pending run");
    const key = accountKey(view.account);
    const runs = [];
    for (const run of [...view.runs(), context.pendingRun]) {
      await checkpoint(boundary, { projectorId: this.id, phase: "before_render_item" });
      runs.push(run);
      await checkpoint(boundary, { projectorId: this.id, phase: "after_render_item" });
    }
    runs.sort((a, b) => utf8Compare(`${a.finishedAt}\0${a.runId}`, `${b.finishedAt}\0${b.runId}`));
    const bytes = Buffer.from(runs.map((run) => canonicalJson(run)).join("\n") + "\n", "utf8");
    return [{ relativePath: decodeRelativePath(`accounts/${key}/logs/export-runs.jsonl`), bytes }];
  }
}

                                                                                                                                                                            
const INTERNAL_RENDERERS = new Map                               ([
  ["notes", NotesProjector.prototype.render],
  ["assets", AssetsProjector.prototype.render],
  ["index", IndexProjector.prototype.render],
  ["failures", FailuresProjector.prototype.render],
  ["runs", RunsProjector.prototype.render],
]);

export function createProjectors(root        , objects                                 , registry = objects.registry, failId                     = null)                                                                                               {
  return [new NotesProjector(root, objects, registry, failId === "notes"), new AssetsProjector(root, objects, registry, failId === "assets"), new IndexProjector(root, objects, registry, failId === "index"), new FailuresProjector(root, objects, registry, failId === "failures"), new RunsProjector(root, objects, registry, failId === "runs")];
}

export async function projectAccountInOrder(projectors                                 , snapshot                     , account                  , generation        , businessResult                , boundary                            = null)                           {
  if (projectors.length !== PROJECTOR_ORDER.length || projectors.some((projector, index) => projectorIdentity(projector          ).id !== PROJECTOR_ORDER[index])) throw new SafeError("STATE", "projector order mismatch");
  const capability = projectorTransactionCapability(snapshot, account);
  if (generation !== capability.generation + 1) throw new SafeError("STATE", "projection batch generation mismatch");
  const business = businessResultProvenance(businessResult, snapshot);
  if (canonicalJson(business.summary) !== canonicalJson(capability.summary)) throw new SafeError("STATE", "business result summary mismatch");
  await cleanupAbandonedUndoBackups(projectorIdentity(projectors[0]          ).root, accountKey(capability.account));
  const outcomes                      = [];
  for (const projector of projectors.slice(0, 4)) outcomes.push(await runProjector(projector                 , snapshot, account, { plannedGeneration: generation, pendingRun: null }, boundary));
  const projectionWarned = outcomes.some((outcome) => !outcome.complete);
  const derivedBase = {
    ...business.result,
    command: capability.intent.command,
    account: capability.account,
    scope: capability.intent.command === "repair_views" ? null : capability.intent.scope,
    outcome: projectionWarned && business.result.outcome === "committed" ? "committed_with_warnings"          : business.result.outcome,
    safeErrorCategory: projectionWarned && business.result.outcome === "committed" ? "DERIVED_VIEW"          : business.result.safeErrorCategory,
  };
  let finalRun = decodeRunRecord(derivedBase);
  outcomes.push(await runProjector(projectors[4]                  , snapshot, account, { plannedGeneration: generation, pendingRun: finalRun }, boundary));
  const frozenOutcomes = Object.freeze(outcomes);
  const batch                  = Object.freeze({ outcomes: frozenOutcomes, finalRun });
  TRUSTED_BATCHES.set(batch, Object.freeze({
    transaction: snapshot,
    accountKey: accountKey(capability.account),
    generation,
    outcomesSha256: sha256Bytes(Buffer.from(canonicalJson(frozenOutcomes))),
    finalRunSha256: sha256Bytes(Buffer.from(canonicalJson(finalRun))),
    summarySha256: sha256Bytes(Buffer.from(canonicalJson(capability.summary))),
    summary: capability.summary,
    businessResult,
    businessResultSha256: sha256Bytes(Buffer.from(canonicalJson(businessResult))),
  }));
  return batch;
}
