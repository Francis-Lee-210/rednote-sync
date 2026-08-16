import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Bytes } from "./canonical.js";
import { SafeError } from "./errors.js";
import { assertProjectorNamespace, PROJECTOR_ORDER,                                           } from "./view-types.js";
import { SqliteStateStore,                                                         } from "./state-store.js";
import { accountKey, decodeAccountPartition, decodePartitionScope,                                            } from "./types.js";

                                                                                                                                                         
                                                                                                                                                             
                                                                                                        

async function readOrdinaryFile(root        , relative        )                      {
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
    return handle.readFile();
  } finally { await handle.close(); }
}

async function verifyReceipt(root        , receipt                    )                   {
  try {
    assertProjectorNamespace(receipt.accountKey, receipt.projectorId, receipt.relativePath);
    const bytes = await readOrdinaryFile(root, receipt.relativePath);
    return bytes.byteLength === receipt.byteLength && sha256Bytes(bytes) === receipt.sha256;
  } catch (error) {
    if (error instanceof SafeError && error.code === "SECURITY_BOUNDARY") throw error;
    return false;
  }
}

async function verifyView(root        , generation                         , view                      )                   {
  if (!view.complete || view.generation !== generation.canonicalGeneration || view.accountKey !== generation.accountKey) return false;
  for (const receipt of view.receipts) if (!await verifyReceipt(root, receipt)) return false;
  try {
    const relative = `accounts/${generation.accountKey}/.views/${view.projectorId}.generation.json`;
    const marker = JSON.parse(Buffer.from(await readOrdinaryFile(root, relative)).toString("utf8"))           ;
    return marker !== null && typeof marker === "object" && !Array.isArray(marker)
      && canonicalJson(marker) === canonicalJson({ accountKey: generation.accountKey, projectorId: view.projectorId, generation: view.generation, receipts: view.receipts });
  } catch (error) {
    if (error instanceof SafeError && error.code === "SECURITY_BOUNDARY") throw error;
    return false;
  }
}

async function generationMap(root        )                                              {
  const store = await SqliteStateStore.openReadOnly(root);
  try {
    const snapshot = store.openReadSnapshot();
    try { return Object.freeze([...snapshot.enumerateAccountsWithGenerations()]); }
    finally { snapshot.close(); }
  } finally { store.close(); }
}

export async function verifyRoot(root        , hooks              = {})                        {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const warnings                  = [];
    const store = await SqliteStateStore.openReadOnly(root);
    const objects = store.objectStore();
    let first                                    ;
    try {
      const snapshot = store.openReadSnapshot();
      try {
        first = Object.freeze([...snapshot.enumerateAccountsWithGenerations()]);
        for (const generation of first) {
          [...snapshot.enumerateAccountManifests(generation.account)];
          [...snapshot.enumerateAccountTasks(generation.account)];
          [...snapshot.enumerateUnresolvedFailures(generation.account)];
          [...snapshot.enumerateRuns(generation.account)];
          for (const ref of snapshot.enumerateObjectRefs(generation.account)) objects.readBytesSync(ref);
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

export async function readStatus(root        , scopeInput                 )                   {
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

export async function readAccountStatus(root        , accountInput                  )                   {
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
