import { randomBytes } from "node:crypto";
import { isScopePaused } from "./control.js";
import { SafeError } from "./errors.js";
import { renderNoteJsonBytes, renderNoteMarkdownBytes } from "./exporters.js";
import { canResolveMediaFailure, computeFailureId, indexEntryDigest, mergeCanonicalNote, mergeFailure, noteCsvRowDigest } from "./merge.js";
import { bytesIterable, FileMediaStore,                                      } from "./object-store.js";
import { assertFixtureSession, OfflineAdapterError,                                         } from "./offline-input.js";
import { transitionSyncProgress } from "./progress.js";
import { createProjectionBoundary, createProjectors, isProjectionPaused, projectAccountInOrder, restoreProjectionAttempt, settleProjectionAttempt,                                                                                                  } from "./projectors.js";
import { MemorySecretRegistry } from "./secrets.js";
import { SqliteStateStore,                                                                                                             } from "./state-store.js";
import {
  accountPartition,
  decodeIsoDateTime,
  decodePartitionScope,
  initialProgress,
  sameAccount,
  sameScope,
               
                  
                     
                     
                   
             
                      
              
                    
                      
                  
                 
                 
                  
} from "./types.js";

                              
                     
                                                                  
 

export const systemEngineClock              = Object.freeze({
  now: () => decodeIsoDateTime(new Date().toISOString()),
  sleep: (milliseconds, signal) => new Promise      ((resolve, reject) => {
    if (signal.aborted) { reject(new SafeError("STATE", "sync interrupted")); return; }
    const finish = () => { signal.removeEventListener("abort", interrupted); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const interrupted = () => { clearTimeout(timer); signal.removeEventListener("abort", interrupted); reject(new SafeError("STATE", "sync interrupted")); };
    signal.addEventListener("abort", interrupted, { once: true });
  }),
});

                                    
                        
                                 
                                   
                          
                               
                                      
                                
                                           
                                                                                                 
                                                                                                                                                                             
                                                                                                     
 

                                                                                    

                      
                                        
                                                          
                                         
                                                     
                                                 
                                              
                                         
 

function makeRunId(prefix        )         {
  const hex = randomBytes(12).toString("hex");
  return `${prefix}.${hex.slice(0, 8)}.${hex.slice(8, 16)}.${hex.slice(16)}`;
}
function ephemeralRun(scope                , outcome           , startedAt             , finishedAt             )            {
  return Object.freeze({ runId: makeRunId("run"), command: "sync", account: accountPartition(scope), scope, outcome, startedAt, finishedAt, safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 });
}
function terminal(status                      )          { return status === "done" || status === "partial" || status === "skipped"; }

function stateFor(scope                , prior                               )                         {
  if (prior) return prior;
  const common = { schemaVersion: 1         , ...scope, revision: 0, progress: initialProgress(), stopReason: null, lastAttemptAt: null, lastSuccessfulAt: null, nextAllowedAt: null };
  return scope.target === "collected_album" ? Object.freeze({ ...common, boardName: null }) : Object.freeze(common);
}

function future(now             , milliseconds        )                     {
  if (milliseconds === 0) return null;
  return decodeIsoDateTime(new Date(new Date(now).getTime() + milliseconds).toISOString());
}

function occurrence(scope                , noteId        , category               , now             , slot                            , rank                             )                {
  const media = category === "MEDIA";
  const base = {
    schemaVersion: 1         ,
    scope,
    noteId,
    mediaSlot: slot,
    sourceRank: rank,
    category,
    stage: media ? "media"          : category === "EXPORT" ? "export"          : "detail"         ,
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

function adapterCategory(error         , fallback                      )                {
  if (error instanceof OfflineAdapterError) return error.category;
  if (error instanceof SafeError) throw error;
  if (error !== null && typeof error === "object" && "category" in error) {
    const category = (error                                   ).category;
    if (typeof category === "string" && ["AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "EXPORT"].includes(category)) return category                 ;
  }
  return fallback;
}

function retryAtFrom(error         )                     {
  if (error instanceof OfflineAdapterError) return error.retryAt;
  return null;
}

function durableStop(category               )                          {
  return category === "AUTH_REQUIRED" || category === "RATE_LIMITED" || category === "PROTOCOL" ? category : null;
}

function statusForFailures(failures                          )                       {
  if (failures.length === 0) return "done";
  return failures.some((failure) => failure.stage !== "media") ? "failed" : "partial";
}

async function verifiedDuplicate(tx                     , objects                                 , scope                , noteId        )                             {
  const task = tx.loadTask(scope, noteId);
  if (!task || !terminal(task.status)) return null;
  if (task.status === "skipped") return task;
  const manifest = tx.loadManifest(accountPartition(scope), noteId);
  if (!manifest) throw new SafeError("CANONICAL_INTEGRITY", "terminal task is missing its manifest");
  const refs = [manifest.artifacts.json, manifest.artifacts.markdown, ...manifest.mediaSlots.flatMap((slot) => slot.media?.object ? [slot.media.object] : [])];
  for (const ref of refs) if (!await objects.verify(ref)) throw new SafeError("CANONICAL_INTEGRITY", "terminal task object verification failed");
  return task;
}

function taskRecord(scope                , noteId        , prior                   , status                      , failures                          , now             , incrementAttempt = true)             {
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
  });
}

async function writeManifest(objects                                 , prior                     , detail               , slots                           , signal             )                                                                                                 {
  const candidate                               = Object.freeze({ note: detail.semanticNote, sourceRank: detail.sourceRank, mediaSlots: Object.freeze(slots), mediaSetComplete: detail.mediaSetComplete });
  const merged = mergeCanonicalNote(prior, candidate);
  const json = await objects.put(bytesIterable(renderNoteJsonBytes(merged.note, objects.registry)), null, signal);
  const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(merged.note, objects.registry)), null, signal);
  const manifest               = Object.freeze({ schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, accountId: merged.note.accountId, hostId: merged.note.hostId, noteId: merged.note.noteId, canonicalNote: merged.note, semanticSourceRank: merged.sourceRank, membershipNameObservations: merged.membershipNameObservations, mediaSlots: merged.mediaSlots, artifacts: Object.freeze({ json, markdown }), indexEntrySha256: indexEntryDigest(merged.note), csvRowSha256: noteCsvRowDigest(merged.note) });
  return { candidate, manifest };
}

export class SyncEngine {
           #root        ;
           #scope                ;
           #session                ;
           #limit        ;
           #clock             ;
           #minimumIntervalMs        ;
           #itemDelayMs        ;
           #registry                      ;
           #projectionBoundaryObserver                                                                   ;
           #projectionRecoveryObserver                                                                                                                                               ;
           #projectionSettlementObserver                                                                     ;

  constructor(options                   ) {
    this.#root = options.root;
    this.#scope = decodePartitionScope(options.scope);
    this.#session = options.session;
    this.#limit = options.limit ?? 5;
    this.#clock = options.clock ?? systemEngineClock;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? 600_000;
    this.#itemDelayMs = options.itemDelayMs ?? 0;
    this.#registry = options.registry ?? new MemorySecretRegistry();
    this.#projectionBoundaryObserver = options.projectionBoundaryObserver ?? null;
    this.#projectionRecoveryObserver = options.projectionRecoveryObserver ?? null;
    this.#projectionSettlementObserver = options.projectionSettlementObserver ?? null;
    assertFixtureSession(this.#session);
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 10) throw new SafeError("INVALID_INPUT", "sync limit must be 1..10");
    if (!Number.isSafeInteger(this.#minimumIntervalMs) || this.#minimumIntervalMs < 0 || !Number.isSafeInteger(this.#itemDelayMs) || this.#itemDelayMs < 0) throw new SafeError("INVALID_INPUT", "invalid pacing policy");
    if (!sameAccount(this.#session.account, this.#scope)) throw new SafeError("INVALID_INPUT", "offline session account mismatch");
  }

  async #paused(signal             )                   { return signal.aborted || await isScopePaused(this.#root, this.#scope); }

  async #seal(store                  , objects                                 , tx                     , request                                                                                                                                                                                                                              , signal                     = null)                        {
    const summaryTasks = request.primaryNoteIds.map((id) => tx.loadTask(this.#scope, id));
    const counters = { listed: request.primaryNoteIds.length, done: summaryTasks.filter((task) => task?.status === "done").length, partial: summaryTasks.filter((task) => task?.status === "partial").length, failed: summaryTasks.filter((task) => task?.status === "failed").length, skipped: summaryTasks.filter((task) => task?.status === "skipped").length };
    const business = store.prepareBusinessResult(tx, { runId: makeRunId("run"), outcome: request.outcome, startedAt: request.startedAt, finishedAt: request.finishedAt, safeErrorCategory: request.category, ...counters, primaryNoteIds: request.primaryNoteIds });
    const account = accountPartition(this.#scope);
    const boundary = signal === null || request.outcome === "paused" ? null : createProjectionBoundary(async (point) => {
      await this.#projectionBoundaryObserver?.(point);
      return this.#paused(signal);
    }, this.#projectionSettlementObserver);
    const batch = await projectAccountInOrder(createProjectors(this.#root, objects), tx, account, tx.accountGeneration(account) + 1, business, boundary);
    store.finalizeAccount(tx, batch);
    store.commit(tx);
    await settleProjectionAttempt(boundary, this.#root);
    if (batch.outcomes.some((outcome) => !outcome.complete) || batch.finalRun.outcome === "committed_with_warnings") return Object.freeze({ exitCode: 9, run: batch.finalRun });
    const exitCode = batch.finalRun.outcome === "paused" ? 7 : batch.finalRun.safeErrorCategory === "AUTH_REQUIRED" ? 3 : batch.finalRun.safeErrorCategory === "RATE_LIMITED" ? 4 : batch.finalRun.safeErrorCategory === "EXPORT" || batch.finalRun.safeErrorCategory === "STATE" || batch.finalRun.safeErrorCategory === "INTERNAL" ? 6 : batch.finalRun.outcome === "blocked" || batch.finalRun.outcome === "failed" ? 5 : 0;
    return Object.freeze({ exitCode, run: batch.finalRun });
  }

  async #replayProjectionPause(store                  , objects                                 , tx                     , startedAt             )                        {
    const account = accountPartition(this.#scope);
    if (store.loadAccount(tx, account.hostId, account.accountId) === null) store.upsertAccount(tx, this.#session.account);
    return this.#seal(store, objects, tx, { outcome: "paused", category: "PAUSED", startedAt, finishedAt: this.#clock.now(), primaryNoteIds: [] });
  }

  async #sealWithProjectionPauseRecovery(store                  , objects                                 , tx                     , request                                                                                                                                                                                                                              , signal             , command                  )                        {
    try { return await this.#seal(store, objects, tx, request, signal); }
    catch (error) {
      if (!isProjectionPaused(error)) throw error;
      try {
        store.rewindWriteForPausedReplay(tx);
        await this.#projectionRecoveryObserver?.(Object.freeze({ phase: "after_rewind_before_restore"          }));
        await restoreProjectionAttempt(error, this.#root, this.#projectionRecoveryObserver);
        await this.#projectionRecoveryObserver?.(Object.freeze({ phase: "after_restore"          }));
        return await this.#replayProjectionPause(store, objects, tx, request.startedAt);
      } catch (recoveryError) {
        try { store.rollback(tx); } catch { /* preserve recovery error */ }
        if (recoveryError instanceof SafeError && (recoveryError.code === "STATE" || recoveryError.code === "SECURITY_BOUNDARY" || recoveryError.code === "CANONICAL_INTEGRITY")) throw recoveryError;
        throw new SafeError("STATE", "projection pause recovery failed");
      }
    }
  }

  async #processItem(tx                     , objects                                 , mediaStore                , noteId        , detail               , existingFailures                          , now             , signal             )                      {
    const priorTask = tx.loadTask(this.#scope, noteId);
    const priorManifest = tx.loadManifest(accountPartition(this.#scope), noteId);
    const slots                   = [];
    const rawOccurrences                  = [];
    for (const source of detail.mediaSources) {
      if (await this.#paused(signal)) return { tasks: [priorTask ?? taskRecord(this.#scope, noteId, null, "paused", [], now)], candidate: null, manifest: null, occurrences: [], resolutions: [], failures: [], blocker: "PAUSED" };
      try {
        const stored = await mediaStore.put(source, signal);
        const media        = Object.freeze({ ...stored, mediaId: source.mediaId });
        slots.push(Object.freeze({ slot: source.slot, sourceRank: detail.sourceRank, media, tombstone: false }));
        if (await this.#paused(signal)) return { tasks: [priorTask ?? taskRecord(this.#scope, noteId, null, "paused", [], now)], candidate: null, manifest: null, occurrences: [], resolutions: [], failures: [], blocker: "PAUSED" };
      } catch (error) {
        if (error instanceof SafeError && (error.code === "SECURITY_BOUNDARY" || error.code === "CANONICAL_INTEGRITY" || error.code === "STATE")) throw error;
        const failed        = Object.freeze({ mediaId: source.mediaId, kind: source.slot.kind, ordinal: source.slot.ordinal, status: "failed", extension: null, object: null });
        slots.push(Object.freeze({ slot: source.slot, sourceRank: detail.sourceRank, media: failed, tombstone: false }));
        rawOccurrences.push(occurrence(this.#scope, noteId, "MEDIA", now, source.slot, detail.sourceRank));
      }
    }
    if (await this.#paused(signal)) return { tasks: [priorTask ?? taskRecord(this.#scope, noteId, null, "paused", [], now)], candidate: null, manifest: null, occurrences: [], resolutions: [], failures: [], blocker: "PAUSED" };
    const { candidate, manifest } = await writeManifest(objects, priorManifest, detail, slots, signal);
    const existing = new Map(existingFailures.map((failure) => [failure.failureId, failure]));
    const occurrences = rawOccurrences.map((failure) => Object.freeze({ failure }));
    const finalOccurrences = rawOccurrences.map((failure) => mergeFailure(existing.get(failure.failureId) ?? null, failure));
    const occurrenceIds = new Set(finalOccurrences.map((failure) => failure.failureId));
    const resolutions = existingFailures.filter((failure) => {
      if (occurrenceIds.has(failure.failureId)) return false;
      if (failure.stage !== "media") return sameScope(failure.scope, this.#scope);
      const accepted = manifest.mediaSlots.find((slot) => failure.mediaSlot !== null
        && slot.slot.kind === failure.mediaSlot.kind && slot.slot.ordinal === failure.mediaSlot.ordinal
        && (slot.tombstone || slot.media?.status === "stored"));
      return accepted !== undefined && canResolveMediaFailure(failure, accepted.sourceRank, true);
    }).map((failure) => Object.freeze({ ...failure, resolvedAt: now, resolvedReason: "repaired"          }));
    const resolvedIds = new Set(resolutions.map((failure) => failure.failureId));
    const unresolved = [...existingFailures.filter((failure) => !resolvedIds.has(failure.failureId) && !occurrenceIds.has(failure.failureId)), ...finalOccurrences];
    const touchedScopes = new Map                        ();
    touchedScopes.set(JSON.stringify(this.#scope), this.#scope);
    for (const resolution of resolutions) touchedScopes.set(JSON.stringify(resolution.scope), resolution.scope);
    const tasks = [...touchedScopes.values()].flatMap((scope) => {
      const prior = tx.loadTask(scope, noteId);
      if (!sameScope(scope, this.#scope) && prior === null) return [];
      const related = unresolved.filter((failure) => sameScope(failure.scope, scope));
      return [taskRecord(scope, noteId, prior, statusForFailures(related), related, now, sameScope(scope, this.#scope))];
    });
    return { tasks, candidate, manifest, occurrences, resolutions, failures: [...finalOccurrences, ...resolutions], blocker: null };
  }

  async #commitStateOutcome(store                  , objects                                 , tx                     , current                        , startedAt             , category               , signal             , command                  , retryAt                     = null)                        {
    const now = this.#clock.now();
    const nextState = Object.freeze({
      ...current,
      revision: current.revision + 1,
      progress: current.progress,
      stopReason: durableStop(category) ?? current.stopReason,
      lastAttemptAt: now,
      lastSuccessfulAt: current.lastSuccessfulAt,
      nextAllowedAt: category === "RATE_LIMITED" ? (retryAt ?? current.nextAllowedAt) : durableStop(category) === null ? future(now, this.#minimumIntervalMs) : current.nextAllowedAt,
    });
    const mutation                    = Object.freeze({ scope: this.#scope, expectedStateRevision: current.revision, expectedManifestRevisions: Object.freeze({}), nextState, candidates: Object.freeze([]), manifests: Object.freeze([]), tasks: Object.freeze([]), failureOccurrences: Object.freeze([]), failureResolutions: Object.freeze([]), failures: Object.freeze([]) });
    store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, mutation));
    return this.#sealWithProjectionPauseRecovery(store, objects, tx, { outcome: category === "PAUSED" ? "paused" : "blocked", category, startedAt, finishedAt: now, primaryNoteIds: [] }, signal, command);
  }

  async runPage(signal             )                        {
    const store = await SqliteStateStore.open(this.#root, this.#registry);
    const objects = store.objectStore();
    const mediaStore = new FileMediaStore(objects);
    let tx                             = null;
    const startedAt = this.#clock.now();
    try {
      tx = store.beginImmediate({ command: "sync", scope: this.#scope });
      const priorState = tx.loadState(this.#scope);
      const current = stateFor(this.#scope, priorState);
      if (await this.#paused(signal)) {
        if (priorState === null) store.upsertAccount(tx, this.#session.account);
        const result = await this.#seal(store, objects, tx, { outcome: "paused", category: "PAUSED", startedAt, finishedAt: this.#clock.now(), primaryNoteIds: [] });
        tx = null;
        return result;
      }
      const now = this.#clock.now();
      if (current.nextAllowedAt !== null && now < current.nextAllowedAt) {
        store.rollback(tx);
        tx = null;
        return Object.freeze({ exitCode: 0, run: ephemeralRun(this.#scope, "not_due", startedAt, now) });
      }
      if (current.stopReason !== null) {
        const result = await this.#commitStateOutcome(store, objects, tx, current, startedAt, current.stopReason, signal, "sync");
        tx = null;
        return result;
      }
      store.upsertAccount(tx, this.#session.account);
      const requestCursor = current.progress.phase === "head" ? null : current.progress.cursor;
      let page;
      try { page = await this.#session.client.listPage(this.#scope, requestCursor, this.#limit); }
      catch (error) {
        const category = adapterCategory(error, "NETWORK");
        const result = await this.#commitStateOutcome(store, objects, tx, current, startedAt, category, signal, "sync", retryAtFrom(error));
        tx = null;
        return result;
      }
      if (!sameScope(page.scope, this.#scope) || page.requestCursor !== requestCursor || new Set(page.items.map((item) => item.noteId)).size !== page.items.length) throw new SafeError("INVALID_INPUT", "page response provenance mismatch");
      const noteIds = page.items.map((item) => item.noteId);
      const duplicates = new Map                    ();
      for (const noteId of noteIds) { const task = await verifiedDuplicate(tx, objects, this.#scope, noteId); if (task) duplicates.set(noteId, task); }
      let protocol = false;
      if (page.hasMore && (page.nextCursor === null || page.nextCursor === page.requestCursor)) protocol = true;
      const existingFailures = [...tx.enumerateUnresolvedFailures(accountPartition(this.#scope))];
      const tasks               = [];
      const candidates                                 = [];
      const manifests                 = [];
      const occurrences                      = [];
      const resolutions                  = [];
      const failures                  = [];
      let blocker                       = protocol ? "PROTOCOL" : null;
      let blockerRetryAt                     = null;
      for (const [index, item] of page.items.entries()) {
        const duplicate = duplicates.get(item.noteId);
        if (duplicate) { tasks.push(duplicate); continue; }
        if (blocker !== null || await this.#paused(signal)) {
          const prior = tx.loadTask(this.#scope, item.noteId);
          if (prior) tasks.push(prior);
          else tasks.push(taskRecord(this.#scope, item.noteId, null, blocker === null ? "paused" : "pending", [], now));
          if (blocker === null) blocker = "PAUSED";
          continue;
        }
        if (this.#itemDelayMs > 0 && index > 0) {
          try { await this.#clock.sleep(this.#itemDelayMs, signal); }
          catch (error) { if (!signal.aborted) throw error; blocker = "PAUSED"; tasks.push(tx.loadTask(this.#scope, item.noteId) ?? taskRecord(this.#scope, item.noteId, null, "paused", [], now)); continue; }
          if (await this.#paused(signal)) { blocker = "PAUSED"; tasks.push(tx.loadTask(this.#scope, item.noteId) ?? taskRecord(this.#scope, item.noteId, null, "paused", [], now)); continue; }
        }
        try {
          const detail = await this.#session.client.getDetail(this.#scope, item.noteId);
          if (detail.note.noteId !== item.noteId || !sameAccount(detail.note, this.#scope)) throw new SafeError("INVALID_INPUT", "detail provenance mismatch");
          const related = existingFailures.filter((failure) => failure.noteId === item.noteId);
          const result = await this.#processItem(tx, objects, mediaStore, item.noteId, detail, related, now, signal);
          tasks.push(...result.tasks);
          if (result.candidate && result.manifest) { candidates.push(result.candidate); manifests.push(result.manifest); }
          occurrences.push(...result.occurrences); resolutions.push(...result.resolutions); failures.push(...result.failures);
          if (result.blocker) blocker = result.blocker;
        } catch (error) {
          if (signal.aborted) { tasks.push(tx.loadTask(this.#scope, item.noteId) ?? taskRecord(this.#scope, item.noteId, null, "paused", [], now)); blocker = "PAUSED"; continue; }
          const category = adapterCategory(error, "DETAIL");
          blockerRetryAt = retryAtFrom(error);
          const raw = occurrence(this.#scope, item.noteId, category, now, null, null);
          const prior = existingFailures.find((failure) => failure.failureId === raw.failureId) ?? null;
          const final = mergeFailure(prior, raw);
          occurrences.push(Object.freeze({ failure: raw })); failures.push(final);
          const unresolved = [...existingFailures.filter((failure) => sameScope(failure.scope, this.#scope) && failure.noteId === item.noteId && failure.failureId !== final.failureId), final];
          tasks.push(taskRecord(this.#scope, item.noteId, tx.loadTask(this.#scope, item.noteId), "failed", unresolved, now));
          blocker = category;
        }
      }
      if (blocker === null && await this.#paused(signal)) blocker = "PAUSED";
      const allTerminal = blocker === null && tasks.every((task) => terminal(task.status));
      const progress = protocol ? current.progress : transitionSyncProgress(current.progress, { requestCursor: page.requestCursor, nextCursor: page.nextCursor, hasMore: page.hasMore, noteIds, newNoteIds: noteIds.filter((id) => !duplicates.has(id)), allTerminal });
      const stopReason = protocol ? "PROTOCOL" : blocker === null ? current.stopReason : durableStop(blocker) ?? current.stopReason;
      const nextState = Object.freeze({ ...current, revision: current.revision + 1, progress, stopReason, lastAttemptAt: now, lastSuccessfulAt: allTerminal ? now : current.lastSuccessfulAt, nextAllowedAt: blocker === "RATE_LIMITED" ? blockerRetryAt : future(now, this.#minimumIntervalMs) });
      const expectedManifestRevisions                                = Object.create(null);
      for (const manifest of manifests) expectedManifestRevisions[manifest.noteId] = tx.loadManifest(accountPartition(this.#scope), manifest.noteId)?.revision ?? null;
      const mutation                    = Object.freeze({ scope: this.#scope, expectedStateRevision: current.revision, expectedManifestRevisions: Object.freeze(expectedManifestRevisions), nextState, candidates: Object.freeze(candidates), manifests: Object.freeze(manifests), tasks: Object.freeze(tasks), failureOccurrences: Object.freeze(occurrences), failureResolutions: Object.freeze(resolutions), failures: Object.freeze(failures) });
      const plan = store.prepareCanonicalWritePlan(tx, mutation);
      store.putCanonicalMutation(tx, plan);
      const outcome = blocker === "PAUSED" ? "paused" : blocker === null ? "committed" : "blocked";
      const category = blocker === null ? null : blocker;
      const result = await this.#sealWithProjectionPauseRecovery(store, objects, tx, { outcome, category, startedAt, finishedAt: this.#clock.now(), primaryNoteIds: noteIds }, signal, "sync");
      tx = null;
      return result;
    } catch (error) {
      if (tx) { try { store.rollback(tx); } catch { /* preserve original */ } }
      throw error;
    } finally { store.close(); }
  }

  async retryFailures(signal             )                        {
    const store = await SqliteStateStore.open(this.#root, this.#registry);
    const objects = store.objectStore();
    const mediaStore = new FileMediaStore(objects);
    let tx                             = null;
    const startedAt = this.#clock.now();
    try {
      tx = store.beginImmediate({ command: "retry", scope: this.#scope });
      const priorState = tx.loadState(this.#scope);
      const current = stateFor(this.#scope, priorState);
      if (await this.#paused(signal)) {
        if (priorState === null) store.upsertAccount(tx, this.#session.account);
        const result = await this.#seal(store, objects, tx, { outcome: "paused", category: "PAUSED", startedAt, finishedAt: this.#clock.now(), primaryNoteIds: [] });
        tx = null;
        return result;
      }
      if (current.stopReason !== null) {
        const result = await this.#commitStateOutcome(store, objects, tx, current, startedAt, current.stopReason, signal, "retry");
        tx = null;
        return result;
      }
      store.upsertAccount(tx, this.#session.account);
      const selected = tx.retryCandidates(this.#scope, this.#limit);
      const noteIds = [...new Set(selected.map((failure) => failure.noteId))];
      if (noteIds.length === 0) {
        const result = await this.#sealWithProjectionPauseRecovery(store, objects, tx, { outcome: "committed", category: null, startedAt, finishedAt: this.#clock.now(), primaryNoteIds: [] }, signal, "retry");
        tx = null;
        return result;
      }
      const accountFailures = [...tx.enumerateUnresolvedFailures(accountPartition(this.#scope))];
      const tasks               = [];
      const candidates                                 = [];
      const manifests                 = [];
      const occurrences                      = [];
      const resolutions                  = [];
      const failures                  = [];
      let blocker                       = null;
      let blockerRetryAt                     = null;
      const now = this.#clock.now();
      for (const noteId of noteIds) {
        if (blocker !== null) break;
        if (await this.#paused(signal)) { blocker = "PAUSED"; break; }
        try {
          const detail = await this.#session.retrySource.get(this.#scope, noteId);
          if (detail.note.noteId !== noteId || !sameAccount(detail.note, this.#scope)) throw new SafeError("INVALID_INPUT", "retry detail provenance mismatch");
          const related = accountFailures.filter((failure) => failure.noteId === noteId);
          const result = await this.#processItem(tx, objects, mediaStore, noteId, detail, related, now, signal);
          tasks.push(...result.tasks);
          if (result.candidate && result.manifest) { candidates.push(result.candidate); manifests.push(result.manifest); }
          occurrences.push(...result.occurrences); resolutions.push(...result.resolutions); failures.push(...result.failures);
          if (result.blocker) blocker = result.blocker;
        } catch (error) {
          if (signal.aborted) { blocker = "PAUSED"; break; }
          const category = adapterCategory(error, "DETAIL");
          blockerRetryAt = retryAtFrom(error);
          const raw = occurrence(this.#scope, noteId, category, now, null, null);
          const priorFailure = accountFailures.find((failure) => failure.failureId === raw.failureId) ?? null;
          const final = mergeFailure(priorFailure, raw);
          occurrences.push(Object.freeze({ failure: raw })); failures.push(final);
          const unresolved = [...accountFailures.filter((failure) => sameScope(failure.scope, this.#scope) && failure.noteId === noteId && failure.failureId !== final.failureId), final];
          tasks.push(taskRecord(this.#scope, noteId, tx.loadTask(this.#scope, noteId), "failed", unresolved, now));
          blocker = category;
        }
      }
      if (blocker === null && await this.#paused(signal)) blocker = "PAUSED";
      const projectedFailures = new Map(accountFailures.filter((failure) => sameScope(failure.scope, this.#scope)).map((failure) => [failure.failureId, failure]));
      for (const failure of failures) {
        if (failure.resolvedAt === null) projectedFailures.set(failure.failureId, failure);
        else projectedFailures.delete(failure.failureId);
      }
      const projectedOutstanding = [...projectedFailures.values()];
      if (blocker === null) blocker = projectedOutstanding.find((failure) => failure.stage !== "media")?.category ?? null;
      const nextState = Object.freeze({ ...current, revision: current.revision + 1, progress: current.progress, stopReason: blocker === null ? current.stopReason : durableStop(blocker) ?? current.stopReason, lastAttemptAt: now, lastSuccessfulAt: blocker === null ? now : current.lastSuccessfulAt, nextAllowedAt: blocker === "RATE_LIMITED" ? blockerRetryAt : current.nextAllowedAt });
      const expectedManifestRevisions                                = Object.create(null);
      for (const manifest of manifests) expectedManifestRevisions[manifest.noteId] = tx.loadManifest(accountPartition(this.#scope), manifest.noteId)?.revision ?? null;
      const mutation                    = Object.freeze({ scope: this.#scope, expectedStateRevision: current.revision, expectedManifestRevisions: Object.freeze(expectedManifestRevisions), nextState, candidates: Object.freeze(candidates), manifests: Object.freeze(manifests), tasks: Object.freeze(tasks), failureOccurrences: Object.freeze(occurrences), failureResolutions: Object.freeze(resolutions), failures: Object.freeze(failures) });
      store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, mutation));
      const remaining = [...tx.enumerateUnresolvedFailures(accountPartition(this.#scope))].filter((failure) => sameScope(failure.scope, this.#scope));
      const outcome = blocker === "PAUSED" ? "paused" : blocker === null ? "committed" : "blocked";
      const primaryNoteIds = tasks.filter((task) => sameScope(task.scope, this.#scope)).map((task) => task.noteId);
      const result = await this.#sealWithProjectionPauseRecovery(store, objects, tx, { outcome, category: blocker, startedAt, finishedAt: this.#clock.now(), primaryNoteIds }, signal, "retry");
      tx = null;
      if (result.exitCode === 0 && remaining.length > 0) return Object.freeze({ ...result, exitCode: 9 });
      return result;
    } catch (error) {
      if (tx) { try { store.rollback(tx); } catch { /* preserve original */ } }
      throw error;
    } finally { store.close(); }
  }
}
