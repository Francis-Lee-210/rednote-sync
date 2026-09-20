import { createHash, randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { link, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Bytes, utf8Compare } from "./canonical.ts";
import { SafeError } from "./errors.ts";
import { publicNoteProjection, renderIndexCsvRow } from "./merge.ts";
import { FileContentAddressedObjectStore, bytesIterable, readableStreamToAsync } from "./object-store.ts";
import { decodeRelativePath, resolveManagedPath } from "./paths.ts";
import { MemorySecretRegistry, assertSerializedPersistenceSafe } from "./secrets.ts";
import { SqliteStateStore, businessResultProvenance, projectorTransactionCapability, type BusinessResult, type MutationSummary, type SqliteWriteSnapshot, type ViewGenerationRecord } from "./state-store.ts";
import { accountKey, decodeRunRecord, noteKey, type AccountKey, type AccountPartition, type ObjectRef, type RelativePath, type RunRecord, type Sha256 } from "./types.ts";
import { PROJECTOR_ORDER, assertProjectorNamespace, type DerivedViewReceipt, type ProjectionContext, type ProjectionOutcome, type ProjectorId, type ProjectorReadView } from "./view-types.ts";

export interface DerivedViewProjector {
  readonly id: ProjectorId;
  project(snapshot: SqliteWriteSnapshot, account: AccountPartition, context: ProjectionContext): Promise<ProjectionOutcome>;
}
export interface ProjectionBatch { readonly outcomes: readonly ProjectionOutcome[]; readonly finalRun: RunRecord }
export type ProjectionBoundaryPhase = "before_projector" | "after_projector" | "before_render_item" | "after_render_item" | "before_stable_file" | "after_stable_file";
export interface ProjectionBoundaryPoint { readonly projectorId: ProjectorId; readonly phase: ProjectionBoundaryPhase }
class ProjectionPaused extends Error { constructor() { super("projection paused"); } }

interface ProjectionBatchProvenance {
  readonly transaction: SqliteWriteSnapshot; readonly accountKey: AccountKey; readonly generation: number;
  readonly summary: MutationSummary; readonly businessResult: BusinessResult;
}
const batches = new WeakMap<object, ProjectionBatchProvenance>();
const outcomes = new WeakSet<object>();
export function projectionBatchProvenance(value: unknown, transaction: SqliteWriteSnapshot): ProjectionBatchProvenance {
  const provenance = value !== null && typeof value === "object" ? batches.get(value) : undefined;
  if (!provenance || provenance.transaction !== transaction) throw new SafeError("STATE", "foreign projection batch");
  return provenance;
}
export function assertTrustedProjectionOutcome(value: unknown, expected?: { readonly projectorId: ProjectorId; readonly accountKey: AccountKey; readonly generation: number }): asserts value is ProjectionOutcome {
  if (value === null || typeof value !== "object" || !outcomes.has(value)) throw new SafeError("STATE", "invalid projection outcome");
  const outcome = value as ProjectionOutcome;
  if (expected && (outcome.projectorId !== expected.projectorId || outcome.accountKey !== expected.accountKey || outcome.generation !== expected.generation)) throw new SafeError("STATE", "projection account mismatch");
}
/** Compatibility check for the old transaction interface; byte auditing is verify. */
export function assertProjectionMaterialized(outcome: ProjectionOutcome, root: string): void {
  assertTrustedProjectionOutcome(outcome);
  for (const receipt of outcome.receipts ?? []) {
    assertProjectorNamespace(outcome.accountKey, outcome.projectorId, receipt.relativePath);
    const info = lstatSync(path.join(root, receipt.relativePath));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== receipt.byteLength) throw new SafeError("STATE", "projection file missing");
  }
}

type RenderedFile = { readonly relativePath: RelativePath; readonly bytes: Uint8Array; readonly object?: never }
  | { readonly relativePath: RelativePath; readonly object: ObjectRef; readonly bytes?: never };
interface ProjectOptions {
  readonly full?: boolean;
  readonly check?: (point: ProjectionBoundaryPoint) => Promise<void>;
  readonly fail?: boolean;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function fileInfo(target: string) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived file");
    return info;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function digestFile(target: string): Promise<string> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null); if (bytesRead === 0) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function writeFile(root: string, file: RenderedFile, objects: FileContentAddressedObjectStore, prior: DerivedViewReceipt | undefined, full: boolean): Promise<{ sha256: Sha256; byteLength: number }> {
  const expected = file.object ?? { sha256: sha256Bytes(file.bytes) as Sha256, byteLength: file.bytes.byteLength };
  if (full && file.object && !await objects.verify(file.object)) throw new SafeError("CANONICAL_INTEGRITY", "canonical object failed verification");
  const target = await resolveManagedPath(root, file.relativePath, true);
  const existing = await fileInfo(target);
  if (existing && existing.nlink === 1 && (existing.mode & 0o777) === 0o600 && existing.size === expected.byteLength) {
    if (!full && prior?.sha256 === expected.sha256 && prior.byteLength === expected.byteLength) return expected;
    if (await digestFile(target) === expected.sha256) return expected;
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const source = file.object ? readableStreamToAsync(await objects.open(file.object)) : bytesIterable(file.bytes);
    let length = 0;
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.byteLength) { const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset); if (bytesWritten === 0) throw new SafeError("DERIVED_VIEW", "derived write failed"); offset += bytesWritten; }
      length += chunk.byteLength;
    }
    if (length !== expected.byteLength) throw new SafeError("CANONICAL_INTEGRITY", "object length changed during export");
    await handle.sync(); await handle.close();
    await fileInfo(target);
    await rename(temp, target); await fsyncDirectory(path.dirname(target));
    return expected;
  } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
async function deleteFile(root: string, relative: RelativePath): Promise<void> {
  const target = await resolveManagedPath(root, relative);
  if (!await fileInfo(target)) return;
  await unlink(target); await fsyncDirectory(path.dirname(target));
}

function* renderFiles(id: ProjectorId, view: ProjectorReadView, context: ProjectionContext): Iterable<RenderedFile> {
  const key = accountKey(view.account);
  if (id === "notes" || id === "assets") {
    for (const manifest of view.manifests()) {
      const digest = noteKey(view.account, manifest.noteId);
      if (id === "notes") {
        yield { relativePath: decodeRelativePath(`accounts/${key}/notes/${digest}.md`), object: manifest.artifacts.markdown };
        yield { relativePath: decodeRelativePath(`accounts/${key}/data/notes/${digest}.json`), object: manifest.artifacts.json };
      } else for (const slot of manifest.mediaSlots) {
        if (slot.tombstone || slot.media?.status !== "stored" || !slot.media.object) continue;
        if (!slot.media.extension || !/^[a-z0-9]{1,8}$/.test(slot.media.extension)) throw new SafeError("DERIVED_VIEW", "invalid media extension");
        yield { relativePath: decodeRelativePath(`accounts/${key}/assets/${digest}/${slot.slot.kind}-${slot.slot.ordinal}.${slot.media.extension}`), object: slot.media.object };
      }
    }
    return;
  }
  if (id === "index") {
    const manifests = [...view.manifests()].sort((a, b) => utf8Compare(a.noteId, b.noteId));
    yield { relativePath: decodeRelativePath(`accounts/${key}/account.json`), bytes: Buffer.from(`${canonicalJson({ schemaVersion: 1, hostId: view.account.hostId, accountId: view.account.accountId })}\n`) };
    yield { relativePath: decodeRelativePath(`accounts/${key}/data/index.json`), bytes: Buffer.from(`${canonicalJson(manifests.map((manifest) => publicNoteProjection(manifest.canonicalNote)))}\n`) };
    const header = '"host_id","account_id","note_id","title","public_url","content_hash"';
    const rows = manifests.map((manifest) => renderIndexCsvRow(manifest.canonicalNote));
    yield { relativePath: decodeRelativePath(`accounts/${key}/data/index.csv`), bytes: Buffer.from(`${header}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`) };
  } else if (id === "failures") {
    yield { relativePath: decodeRelativePath(`accounts/${key}/data/failures.json`), bytes: Buffer.from(`${canonicalJson([...view.failures()])}\n`) };
  } else {
    const runs = [...view.runs(), ...(context.pendingRun ? [context.pendingRun] : [])].sort((a, b) => utf8Compare(`${a.finishedAt}\0${a.runId}`, `${b.finishedAt}\0${b.runId}`));
    yield { relativePath: decodeRelativePath(`accounts/${key}/logs/export-runs.jsonl`), bytes: Buffer.from(runs.map((run) => canonicalJson(run)).join("\n") + (runs.length ? "\n" : "")) };
  }
}

async function cleanOrphans(root: string, key: AccountKey, id: ProjectorId, expected: Set<string>): Promise<void> {
  const directories = id === "notes" ? [`accounts/${key}/notes`, `accounts/${key}/data/notes`] : id === "assets" ? [`accounts/${key}/assets`] : [];
  for (const relative of directories) {
    const pending = [await resolveManagedPath(root, `${relative}/.probe`, true).then(path.dirname)];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new SafeError("SECURITY_BOUNDARY", "symlink in derived files");
        if (info.isDirectory()) { if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new SafeError("SECURITY_BOUNDARY", "unsafe derived directory"); pending.push(target); continue; }
        const file = decodeRelativePath(path.relative(root, target).split(path.sep).join("/"));
        if (/^\.rednote-sync-undo-[0-9a-f]{24}\.bak$/.test(entry.name)) { if (info.isFile() && info.uid === process.getuid?.()) await unlink(target); continue; }
        try { assertProjectorNamespace(key, id, file); } catch { continue; }
        if (!expected.has(file)) await deleteFile(root, file);
      }
    }
  }
}

async function project(id: ProjectorId, root: string, objects: FileContentAddressedObjectStore, view: ProjectorReadView, context: ProjectionContext, previous: readonly DerivedViewReceipt[], options: ProjectOptions = {}): Promise<ProjectionOutcome> {
  const key = accountKey(view.account);
  const receipts: DerivedViewReceipt[] = [];
  const old = new Map(previous.map((receipt) => [receipt.relativePath, receipt]));
  const check = async (phase: ProjectionBoundaryPhase) => { await options.check?.({ projectorId: id, phase }); };
  try {
    await check("before_projector");
    if (options.fail) throw new SafeError("DERIVED_VIEW", "injected projector failure");
    for (const file of renderFiles(id, view, context)) {
      await check("before_render_item");
      assertProjectorNamespace(key, id, file.relativePath);
      if (file.bytes) assertSerializedPersistenceSafe(file.bytes, objects.registry);
      await check("after_render_item"); await check("before_stable_file");
      const written = await writeFile(root, file, objects, old.get(file.relativePath), options.full ?? false);
      receipts.push(Object.freeze({ projectorId: id, accountKey: key, generation: context.plannedGeneration, relativePath: file.relativePath, sha256: written.sha256, byteLength: written.byteLength }));
      await check("after_stable_file");
    }
    const expected = new Set(receipts.map((receipt) => receipt.relativePath));
    for (const receipt of previous) if (!expected.has(receipt.relativePath)) { assertProjectorNamespace(key, id, receipt.relativePath); await deleteFile(root, receipt.relativePath); }
    if (options.full) await cleanOrphans(root, key, id, expected);
    receipts.sort((a, b) => utf8Compare(a.relativePath, b.relativePath));
    const markerPath = decodeRelativePath(`accounts/${key}/.views/${id}.generation.json`);
    const bytes = Buffer.from(`${canonicalJson({ accountKey: key, projectorId: id, generation: context.plannedGeneration, receipts })}\n`);
    await writeFile(root, { relativePath: markerPath, bytes }, objects, undefined, false);
    await check("after_projector");
    const outcome: ProjectionOutcome = Object.freeze({ projectorId: id, accountKey: key, generation: context.plannedGeneration, complete: true, receipts: Object.freeze(receipts), safeError: null }); outcomes.add(outcome); return outcome;
  } catch (error) {
    if (error instanceof ProjectionPaused) throw error;
    if (error instanceof SafeError && ["CANONICAL_INTEGRITY", "SECURITY_BOUNDARY", "STATE"].includes(error.code)) throw error;
    const outcome: ProjectionOutcome = Object.freeze({ projectorId: id, accountKey: key, generation: context.plannedGeneration, complete: false, receipts: Object.freeze(receipts), safeError: `projector ${id} failed` }); outcomes.add(outcome); return outcome;
  }
}

abstract class BaseProjector implements DerivedViewProjector {
  readonly id: ProjectorId; readonly root: string; readonly objects: FileContentAddressedObjectStore; readonly registry: MemorySecretRegistry; readonly failForTest: boolean;
  constructor(id: ProjectorId, root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, failForTest = false) { this.id = id; this.root = root; this.objects = objects; this.registry = registry; this.failForTest = failForTest; }
  async *render(view: ProjectorReadView, context: ProjectionContext): AsyncIterable<RenderedFile> { yield* renderFiles(this.id, view, context); }
  async project(snapshot: SqliteWriteSnapshot, account: AccountPartition, context: ProjectionContext): Promise<ProjectionOutcome> {
    const capability = projectorTransactionCapability(snapshot, account);
    return project(this.id, this.root, this.objects, capability.view, context, capability.views.find((entry) => entry.projectorId === this.id)?.receipts ?? [], { full: capability.intent.command === "repair_views", fail: this.failForTest });
  }
}
export class NotesProjector extends BaseProjector { constructor(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, fail = false) { super("notes", root, objects, registry, fail); } }
export class AssetsProjector extends BaseProjector { constructor(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, fail = false) { super("assets", root, objects, registry, fail); } }
export class IndexProjector extends BaseProjector { constructor(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, fail = false) { super("index", root, objects, registry, fail); } }
export class FailuresProjector extends BaseProjector { constructor(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, fail = false) { super("failures", root, objects, registry, fail); } }
export class RunsProjector extends BaseProjector { constructor(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, fail = false) { super("runs", root, objects, registry, fail); } }
export function createProjectors(root: string, objects: FileContentAddressedObjectStore, registry = objects.registry, failId: ProjectorId | null = null): readonly [NotesProjector, AssetsProjector, IndexProjector, FailuresProjector, RunsProjector] {
  return [new NotesProjector(root, objects, registry, failId === "notes"), new AssetsProjector(root, objects, registry, failId === "assets"), new IndexProjector(root, objects, registry, failId === "index"), new FailuresProjector(root, objects, registry, failId === "failures"), new RunsProjector(root, objects, registry, failId === "runs")];
}
/** Adapter for the old library interface, sharing the same streaming projector. */
export async function projectAccountInOrder(projectors: readonly DerivedViewProjector[], snapshot: SqliteWriteSnapshot, account: AccountPartition, generation: number, businessResult: BusinessResult): Promise<ProjectionBatch> {
  if (projectors.length !== PROJECTOR_ORDER.length || projectors.some((item, index) => !(item instanceof BaseProjector) || item.id !== PROJECTOR_ORDER[index])) throw new SafeError("STATE", "projector order mismatch");
  const capability = projectorTransactionCapability(snapshot, account);
  if (generation !== capability.generation + 1) throw new SafeError("STATE", "projection generation mismatch");
  const business = businessResultProvenance(businessResult, snapshot);
  const results: ProjectionOutcome[] = [];
  let run = decodeRunRecord({ ...business.result, command: capability.intent.command, account, scope: capability.intent.command === "repair_views" ? null : capability.intent.scope });
  for (const [index, item] of projectors.entries()) {
    const projector = item as BaseProjector;
    const result = await project(projector.id, projector.root, projector.objects, capability.view, { plannedGeneration: generation, pendingRun: index === 4 ? run : null }, capability.views.find((entry) => entry.projectorId === projector.id)?.receipts ?? [], { full: capability.intent.command === "repair_views", fail: projector.failForTest });
    results.push(result);
    if (!result.complete && run.outcome === "committed") run = decodeRunRecord({ ...run, outcome: "committed_with_warnings", safeErrorCategory: "DERIVED_VIEW" });
  }
  const batch = Object.freeze({ outcomes: Object.freeze(results), finalRun: run });
  batches.set(batch, { transaction: snapshot, accountKey: accountKey(account), generation, summary: business.summary, businessResult });
  return batch;
}

export interface ExportAccountOptions { readonly full?: boolean; readonly run?: RunRecord; readonly signal?: AbortSignal; readonly onCheckpoint?: (point: ProjectionBoundaryPoint) => void | Promise<void> }
export interface ExportAccountResult { readonly exitCode: 0 | 9; readonly run: RunRecord | null; readonly generation: number }

async function acquireExportLock(root: string, account: AccountPartition): Promise<() => Promise<void>> {
  const lock = await resolveManagedPath(root, `state/export-${accountKey(account)}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temp = `${lock}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let identity;
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); identity = await handle.stat(); }
      finally { await handle.close(); }
      // Publish complete lock contents atomically, so a crash cannot leave an
      // empty lock whose owner is impossible to inspect.
      await link(temp, lock);
      return async () => { const current = await lstat(lock).catch(() => null); if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(lock); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW);
      let pid: number; let identity;
      try { identity = await handle.stat(); const value = JSON.parse(await handle.readFile("utf8")); pid = value.pid; if (!Number.isSafeInteger(pid) || pid <= 0 || !identity.isFile() || identity.uid !== process.getuid?.()) throw new SafeError("STATE", "invalid export lock"); }
      finally { await handle.close(); }
      try { process.kill(pid, 0); throw new SafeError("BUSY", "export is already running"); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
      const current = await lstat(lock);
      if (current.ino === identity.ino && current.dev === identity.dev) await unlink(lock);
    } finally { await unlink(temp).catch(() => {}); }
  }
  throw new SafeError("BUSY", "export is already running");
}

/** Export a committed snapshot. No SQLite write transaction spans file I/O. */
export async function exportAccount(root: string, account: AccountPartition, options: ExportAccountOptions = {}): Promise<ExportAccountResult> {
  const store = await SqliteStateStore.open(root);
  const objects = store.objectStore();
  let release: (() => Promise<void>) | undefined;
  let run: RunRecord | null = null;
  let generation = 0;
  try {
    run = options.run ? decodeRunRecord(options.run) : null;
    if (run) { if (accountKey(run.account) !== accountKey(account)) throw new SafeError("INVALID_INPUT", "export run account mismatch"); store.recordRun(run); }
    release = await acquireExportLock(root, account);
    store.markProjectionPending(account);
    const snapshot = store.openReadSnapshot();
    let view: ProjectorReadView; let previous: readonly ViewGenerationRecord[];
    try {
      generation = snapshot.accountGeneration(account);
      const manifests = [...snapshot.enumerateAccountManifests(account)];
      const failures = [...snapshot.enumerateUnresolvedFailures(account)];
      const runs = [...snapshot.enumerateRuns(account)];
      previous = snapshot.enumerateViewGenerations(accountKey(account));
      view = { account, manifests: () => manifests, failures: () => failures, runs: () => runs, tasks: () => [] };
    } finally { snapshot.close(); }
    const results: ProjectionOutcome[] = [];
    for (const id of PROJECTOR_ORDER) results.push(await project(id, root, objects, view, { plannedGeneration: generation, pendingRun: null }, previous.find((item) => item.projectorId === id)?.receipts ?? [], {
      full: options.full,
      check: async (point) => { await options.onCheckpoint?.(point); if (options.signal?.aborted) throw new ProjectionPaused(); },
    }));
    const current = store.recordProjection(account, generation, results);
    if (current && results.every((result) => result.complete)) return { exitCode: 0, run, generation };
  } catch (error) {
    if (error instanceof SafeError && ["SECURITY_BOUNDARY", "CANONICAL_INTEGRITY", "INVALID_INPUT"].includes(error.code)) throw error;
  } finally {
    try { await release?.(); } finally { store.close(); }
  }
  if (run?.outcome === "committed") {
    run = decodeRunRecord({ ...run, outcome: "committed_with_warnings", safeErrorCategory: "DERIVED_VIEW" });
    const recorder = await SqliteStateStore.open(root);
    try { recorder.recordRun(run); } finally { recorder.close(); }
  }
  return { exitCode: 9, run, generation };
}
