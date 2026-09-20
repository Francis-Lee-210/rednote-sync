import { randomBytes } from "node:crypto";
import { isScopePaused } from "./control.ts";
import { exitCodeForCategory } from "./commands.ts";
import { SafeError } from "./errors.ts";
import { renderNoteJsonBytes, renderNoteMarkdownBytes } from "./exporters.ts";
import { canResolveMediaFailure, computeFailureId, indexEntryDigest, mergeCanonicalNote, mergeFailure, noteCsvRowDigest } from "./merge.ts";
import { bytesIterable, FileMediaStore, type FileContentAddressedObjectStore } from "./object-store.ts";
import { OfflineAdapterError, type SyncSource, type TransientNote, type OfflineListPage } from "./offline-input.ts";
import { transitionSyncProgress } from "./progress.ts";
import { exportAccount, type ProjectionBoundaryPoint } from "./projectors.ts";
import { MemorySecretRegistry } from "./secrets.ts";
import { SqliteStateStore, type CanonicalMutation, type FailureOccurrence, type SqliteWriteSnapshot, type ValidatedMergeCandidateInput } from "./state-store.ts";
import {
  accountPartition,
  decodeAccount,
  decodeAccountPartition,
  decodeIsoDateTime,
  decodePartitionScope,
  initialProgress,
  sameAccount,
  sameScope,
  type Account,
  type AccountPartition,
  type CaptureAttempt,
  type AlbumState,
  type ErrorCategory,
  type FailureRecord,
  type IsoDateTime,
  type Media,
  type MediaSlotState,
  type NoteId,
  type NoteManifest,
  type PartitionScope,
  type RunOutcome,
  type RunRecord,
  type SyncState,
  type TaskRecord,
} from "./types.ts";

export interface EngineClock {
  now(): IsoDateTime;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const systemEngineClock: EngineClock = Object.freeze({
  now: () => decodeIsoDateTime(new Date().toISOString()),
  sleep: (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new SafeError("STATE", "sync interrupted")); return; }
    const finish = () => { signal.removeEventListener("abort", interrupted); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const interrupted = () => { clearTimeout(timer); signal.removeEventListener("abort", interrupted); reject(new SafeError("STATE", "sync interrupted")); };
    signal.addEventListener("abort", interrupted, { once: true });
  }),
});

export interface SyncEngineOptions {
  readonly root: string;
  readonly scope: PartitionScope;
  readonly session?: SyncSource;
  readonly source?: SyncSource;
  readonly onProgress?: (progress: { readonly noteId: NoteId; readonly status: TaskRecord["status"] }) => void | Promise<void>;
  readonly limit?: number;
  readonly clock?: EngineClock;
  readonly minimumIntervalMs?: number;
  readonly itemDelayMs?: number;
  readonly registry?: MemorySecretRegistry;
  readonly projectionBoundaryObserver?: (point: ProjectionBoundaryPoint) => void | Promise<void>;
}

export interface EngineResult { readonly exitCode: number; readonly run: RunRecord; readonly hasMore?: boolean; readonly pages?: number }

interface ItemResult {
  readonly tasks: readonly TaskRecord[];
  readonly candidate: ValidatedMergeCandidateInput | null;
  readonly manifest: NoteManifest | null;
  readonly occurrences: readonly FailureOccurrence[];
  readonly resolutions: readonly FailureRecord[];
  readonly failures: readonly FailureRecord[];
  readonly blocker: ErrorCategory | null;
}

function makeRunId(prefix: string): string {
  const hex = randomBytes(12).toString("hex");
  return `${prefix}.${hex.slice(0, 8)}.${hex.slice(8, 16)}.${hex.slice(16)}`;
}
function ephemeralRun(scope: PartitionScope, outcome: "not_due", startedAt: IsoDateTime, finishedAt: IsoDateTime): RunRecord {
  return Object.freeze({ runId: makeRunId("run"), command: "sync", account: accountPartition(scope), scope, outcome, startedAt, finishedAt, safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 });
}

function stateFor(scope: PartitionScope, prior: SyncState | AlbumState | null): SyncState | AlbumState {
  if (prior) return prior;
  const common = { schemaVersion: 1 as const, ...scope, revision: 0, progress: initialProgress(), stopReason: null, lastAttemptAt: null, lastSuccessfulAt: null, nextAllowedAt: null };
  return (scope.target === "collected_album" ? Object.freeze({ ...common, boardName: null }) : Object.freeze(common)) as SyncState | AlbumState;
}

function future(now: IsoDateTime, milliseconds: number): IsoDateTime | null {
  if (milliseconds === 0) return null;
  return decodeIsoDateTime(new Date(new Date(now).getTime() + milliseconds).toISOString());
}

function occurrence(scope: PartitionScope, noteId: NoteId, category: ErrorCategory, now: IsoDateTime, slot: FailureRecord["mediaSlot"], rank: FailureRecord["sourceRank"]): FailureRecord {
  const media = category === "MEDIA";
  const base = {
    schemaVersion: 1 as const,
    scope,
    noteId,
    mediaSlot: slot,
    sourceRank: rank,
    category,
    stage: media ? "media" as const : category === "EXPORT" ? "export" as const : "detail" as const,
    safeMessage: media ? "media could not be stored" : "detail could not be loaded",
    retryable: true,
    attemptCount: 1,
    firstOccurredAt: now,
    lastOccurredAt: now,
    retryAt: null,
    resolvedAt: null,
    resolvedReason: null,
  };
  return Object.freeze({ ...base, failureId: computeFailureId(base) });
}

function adapterCategory(error: unknown, fallback: "NETWORK" | "DETAIL"): ErrorCategory {
  if (error instanceof OfflineAdapterError) return error.category;
  if (error instanceof SafeError) throw error;
  if (error !== null && typeof error === "object" && "category" in error) {
    const category = (error as { readonly category?: unknown }).category;
    if (typeof category === "string" && ["AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "EXPORT"].includes(category)) return category as ErrorCategory;
  }
  return fallback;
}

function retryAtFrom(error: unknown): IsoDateTime | null {
  if (error instanceof OfflineAdapterError) return error.retryAt;
  return null;
}

function durableStop(category: ErrorCategory): SyncState["stopReason"] {
  return category === "AUTH_REQUIRED" || category === "RATE_LIMITED" || category === "PROTOCOL" ? category : null;
}

function statusForFailures(failures: readonly FailureRecord[]): TaskRecord["status"] {
  if (failures.length === 0) return "done";
  return failures.some((failure) => failure.stage !== "media") ? "failed" : "partial";
}

function taskRecord(scope: PartitionScope, noteId: NoteId, prior: TaskRecord | null, status: TaskRecord["status"], failures: readonly FailureRecord[], now: IsoDateTime, incrementAttempt = true): TaskRecord {
  return Object.freeze({
    schemaVersion: 1,
    scope,
    noteId,
    status,
    attemptCount: (prior?.attemptCount ?? 0) + (incrementAttempt && status !== "pending" && status !== "paused" ? 1 : 0),
    failureIds: Object.freeze(failures.filter((failure) => failure.resolvedAt === null).map((failure) => failure.failureId).sort()),
    skipReason: null,
    skippedAt: null,
    firstSeenAt: prior?.firstSeenAt ?? now,
    updatedAt: now,
    ...(prior?.listCollector === undefined ? {} : { listCollector: prior.listCollector }),
    ...(prior?.attempts === undefined ? {} : { attempts: prior.attempts }),
  });
}

async function writeManifest(objects: FileContentAddressedObjectStore, prior: NoteManifest | null, detail: TransientNote, slots: readonly MediaSlotState[], signal: AbortSignal): Promise<{ readonly candidate: ValidatedMergeCandidateInput; readonly manifest: NoteManifest }> {
  const candidate: ValidatedMergeCandidateInput = Object.freeze({ note: detail.semanticNote, sourceRank: detail.sourceRank, mediaSlots: Object.freeze(slots), mediaSetComplete: detail.mediaSetComplete });
  const merged = mergeCanonicalNote(prior, candidate);
  const json = await objects.put(bytesIterable(renderNoteJsonBytes(merged.note, objects.registry)), null, signal);
  const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(merged.note, objects.registry)), null, signal);
  const manifest: NoteManifest = Object.freeze({ schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, accountId: merged.note.accountId, hostId: merged.note.hostId, noteId: merged.note.noteId, canonicalNote: merged.note, semanticSourceRank: merged.sourceRank, membershipNameObservations: merged.membershipNameObservations, mediaSlots: merged.mediaSlots, artifacts: Object.freeze({ json, markdown }), indexEntrySha256: indexEntryDigest(merged.note), csvRowSha256: noteCsvRowDigest(merged.note) });
  return { candidate, manifest };
}

interface ItemContext {
  readonly manifest: NoteManifest | null;
  readonly tasks: readonly TaskRecord[];
  readonly failures: readonly FailureRecord[];
}

export class SyncEngine {
  readonly #root: string;
  readonly #scope: PartitionScope;
  readonly #source: SyncSource;
  readonly #limit: number;
  readonly #clock: EngineClock;
  readonly #minimumIntervalMs: number;
  readonly #itemDelayMs: number;
  readonly #registry: MemorySecretRegistry;
  readonly #options: SyncEngineOptions;

  constructor(options: SyncEngineOptions) {
    this.#root = options.root;
    this.#scope = decodePartitionScope(options.scope);
    const source = options.source ?? options.session;
    if (!source) throw new SafeError("INVALID_INPUT", "sync source is required");
    decodeAccount(source.account);
    if (!sameAccount(source.account, this.#scope)) throw new SafeError("INVALID_INPUT", "source owner mismatch");
    for (const collector of [source.listCollector, source.contentCollector]) {
      if (collector && decodeAccountPartition(collector).hostId !== this.#scope.hostId) throw new SafeError("INVALID_INPUT", "collector host mismatch");
    }
    this.#source = source;
    this.#limit = options.limit ?? 100;
    this.#clock = options.clock ?? systemEngineClock;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? 0;
    this.#itemDelayMs = options.itemDelayMs ?? 0;
    this.#registry = options.registry ?? new MemorySecretRegistry();
    this.#options = options;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1) throw new SafeError("INVALID_INPUT", "sync limit must be positive");
    if (!Number.isSafeInteger(this.#minimumIntervalMs) || this.#minimumIntervalMs < 0 || !Number.isSafeInteger(this.#itemDelayMs) || this.#itemDelayMs < 0) throw new SafeError("INVALID_INPUT", "invalid pacing policy");
  }

  async #paused(signal: AbortSignal): Promise<boolean> { return signal.aborted || await isScopePaused(this.#root, this.#scope); }

  #state(store: SqliteStateStore): SyncState | AlbumState {
    const snapshot = store.openReadSnapshot();
    try { return stateFor(this.#scope, snapshot.loadState(this.#scope)); }
    finally { snapshot.close(); }
  }

  #context(store: SqliteStateStore, noteId: NoteId): ItemContext {
    const snapshot = store.openReadSnapshot();
    const account = accountPartition(this.#scope);
    try {
      return { manifest: snapshot.loadManifest(account, noteId), tasks: snapshot.listNoteTasks(account, noteId), failures: snapshot.listNoteFailures(account, noteId) };
    } finally { snapshot.close(); }
  }

  #apply(store: SqliteStateStore, command: "sync" | "retry", change: (tx: SqliteWriteSnapshot, current: SyncState | AlbumState) => CanonicalMutation): void {
    const tx = store.beginImmediate({ command, scope: this.#scope });
    try {
      store.upsertAccount(tx, this.#source.account);
      const current = stateFor(this.#scope, tx.loadState(this.#scope));
      const mutation = change(tx, current);
      store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, mutation));
      store.commitCanonical(tx);
    } catch (error) { try { store.rollback(tx); } catch { /* preserve the first failure */ } throw error; }
  }

  #mutation(current: SyncState | AlbumState, changes: Partial<CanonicalMutation> = {}): CanonicalMutation {
    return { scope: this.#scope, expectedStateRevision: current.revision, expectedManifestRevisions: {}, nextState: { ...current, revision: current.revision + 1 }, candidates: [], manifests: [], tasks: [], failureOccurrences: [], failureResolutions: [], failures: [], ...changes };
  }

  #checkpoint(store: SqliteStateStore, page: OfflineListPage, protocol: boolean, attempted: ReadonlySet<NoteId>): readonly NoteId[] {
    const noteIds = page.items.map((item) => item.noteId);
    const now = this.#clock.now();
    this.#apply(store, "sync", (tx, current) => {
      const newNoteIds = noteIds.filter((id) => tx.loadTask(this.#scope, id) === null);
      const progress = protocol ? current.progress : transitionSyncProgress(current.progress, { requestCursor: page.requestCursor, nextCursor: page.nextCursor, hasMore: page.hasMore, noteIds, newNoteIds });
      const tasks = noteIds.map((id): TaskRecord => {
        const prior = tx.loadTask(this.#scope, id);
        const queued = prior?.status === "done" && !attempted.has(id) ? { ...prior, status: "pending" as const, updatedAt: now } : prior;
        return { ...(queued ?? taskRecord(this.#scope, id, null, "pending", [], now)), listCollector: page.listCollector === undefined ? this.#source.listCollector ?? null : page.listCollector };
      });
      return this.#mutation(current, { tasks, nextState: { ...current, revision: current.revision + 1, progress, stopReason: protocol ? "PROTOCOL" : current.stopReason, lastAttemptAt: now, nextAllowedAt: future(now, this.#minimumIntervalMs) } });
    });
    return noteIds;
  }

  #recordStop(store: SqliteStateStore, command: "sync" | "retry", category: ErrorCategory, retryAt: IsoDateTime | null = null): void {
    const now = this.#clock.now();
    this.#apply(store, command, (_tx, current) => this.#mutation(current, { nextState: { ...current, revision: current.revision + 1, stopReason: durableStop(category) ?? current.stopReason, lastAttemptAt: now, nextAllowedAt: category === "RATE_LIMITED" ? retryAt : future(now, this.#minimumIntervalMs) } }));
  }

  async #prepareItem(context: ItemContext, objects: FileContentAddressedObjectStore, mediaStore: FileMediaStore, noteId: NoteId, detail: TransientNote, now: IsoDateTime, signal: AbortSignal): Promise<ItemResult> {
    const slots: MediaSlotState[] = [];
    const rawOccurrences: FailureRecord[] = [];
    let paused = false;
    for (const source of detail.mediaSources) {
      const existing = context.manifest?.mediaSlots.find((slot) => slot.slot.kind === source.slot.kind && slot.slot.ordinal === source.slot.ordinal && slot.media?.status === "stored" && slot.media.mediaId === source.mediaId);
      if (existing?.media) { slots.push({ ...existing, sourceRank: detail.sourceRank }); continue; }
      paused ||= await this.#paused(signal);
      try {
        if (paused) throw new OfflineAdapterError("MEDIA", null);
        const stored = await mediaStore.put(source, signal);
        slots.push({ slot: source.slot, sourceRank: detail.sourceRank, media: { ...stored, mediaId: source.mediaId }, tombstone: false });
      } catch (error) {
        if (!signal.aborted && error instanceof SafeError && ["SECURITY_BOUNDARY", "CANONICAL_INTEGRITY", "STATE"].includes(error.code)) throw error;
        paused ||= signal.aborted;
        const failed: Media = { mediaId: source.mediaId, kind: source.slot.kind, ordinal: source.slot.ordinal, status: "failed", extension: null, object: null };
        slots.push({ slot: source.slot, sourceRank: detail.sourceRank, media: failed, tombstone: false });
        rawOccurrences.push(occurrence(this.#scope, noteId, "MEDIA", now, source.slot, detail.sourceRank));
      }
    }
    paused ||= await this.#paused(signal);
    // Already acquired content is committed even when the caller has requested a pause.
    const { candidate, manifest } = await writeManifest(objects, context.manifest, detail, slots, new AbortController().signal);
    const existing = new Map(context.failures.map((failure) => [failure.failureId, failure]));
    const finalOccurrences = rawOccurrences.map((failure) => mergeFailure(existing.get(failure.failureId) ?? null, failure));
    const occurrenceIds = new Set(finalOccurrences.map((failure) => failure.failureId));
    const resolutions = context.failures.filter((failure) => {
      if (occurrenceIds.has(failure.failureId)) return false;
      if (failure.stage !== "media") return sameScope(failure.scope, this.#scope);
      const accepted = manifest.mediaSlots.find((slot) => failure.mediaSlot !== null && slot.slot.kind === failure.mediaSlot.kind && slot.slot.ordinal === failure.mediaSlot.ordinal && (slot.tombstone || slot.media?.status === "stored"));
      return accepted !== undefined && canResolveMediaFailure(failure, accepted.sourceRank, true);
    }).map((failure): FailureRecord => ({ ...failure, resolvedAt: now, resolvedReason: "repaired" }));
    const resolvedIds = new Set(resolutions.map((failure) => failure.failureId));
    const unresolved = [...context.failures.filter((failure) => !resolvedIds.has(failure.failureId) && !occurrenceIds.has(failure.failureId)), ...finalOccurrences];
    const touched = new Map<string, PartitionScope>([[JSON.stringify(this.#scope), this.#scope]]);
    for (const resolution of resolutions) touched.set(JSON.stringify(resolution.scope), resolution.scope);
    const tasks = [...touched.values()].map((scope) => {
      const prior = context.tasks.find((task) => sameScope(task.scope, scope)) ?? null;
      const related = unresolved.filter((failure) => sameScope(failure.scope, scope));
      return taskRecord(scope, noteId, prior, statusForFailures(related), related, now, sameScope(scope, this.#scope));
    });
    return { tasks, candidate, manifest, occurrences: rawOccurrences.map((failure) => ({ failure })), resolutions, failures: [...finalOccurrences, ...resolutions], blocker: paused ? "PAUSED" : null };
  }

  async #capture(store: SqliteStateStore, command: "sync" | "retry", noteId: NoteId, signal: AbortSignal): Promise<ErrorCategory | null> {
    const context = this.#context(store, noteId);
    const prior = context.tasks.find((task) => sameScope(task.scope, this.#scope)) ?? null;
    if (prior?.status === "skipped" || command === "retry" && prior?.status === "done") return null;
    const startedAt = this.#clock.now();
    let result: ItemResult;
    let collector = this.#source.contentCollector ?? null;
    try {
      const needed = { detail: command === "sync" || context.manifest === null || prior?.status === "pending" || prior?.status === "paused", mediaSlots: context.failures.flatMap((failure) => failure.mediaSlot ? [failure.mediaSlot] : []), signal };
      const detail = command === "retry" && this.#source.retrySource
        ? await this.#source.retrySource.get(this.#scope, noteId, needed)
        : await this.#source.client.getDetail(this.#scope, noteId, needed);
      if (detail.note.noteId !== noteId || !sameAccount(detail.note, this.#scope)) throw new SafeError("INVALID_INPUT", "detail owner or note mismatch");
      collector = detail.contentCollector === undefined ? collector : detail.contentCollector;
      if (collector && decodeAccountPartition(collector).hostId !== this.#scope.hostId) throw new SafeError("INVALID_INPUT", "collector host mismatch");
      result = await this.#prepareItem(context, store.objectStore(), new FileMediaStore(store.objectStore()), noteId, detail, startedAt, signal);
    } catch (error) {
      if (error instanceof OfflineAdapterError && error.collector !== undefined) collector = error.collector;
      const category = signal.aborted ? "PAUSED" : adapterCategory(error, "DETAIL");
      const raw = category === "PAUSED" ? null : occurrence(this.#scope, noteId, category, startedAt, null, null);
      const final = raw ? mergeFailure(context.failures.find((failure) => failure.failureId === raw.failureId) ?? null, raw) : null;
      const unresolved = [...context.failures.filter((failure) => sameScope(failure.scope, this.#scope) && failure.failureId !== final?.failureId), ...(final ? [final] : [])];
      const status = unresolved.length ? statusForFailures(unresolved) : "paused";
      result = { tasks: [taskRecord(this.#scope, noteId, prior, status, unresolved, startedAt)], candidate: null, manifest: null, occurrences: raw ? [{ failure: raw }] : [], resolutions: [], failures: final ? [final] : [], blocker: category };
      if (category === "RATE_LIMITED") this.#recordStop(store, command, category, retryAtFrom(error));
    }
    const finishedAt = this.#clock.now();
    if (collector && decodeAccountPartition(collector).hostId !== this.#scope.hostId) throw new SafeError("INVALID_INPUT", "collector host mismatch");
    const primary = result.tasks.find((task) => sameScope(task.scope, this.#scope))!;
    const outcome = primary.status === "done" ? "done" : primary.status === "partial" ? "partial" : result.blocker === "PAUSED" ? "paused" : "failed";
    const attempt: CaptureAttempt = { attemptId: makeRunId("capture"), collector, startedAt, finishedAt, outcome, category: result.blocker ?? (primary.status === "partial" ? "MEDIA" : null) };
    const tasks = result.tasks.map((task) => sameScope(task.scope, this.#scope) ? { ...task, attempts: [...(prior?.attempts ?? []), attempt], listCollector: prior?.listCollector === undefined ? this.#source.listCollector ?? null : prior.listCollector } : task);
    this.#apply(store, command, (_tx, current) => this.#mutation(current, {
      tasks, candidates: result.candidate ? [result.candidate] : [], manifests: result.manifest ? [result.manifest] : [],
      expectedManifestRevisions: result.manifest ? { [noteId]: context.manifest?.revision ?? null } : {},
      failureOccurrences: result.occurrences, failureResolutions: result.resolutions, failures: result.failures,
      nextState: { ...current, revision: current.revision + 1, stopReason: result.blocker === null ? current.stopReason : durableStop(result.blocker) ?? current.stopReason, lastAttemptAt: finishedAt, lastSuccessfulAt: primary.status === "done" ? finishedAt : current.lastSuccessfulAt },
    }));
    await this.#options.onProgress?.({ noteId, status: primary.status });
    return result.blocker;
  }

  async #finish(store: SqliteStateStore, command: "sync" | "retry", noteIds: readonly NoteId[], startedAt: IsoDateTime, blocker: ErrorCategory | null, pages: number, listAttempts: readonly CaptureAttempt[] = []): Promise<EngineResult> {
    const snapshot = store.openReadSnapshot();
    let tasks: readonly TaskRecord[];
    let unresolved: readonly FailureRecord[];
    let hasMore: boolean;
    try {
      tasks = noteIds.flatMap((id) => { const task = snapshot.loadTask(this.#scope, id); return task ? [task] : []; });
      unresolved = [...snapshot.enumerateUnresolvedFailures(accountPartition(this.#scope))].filter((failure) => sameScope(failure.scope, this.#scope));
      hasMore = !stateFor(this.#scope, snapshot.loadState(this.#scope)).progress.reachedEnd;
    } finally { snapshot.close(); }
    const category = blocker ?? unresolved.find((failure) => failure.stage !== "media")?.category ?? (unresolved.length ? "MEDIA" : null);
    const run: RunRecord = { runId: makeRunId("run"), command, account: accountPartition(this.#scope), scope: this.#scope, outcome: blocker === "PAUSED" ? "paused" : blocker ? "blocked" : category ? "committed_with_warnings" : "committed", startedAt, finishedAt: this.#clock.now(), safeErrorCategory: category, listed: noteIds.length, done: tasks.filter((task) => task.status === "done").length, partial: tasks.filter((task) => task.status === "partial").length, failed: tasks.filter((task) => task.status === "failed").length, skipped: tasks.filter((task) => task.status === "skipped").length, listCollector: this.#source.listCollector ?? null, contentCollector: this.#source.contentCollector ?? null };
    // Finishing derived views is bounded local work; pausing acquisition never rolls back a saved note.
    const recordedRun = { ...run, listAttempts };
    const exported = await exportAccount(this.#root, accountPartition(this.#scope), { run: recordedRun, onCheckpoint: this.#options.projectionBoundaryObserver });
    const businessExit = exitCodeForCategory(category);
    return { exitCode: businessExit || exported.exitCode, run: exported.run ?? recordedRun, hasMore, pages };
  }

  async #execute(signal: AbortSignal, allPages: boolean, command: "sync" | "retry"): Promise<EngineResult> {
    const store = await SqliteStateStore.open(this.#root, this.#registry);
    const startedAt = this.#clock.now();
    const visited = new Set<NoteId>();
    const attempted = new Set<NoteId>();
    const listAttempts: CaptureAttempt[] = [];
    let pages = 0;
    let blocker: ErrorCategory | null = null;
    let processed = 0;
    try {
      const current = this.#state(store);
      if (command === "sync" && this.#minimumIntervalMs > 0 && current.nextAllowedAt !== null && startedAt < current.nextAllowedAt) return { exitCode: 0, run: ephemeralRun(this.#scope, "not_due", startedAt, startedAt) };
      const initializing = store.beginImmediate({ command, scope: this.#scope });
      try { store.upsertAccount(initializing, this.#source.account); store.commitCanonical(initializing); }
      catch (error) { try { store.rollback(initializing); } catch { /* preserve first failure */ } throw error; }
      if (await this.#paused(signal)) return this.#finish(store, command, [], startedAt, "PAUSED", pages);
      if (current.stopReason) return this.#finish(store, command, [], startedAt, current.stopReason, pages);
      const snapshot = store.openReadSnapshot();
      let pending: readonly NoteId[];
      try {
        pending = [...snapshot.enumerateAccountTasks(accountPartition(this.#scope))]
          .filter((task) => sameScope(task.scope, this.#scope) && (command === "retry" ? task.status !== "done" && task.status !== "skipped" : task.status === "pending" || task.status === "paused"))
          .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.noteId.localeCompare(b.noteId))
          .slice(0, command === "retry" ? this.#limit : undefined).map((task) => task.noteId);
      } finally { snapshot.close(); }
      const capture = async (ids: readonly NoteId[]) => {
        for (const noteId of ids) {
          visited.add(noteId);
          if (attempted.has(noteId)) continue;
          if (await this.#paused(signal)) { blocker = "PAUSED"; break; }
          if (this.#itemDelayMs > 0 && processed > 0) {
            try { await this.#clock.sleep(this.#itemDelayMs, signal); }
            catch (error) { if (!signal.aborted) throw error; blocker = "PAUSED"; break; }
          }
          if (await this.#paused(signal)) { blocker = "PAUSED"; break; }
          attempted.add(noteId);
          const category = await this.#capture(store, command, noteId, signal);
          processed += 1;
          if (category && !["DETAIL", "NETWORK", "MEDIA"].includes(category)) { blocker = category; break; }
        }
      };
      await capture(pending);
      if (command === "sync" && blocker === null) {
        const cursors = new Set<string | null>();
        do {
          if (await this.#paused(signal)) { blocker = "PAUSED"; break; }
          const state = this.#state(store);
          const requestCursor = state.progress.phase === "head" ? null : state.progress.cursor;
          if (pages > 0 && this.#source.hasListPage?.(this.#scope, requestCursor) === false) break;
          if (cursors.has(requestCursor)) { blocker = "PROTOCOL"; this.#recordStop(store, command, blocker); break; }
          cursors.add(requestCursor);
          let page: OfflineListPage;
          const listStartedAt = this.#clock.now();
          try { page = await this.#source.client.listPage(this.#scope, requestCursor, this.#limit, signal); }
          catch (error) {
            blocker = signal.aborted ? "PAUSED" : adapterCategory(error, "NETWORK");
            const collector = error instanceof OfflineAdapterError && error.collector !== undefined ? error.collector : this.#source.listCollector ?? null;
            listAttempts.push({ attemptId: makeRunId("list"), collector, startedAt: listStartedAt, finishedAt: this.#clock.now(), outcome: blocker === "PAUSED" ? "paused" : "failed", category: blocker });
            this.#recordStop(store, command, blocker, retryAtFrom(error)); break;
          }
          if (!sameScope(page.scope, this.#scope) || page.requestCursor !== requestCursor || new Set(page.items.map((item) => item.noteId)).size !== page.items.length) throw new SafeError("INVALID_INPUT", "page response provenance mismatch");
          const protocol = page.hasMore && (page.nextCursor === null || page.nextCursor === page.requestCursor);
          listAttempts.push({ attemptId: makeRunId("list"), collector: page.listCollector === undefined ? this.#source.listCollector ?? null : page.listCollector, startedAt: listStartedAt, finishedAt: this.#clock.now(), outcome: protocol ? "failed" : "done", category: protocol ? "PROTOCOL" : null });
          const ids = this.#checkpoint(store, page, protocol, attempted);
          for (const id of ids) visited.add(id);
          pages += 1;
          if (protocol) { blocker = "PROTOCOL"; break; }
          await capture(ids);
          if (blocker !== null || !allPages || this.#state(store).progress.phase === "head") break;
        } while (true);
      }
      return await this.#finish(store, command, [...visited], startedAt, blocker, pages, listAttempts);
    } finally { store.close(); }
  }

  runPage(signal: AbortSignal): Promise<EngineResult> { return this.#execute(signal, false, "sync"); }
  runAll(signal: AbortSignal): Promise<EngineResult> { return this.#execute(signal, true, "sync"); }
  retryFailures(signal: AbortSignal): Promise<EngineResult> { return this.#execute(signal, false, "retry"); }
}
