import { randomBytes } from "node:crypto";
import { SafeError } from "./errors.ts";
import type { FileContentAddressedObjectStore } from "./object-store.ts";
import { createProjectors, projectAccountInOrder } from "./projectors.ts";
import { MemorySecretRegistry, validateSafeReason } from "./secrets.ts";
import { SqliteStateStore, type CanonicalMutation, type SqliteWriteSnapshot } from "./state-store.ts";
import {
  accountPartition,
  decodeAccountPartition,
  decodeIsoDateTime,
  decodeNoteId,
  decodePartitionScope,
  sameScope,
  type AccountPartition,
  type ErrorCategory,
  type IsoDateTime,
  type NoteId,
  type PartitionScope,
  type RunRecord,
} from "./types.ts";

export interface CommandClock { now(): IsoDateTime }
export const systemCommandClock: CommandClock = Object.freeze({ now: () => decodeIsoDateTime(new Date().toISOString()) });

function runId(prefix: string): string {
  const hex = randomBytes(12).toString("hex");
  return `${prefix}.${hex.slice(0, 8)}.${hex.slice(8, 16)}.${hex.slice(16)}`;
}

async function finish(
  store: SqliteStateStore,
  tx: SqliteWriteSnapshot,
  account: AccountPartition,
  root: string,
  objects: FileContentAddressedObjectStore,
  run: Omit<RunRecord, "command" | "account" | "scope">,
  primaryNoteIds: readonly NoteId[],
): Promise<{ readonly run: RunRecord; readonly exitCode: number }> {
  const business = store.prepareBusinessResult(tx, { ...run, outcome: run.outcome === "committed_with_warnings" ? "committed" : run.outcome, primaryNoteIds });
  const generation = tx.accountGeneration(account) + 1;
  const batch = await projectAccountInOrder(createProjectors(root, objects), tx, account, generation, business);
  store.finalizeAccount(tx, batch);
  store.commit(tx);
  const warning = batch.outcomes.some((outcome) => !outcome.complete) || batch.finalRun.outcome === "committed_with_warnings";
  return { run: batch.finalRun, exitCode: warning ? 9 : 0 };
}

export async function repairViews(root: string, accountInput: AccountPartition, clock: CommandClock = systemCommandClock, registry = new MemorySecretRegistry()): Promise<{ readonly run: RunRecord; readonly exitCode: number }> {
  const account = decodeAccountPartition(accountInput);
  const store = await SqliteStateStore.open(root, registry);
  const objects = store.objectStore();
  let tx: SqliteWriteSnapshot | null = null;
  const startedAt = clock.now();
  try {
    tx = store.beginImmediate({ command: "repair_views", account });
    tx.accountGeneration(account);
    const result = await finish(store, tx, account, root, objects, { runId: runId("repair"), outcome: "committed", startedAt, finishedAt: clock.now(), safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 }, []);
    tx = null;
    return result;
  } catch (error) {
    if (tx) { try { store.rollback(tx); } catch { /* preserve first safe error */ } }
    throw error;
  } finally { store.close(); }
}

export async function acknowledgeStop(root: string, scopeInput: PartitionScope, reason: "AUTH_REQUIRED" | "RATE_LIMITED" | "PROTOCOL", clock: CommandClock = systemCommandClock, registry = new MemorySecretRegistry()): Promise<{ readonly run: RunRecord | null; readonly exitCode: number }> {
  const scope = decodePartitionScope(scopeInput);
  if (!["AUTH_REQUIRED", "RATE_LIMITED", "PROTOCOL"].includes(reason)) throw new SafeError("INVALID_INPUT", "invalid acknowledgement reason");
  const store = await SqliteStateStore.open(root, registry);
  const objects = store.objectStore();
  let tx: SqliteWriteSnapshot | null = null;
  const startedAt = clock.now();
  try {
    tx = store.beginImmediate({ command: "ack", scope });
    const state = tx.loadState(scope);
    if (!state || state.stopReason !== reason) {
      store.rollback(tx);
      tx = null;
      return Object.freeze({ run: null, exitCode: 0 });
    }
    const nextState = Object.freeze({ ...state, revision: state.revision + 1, stopReason: null, nextAllowedAt: null, lastAttemptAt: clock.now() });
    const mutation: CanonicalMutation = Object.freeze({ scope, expectedStateRevision: state.revision, expectedManifestRevisions: Object.freeze({}), nextState, candidates: Object.freeze([]), manifests: Object.freeze([]), tasks: Object.freeze([]), failureOccurrences: Object.freeze([]), failureResolutions: Object.freeze([]), failures: Object.freeze([]) });
    const plan = store.prepareCanonicalWritePlan(tx, mutation);
    store.putCanonicalMutation(tx, plan);
    const result = await finish(store, tx, accountPartition(scope), root, objects, { runId: runId("ack"), outcome: "committed", startedAt, finishedAt: clock.now(), safeErrorCategory: null, listed: 0, done: 0, partial: 0, failed: 0, skipped: 0 }, []);
    tx = null;
    return result;
  } catch (error) {
    if (tx) { try { store.rollback(tx); } catch { /* preserve first safe error */ } }
    throw error;
  } finally { store.close(); }
}

export async function skipTask(root: string, scopeInput: PartitionScope, noteIdInput: NoteId, reason: string, clock: CommandClock = systemCommandClock, registry = new MemorySecretRegistry()): Promise<{ readonly run: RunRecord; readonly exitCode: number }> {
  const scope = decodePartitionScope(scopeInput);
  const noteId = decodeNoteId(noteIdInput);
  const safeReason = validateSafeReason(reason, registry);
  const store = await SqliteStateStore.open(root, registry);
  const objects = store.objectStore();
  let tx: SqliteWriteSnapshot | null = null;
  const startedAt = clock.now();
  try {
    tx = store.beginImmediate({ command: "skip", scope });
    const state = tx.loadState(scope);
    const priorTask = tx.loadTask(scope, noteId);
    if (!state || !priorTask || !sameScope(priorTask.scope, scope)) throw new SafeError("INVALID_INPUT", "task does not exist in scope");
    const now = clock.now();
    const resolutions = [...tx.enumerateUnresolvedFailures(accountPartition(scope))].filter((failure) => sameScope(failure.scope, scope) && failure.noteId === noteId).map((failure) => Object.freeze({ ...failure, resolvedAt: now, resolvedReason: "skipped" as const }));
    const task = Object.freeze({ ...priorTask, status: "skipped" as const, failureIds: Object.freeze([]), skipReason: safeReason, skippedAt: now, updatedAt: now });
    const nextState = Object.freeze({ ...state, revision: state.revision + 1, lastAttemptAt: now });
    const mutation: CanonicalMutation = Object.freeze({ scope, expectedStateRevision: state.revision, expectedManifestRevisions: Object.freeze({}), nextState, candidates: Object.freeze([]), manifests: Object.freeze([]), tasks: Object.freeze([task]), failureOccurrences: Object.freeze([]), failureResolutions: Object.freeze(resolutions), failures: Object.freeze(resolutions) });
    const plan = store.prepareCanonicalWritePlan(tx, mutation);
    store.putCanonicalMutation(tx, plan);
    const result = await finish(store, tx, accountPartition(scope), root, objects, { runId: runId("skip"), outcome: "committed", startedAt, finishedAt: clock.now(), safeErrorCategory: null, listed: 1, done: 0, partial: 0, failed: 0, skipped: 1 }, [noteId]);
    tx = null;
    return result;
  } catch (error) {
    if (tx) { try { store.rollback(tx); } catch { /* preserve first safe error */ } }
    throw error;
  } finally { store.close(); }
}

export function exitCodeForCategory(category: ErrorCategory | null): number {
  if (category === null) return 0;
  if (category === "AUTH_REQUIRED") return 3;
  if (category === "RATE_LIMITED") return 4;
  if (category === "DETAIL" || category === "NETWORK" || category === "PROTOCOL") return 5;
  if (category === "PAUSED") return 7;
  if (category === "BUSY") return 8;
  if (category === "MEDIA" || category === "DERIVED_VIEW") return 9;
  return category === "INVALID_INPUT" ? 2 : 6;
}
