import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MarkdownExporter,
  JsonExporter,
  bytesIterable,
  computeContentHash,
  createValidatedNoteRank,
  noteCsvRowDigest,
  decodeAccountId,
  decodeIsoDateTime,
  decodeNoteId,
  decodePartitionScope,
  decodeSha256,
  deriveMembershipNameObservations,
  indexEntryDigest,
  type Account,
  type Note,
  type NoteManifest,
  type PartitionScope,
  type RunRecord,
  type SqliteWriteSnapshot,
} from "../src/index.ts";
import type { FileContentAddressedObjectStore } from "../src/object-store.ts";

export async function tempRoot(label = "rednote-3a-"): Promise<string> { return realpath(await mkdtemp(path.join(tmpdir(), label))); }
export const time1 = decodeIsoDateTime("2026-01-01T00:00:00.000Z");
export const time2 = decodeIsoDateTime("2026-01-02T00:00:00.000Z");

export function makeScope(account = "accA", target: "posted" | "collected" | "liked" | "collected_album" = "liked", board: string | null = null): PartitionScope {
  return decodePartitionScope({ hostId: "xhs", accountId: account, target, boardId: target === "collected_album" ? (board ?? "boardA") : null });
}

export function makeAccount(account = "accA", displayName: string | null = "Alice", first = time1, last = time2): Account {
  return Object.freeze({ schemaVersion: 1, hostId: "xhs", accountId: decodeAccountId(account), displayName, firstSeenAt: first, lastSeenAt: last });
}

export function makeNote(account = "accA", id = "noteA", captured = time1, body = "synthetic body"): Note {
  const base: Note = {
    schemaVersion: 1,
    hostId: "xhs",
    accountId: decodeAccountId(account),
    noteId: decodeNoteId(id),
    publicUrl: `https://www.xiaohongshu.com/explore/${id}`,
    title: "Synthetic",
    body,
    noteType: "text",
    author: { id: "authorA", name: "Author", publicUrl: null },
    publishedAt: time1,
    updatedAt: time1,
    capturedAt: captured,
    tags: ["test"],
    metrics: { liked: 1, collected: null, commented: 0, shared: null },
    memberships: [{ target: "liked", boardId: null, boardName: null, observedAt: captured }],
    media: [],
    contentHash: decodeSha256("0".repeat(64)),
  };
  return Object.freeze({ ...base, contentHash: computeContentHash(base) });
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function makeManifest(objects: FileContentAddressedObjectStore, account = "accA", id = "noteA", body = "synthetic body"): Promise<NoteManifest> {
  const note = makeNote(account, id, time1, body);
  const rank = createValidatedNoteRank(note, time1);
  const signal = new AbortController().signal;
  const json = await objects.put(bytesIterable(await collect(new JsonExporter().render(note))), "ignored/json", signal);
  const markdown = await objects.put(bytesIterable(await collect(new MarkdownExporter().render(note))), "ignored/markdown", signal);
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    accountId: note.accountId,
    hostId: note.hostId,
    noteId: note.noteId,
    canonicalNote: note,
    semanticSourceRank: rank,
    membershipNameObservations: deriveMembershipNameObservations(note),
    mediaSlots: Object.freeze([]),
    artifacts: { json, markdown },
    indexEntrySha256: indexEntryDigest(note),
    csvRowSha256: noteCsvRowDigest(note),
  });
}

export function withMergeCandidates<T extends { readonly manifests: readonly NoteManifest[] }>(mutation: T, mediaSetComplete = true): T & { readonly candidates: readonly import("../src/index.ts").ValidatedMergeCandidateInput[]; readonly failureOccurrences: readonly { readonly failure: import("../src/index.ts").FailureRecord }[]; readonly failureResolutions: readonly import("../src/index.ts").FailureRecord[] } {
  const failures = "failures" in mutation && Array.isArray(mutation.failures) ? mutation.failures as readonly import("../src/index.ts").FailureRecord[] : [];
  return Object.freeze({ ...mutation, candidates: Object.freeze(mutation.manifests.map((manifest) => Object.freeze({ note: manifest.canonicalNote, sourceRank: manifest.semanticSourceRank as import("../src/index.ts").ValidatedMergeCandidateInput["sourceRank"], mediaSlots: manifest.mediaSlots, mediaSetComplete }))), failureOccurrences: Object.freeze(failures.filter((failure) => failure.resolvedAt === null).map((failure) => Object.freeze({ failure }))), failureResolutions: Object.freeze(failures.filter((failure) => failure.resolvedAt !== null)) });
}

export function makeRun(scope: PartitionScope, command: "sync" | "retry" | "skip" | "ack" = "sync", runId = "runA"): RunRecord {
  return Object.freeze({ runId, command, account: { hostId: scope.hostId, accountId: scope.accountId }, scope, outcome: "committed", startedAt: time1, finishedAt: time2, safeErrorCategory: null, listed: 1, done: 1, partial: 0, failed: 0, skipped: 0 });
}

export function issueBusinessResult(store: import("../src/index.ts").SqliteStateStore, tx: import("../src/index.ts").SqliteWriteSnapshot, run: RunRecord, primaryNoteIds: readonly import("../src/index.ts").NoteId[] = []): import("../src/index.ts").BusinessResult {
  return store.prepareBusinessResult(tx, { runId: run.runId, outcome: run.outcome === "committed_with_warnings" ? "committed" : run.outcome as import("../src/index.ts").BusinessResultRequest["outcome"], startedAt: run.startedAt, finishedAt: run.finishedAt, safeErrorCategory: run.safeErrorCategory, listed: run.listed, done: run.done, partial: run.partial, failed: run.failed, skipped: run.skipped, primaryNoteIds });
}
