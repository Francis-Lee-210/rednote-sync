import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import { SafeError } from "./errors.ts";
import { assertProjectorNamespace, PROJECTOR_ORDER, type DerivedViewReceipt, type ProjectorId } from "./view-types.ts";
import { SqliteStateStore, type AccountGenerationRecord, type ViewGenerationRecord } from "./state-store.ts";
import { accountKey, decodeAccountPartition, decodePartitionScope, type AccountPartition, type PartitionScope } from "./types.ts";

export interface VerifyWarning { readonly accountKey: string; readonly projectorId: ProjectorId | null; readonly code: "VIEW_INCOMPLETE" | "VIEW_STALE" }
export interface VerifyReport { readonly exitCode: 0 | 9; readonly attempts: number; readonly accounts: number; readonly warnings: readonly VerifyWarning[] }
export interface VerifyHooks { readonly afterFirstSnapshot?: (attempt: number) => void | Promise<void> }

async function openOrdinaryFile(root: string, relative: string) {
  const resolvedRoot = path.resolve(root);
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe verify root");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new SafeError("SECURITY_BOUNDARY", "verify path escaped root");
  let cursor = resolvedRoot;
  for (const part of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe verify ancestor");
  }
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) throw new SafeError("DERIVED_VIEW", "derived receipt is missing or unsafe");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw new SafeError("DERIVED_VIEW", "derived receipt identity changed");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function readOrdinaryFile(root: string, relative: string): Promise<Uint8Array> {
  const handle = await openOrdinaryFile(root, relative);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function verifyReceipt(root: string, receipt: DerivedViewReceipt): Promise<boolean> {
  try {
    assertProjectorNamespace(receipt.accountKey, receipt.projectorId, receipt.relativePath);
    const handle = await openOrdinaryFile(root, receipt.relativePath);
    try {
      const hash = createHash("sha256"); let length = 0;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null); if (!bytesRead) break; length += bytesRead; hash.update(buffer.subarray(0, bytesRead)); }
      return length === receipt.byteLength && hash.digest("hex") === receipt.sha256;
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof SafeError && error.code === "SECURITY_BOUNDARY") throw error;
    return false;
  }
}

async function verifyView(root: string, generation: AccountGenerationRecord, view: ViewGenerationRecord): Promise<boolean> {
  if (!view.complete || view.generation !== generation.canonicalGeneration || view.accountKey !== generation.accountKey) return false;
  for (const receipt of view.receipts) if (!await verifyReceipt(root, receipt)) return false;
  try {
    const relative = `accounts/${generation.accountKey}/.views/${view.projectorId}.generation.json`;
    const marker = JSON.parse(Buffer.from(await readOrdinaryFile(root, relative)).toString("utf8")) as unknown;
    return marker !== null && typeof marker === "object" && !Array.isArray(marker)
      && canonicalJson(marker) === canonicalJson({ accountKey: generation.accountKey, projectorId: view.projectorId, generation: view.generation, receipts: view.receipts });
  } catch (error) {
    if (error instanceof SafeError && error.code === "SECURITY_BOUNDARY") throw error;
    return false;
  }
}

async function generationMap(root: string): Promise<readonly AccountGenerationRecord[]> {
  const store = await SqliteStateStore.openReadOnly(root);
  try {
    const snapshot = store.openReadSnapshot();
    try { return Object.freeze([...snapshot.enumerateAccountsWithGenerations()]); }
    finally { snapshot.close(); }
  } finally { store.close(); }
}

export async function verifyRoot(root: string, hooks: VerifyHooks = {}): Promise<VerifyReport> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const warnings: VerifyWarning[] = [];
    const store = await SqliteStateStore.openReadOnly(root);
    const objects = store.objectStore();
    let first: readonly AccountGenerationRecord[];
    try {
      const snapshot = store.openReadSnapshot();
      try {
        first = Object.freeze([...snapshot.enumerateAccountsWithGenerations()]);
        for (const generation of first) {
          [...snapshot.enumerateAccountManifests(generation.account)];
          [...snapshot.enumerateAccountTasks(generation.account)];
          [...snapshot.enumerateUnresolvedFailures(generation.account)];
          [...snapshot.enumerateRuns(generation.account)];
          for (const ref of snapshot.enumerateObjectRefs(generation.account)) if (!await objects.verify(ref)) throw new SafeError("CANONICAL_INTEGRITY", "canonical object failed verification");
          const views = snapshot.enumerateViewGenerations(generation.accountKey);
          if (views.length !== PROJECTOR_ORDER.length) throw new SafeError("CANONICAL_INTEGRITY", "account view rows are incomplete");
          let derivedDirty = false;
          for (const view of views) {
            if (!view.complete) { derivedDirty = true; warnings.push(Object.freeze({ accountKey: generation.accountKey, projectorId: view.projectorId, code: "VIEW_INCOMPLETE" })); }
            else if (!await verifyView(root, generation, view)) { derivedDirty = true; warnings.push(Object.freeze({ accountKey: generation.accountKey, projectorId: view.projectorId, code: "VIEW_STALE" })); }
          }
          if (generation.viewsDirty !== derivedDirty) warnings.push(Object.freeze({ accountKey: generation.accountKey, projectorId: null, code: "VIEW_STALE" }));
        }
      } finally { snapshot.close(); }
    } finally { store.close(); }
    await hooks.afterFirstSnapshot?.(attempt);
    const second = await generationMap(root);
    if (canonicalJson(first) !== canonicalJson(second)) {
      if (attempt === 1) continue;
      return Object.freeze({ exitCode: 9, attempts: 2, accounts: second.length, warnings: Object.freeze([]) });
    }
    return Object.freeze({ exitCode: warnings.length === 0 ? 0 : 9, attempts: attempt, accounts: first.length, warnings: Object.freeze(warnings) });
  }
  throw new SafeError("STATE", "verify retry state unreachable");
}

export async function readStatus(root: string, scopeInput?: PartitionScope): Promise<unknown> {
  const store = await SqliteStateStore.openReadOnly(root);
  try {
    const snapshot = store.openReadSnapshot();
    try {
      if (scopeInput !== undefined) {
        const scope = decodePartitionScope(scopeInput);
        return Object.freeze({ scope, state: snapshot.loadState(scope) });
      }
      return Object.freeze({ accounts: Object.freeze([...snapshot.enumerateAccountsWithGenerations()]) });
    } finally { snapshot.close(); }
  } finally { store.close(); }
}

export async function readAccountStatus(root: string, accountInput: AccountPartition): Promise<unknown> {
  const account = decodeAccountPartition(accountInput);
  const store = await SqliteStateStore.openReadOnly(root);
  try {
    const snapshot = store.openReadSnapshot();
    try {
      const generation = [...snapshot.enumerateAccountsWithGenerations()].find((entry) => entry.accountKey === accountKey(account)) ?? null;
      return Object.freeze({ account, generation });
    } finally { snapshot.close(); }
  } finally { store.close(); }
}
