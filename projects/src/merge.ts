import { canonicalJson, sha256Bytes, sha256Canonical, utf8Compare } from "./canonical.ts";
import { SafeError } from "./errors.ts";
import { assertValidatedRankForNote, compareSourceRank, maxSourceRank, type ValidatedSourceRank } from "./rank.ts";
import {
  decodeIsoDateTime,
  decodeSha256,
  sameAccount,
  sameScope,
  type Account,
  type FailureRecord,
  type IsoDateTime,
  type Media,
  type MediaKind,
  type MediaSlotState,
  type MembershipNameObservation,
  type Note,
  type NoteManifest,
  type Sha256,
  type SourceMembership,
  type SourceRank,
  type TaskRecord,
} from "./types.ts";

const MEDIA_ORDER: Readonly<Record<MediaKind, number>> = { cover: 0, image: 1, video: 2 };

function normalizedText(value: string): string { return value.normalize("NFC").replace(/\r\n?/g, "\n"); }
function normalizedNullable(value: string | null): string | null { return value === null ? null : normalizedText(value); }

export function mergeAccount(left: Account, right: Account): Account {
  if (!sameAccount(left, right)) throw new SafeError("INVALID_INPUT", "account merge key mismatch");
  const newer = right.lastSeenAt > left.lastSeenAt ? right : left;
  return Object.freeze({
    schemaVersion: 1,
    accountId: left.accountId,
    hostId: left.hostId,
    displayName: normalizedNullable(newer.displayName),
    firstSeenAt: (left.firstSeenAt < right.firstSeenAt ? left.firstSeenAt : right.firstSeenAt),
    lastSeenAt: (left.lastSeenAt > right.lastSeenAt ? left.lastSeenAt : right.lastSeenAt),
  });
}

function membershipKey(value: SourceMembership): string { return canonicalJson([value.target, value.boardId]); }
function normalizeMembership(value: SourceMembership): SourceMembership {
  if (value.target === "collected_album" && value.boardId === null) throw new SafeError("INVALID_INPUT", "album membership requires board");
  if (value.target !== "collected_album" && value.boardId !== null) throw new SafeError("INVALID_INPUT", "ordinary membership forbids board");
  return Object.freeze({ ...value, boardName: normalizedNullable(value.boardName), observedAt: decodeIsoDateTime(value.observedAt) });
}

function mergeMemberships(left: readonly SourceMembership[], right: readonly SourceMembership[], leftObservations: readonly MembershipNameObservation[] = [], rightObservations: readonly MembershipNameObservation[] = []): { readonly memberships: readonly SourceMembership[]; readonly observations: readonly MembershipNameObservation[] } {
  const map = new Map<string, { membership: SourceMembership; name: MembershipNameObservation | null }>();
  const explicit = new Map<string, MembershipNameObservation>();
  for (const observation of [...leftObservations, ...rightObservations]) {
    const key = canonicalJson([observation.target, observation.boardId]);
    const prior = explicit.get(key);
    if (!prior || observation.observedAt > prior.observedAt || observation.observedAt === prior.observedAt && utf8Compare(observation.boardName, prior.boardName) > 0) explicit.set(key, observation);
  }
  for (const raw of [...left, ...right]) {
    const value = normalizeMembership(raw);
    const key = membershipKey(value);
    const prior = map.get(key);
    const derived = value.target === "collected_album" && value.boardId !== null && value.boardName ? Object.freeze({ target: "collected_album" as const, boardId: value.boardId, boardName: value.boardName, observedAt: value.observedAt }) : null;
    const candidateName = explicit.get(key) ?? derived;
    let bestName = prior?.name ?? null;
    if (candidateName && (!bestName || candidateName.observedAt > bestName.observedAt || candidateName.observedAt === bestName.observedAt && utf8Compare(candidateName.boardName, bestName.boardName) > 0)) bestName = candidateName;
    const observedAt = prior && prior.membership.observedAt > value.observedAt ? prior.membership.observedAt : value.observedAt;
    map.set(key, { membership: Object.freeze({ ...value, boardName: bestName?.boardName ?? null, observedAt }), name: bestName });
  }
  const ordered = [...map.entries()].sort((a, b) => utf8Compare(a[0], b[0])).map(([, value]) => value);
  return Object.freeze({ memberships: Object.freeze(ordered.map((value) => value.membership)), observations: Object.freeze(ordered.flatMap((value) => value.name ? [value.name] : [])) });
}

export function deriveMembershipNameObservations(note: Note): readonly MembershipNameObservation[] { return mergeMemberships([], note.memberships).observations; }

function normalizeMedia(media: Media): Media {
  if (!Number.isSafeInteger(media.ordinal) || media.ordinal <= 0) throw new SafeError("INVALID_INPUT", "invalid media ordinal");
  if (media.status === "stored" && (media.object === null || media.extension === null)) throw new SafeError("INVALID_INPUT", "stored media needs object");
  if (media.object !== null) decodeSha256(media.object.sha256);
  return Object.freeze({ ...media, extension: media.extension?.normalize("NFC") ?? null });
}

function slotKey(value: MediaSlotState): string { return `${MEDIA_ORDER[value.slot.kind]}:${value.slot.ordinal.toString().padStart(12, "0")}`; }

export interface MergeCandidate {
  readonly note: Note;
  readonly sourceRank: ValidatedSourceRank;
  readonly mediaSlots: readonly MediaSlotState[];
  readonly mediaSetComplete: boolean;
}

function mergeMediaSlots(existing: readonly MediaSlotState[], candidate: readonly MediaSlotState[], candidateRank: ValidatedSourceRank, mediaSetComplete: boolean): readonly MediaSlotState[] {
  const result = new Map<string, MediaSlotState>();
  for (const old of existing) result.set(slotKey(old), old);
  const seen = new Set<string>();
  for (const raw of candidate) {
    if (raw.sourceRank.payloadSha256 !== candidateRank.payloadSha256 || raw.sourceRank.revisionAt !== candidateRank.revisionAt) throw new SafeError("INVALID_INPUT", "media rank differs from candidate rank");
    const item: MediaSlotState = Object.freeze({ ...raw, sourceRank: candidateRank, media: raw.media === null ? null : normalizeMedia(raw.media) });
    const key = slotKey(item);
    if (seen.has(key)) throw new SafeError("INVALID_INPUT", "duplicate media slot");
    seen.add(key);
    const old = result.get(key);
    if (old?.media?.status === "stored" && !item.tombstone && item.media?.status !== "stored") continue;
    if (!old || compareSourceRank(item.sourceRank, old.sourceRank) > 0) result.set(key, item);
    else if (compareSourceRank(item.sourceRank, old.sourceRank) === 0) {
      if (old.tombstone || item.tombstone) result.set(key, Object.freeze({ ...item, tombstone: true, media: null }));
      else if (old.media?.status === "stored" && item.media?.status !== "stored") result.set(key, old);
      else if (item.media?.status === "stored" && old.media?.status !== "stored") result.set(key, item);
    }
  }
  if (mediaSetComplete) {
    for (const [key, old] of result) {
      const comparison = compareSourceRank(candidateRank, old.sourceRank);
      if (!seen.has(key) && (comparison > 0 || comparison === 0 && candidateRank.payloadSha256 === old.sourceRank.payloadSha256)) {
        result.set(key, Object.freeze({ slot: old.slot, sourceRank: candidateRank, media: null, tombstone: true }));
      }
    }
  }
  return Object.freeze([...result.values()].sort((a, b) => slotKey(a).localeCompare(slotKey(b))));
}

export function publicNoteProjection(note: Note): Record<string, unknown> {
  return {
    schemaVersion: 1,
    hostId: note.hostId,
    accountId: note.accountId,
    noteId: note.noteId,
    publicUrl: note.publicUrl,
    title: note.title,
    body: note.body,
    noteType: note.noteType,
    author: note.author,
    publishedAt: note.publishedAt,
    updatedAt: note.updatedAt,
    tags: note.tags,
    metrics: note.metrics,
    memberships: note.memberships.map((m) => ({ target: m.target, boardId: m.boardId, boardName: m.boardName })),
    media: note.media.map((m) => ({ kind: m.kind, ordinal: m.ordinal, status: m.status, extension: m.extension, object: m.object })),
  };
}

export function computeContentHash(note: Note): Sha256 { return decodeSha256(sha256Canonical(publicNoteProjection(note))); }

function normalizeNote(note: Note): Note {
  const tags = [...new Set(note.tags.map(normalizedText).filter(Boolean))].sort(utf8Compare);
  for (const value of Object.values(note.metrics)) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new SafeError("INVALID_INPUT", "invalid metric");
  const normalized: Note = {
    ...note,
    title: normalizedNullable(note.title),
    body: normalizedText(note.body),
    author: { id: normalizedNullable(note.author.id), name: normalizedNullable(note.author.name), publicUrl: normalizedNullable(note.author.publicUrl) },
    tags: Object.freeze(tags),
    memberships: mergeMemberships([], note.memberships).memberships,
    media: Object.freeze(note.media.map(normalizeMedia).sort((a, b) => MEDIA_ORDER[a.kind] - MEDIA_ORDER[b.kind] || a.ordinal - b.ordinal)),
    contentHash: decodeSha256("0".repeat(64)),
  };
  return Object.freeze({ ...normalized, contentHash: computeContentHash(normalized) });
}

export function mergeCanonicalNote(existing: NoteManifest | null, candidate: MergeCandidate): { readonly note: Note; readonly sourceRank: SourceRank; readonly membershipNameObservations: readonly MembershipNameObservation[]; readonly mediaSlots: readonly MediaSlotState[] } {
  const incomingMemberships = mergeMemberships([], candidate.note.memberships);
  const incoming = normalizeNote({ ...candidate.note, memberships: incomingMemberships.memberships });
  assertValidatedRankForNote(candidate.sourceRank, incoming);
  if (existing && (existing.hostId !== incoming.hostId || existing.accountId !== incoming.accountId || existing.noteId !== incoming.noteId)) throw new SafeError("INVALID_INPUT", "note merge key mismatch");
  const oldRank = existing ? { ...existing.semanticSourceRank, observedAt: existing.semanticSourceRank.observedAt ?? existing.canonicalNote.capturedAt } : null;
  const oldSlots = existing?.mediaSlots.map((slot) => ({ ...slot, sourceRank: { ...slot.sourceRank, observedAt: slot.sourceRank.observedAt ?? existing.canonicalNote.capturedAt } })) ?? [];
  const mediaSlots = mergeMediaSlots(oldSlots, candidate.mediaSlots, candidate.sourceRank, candidate.mediaSetComplete);
  if (!existing) {
    const media = mediaSlots.filter((slot) => !slot.tombstone && slot.media !== null).map((slot) => slot.media!);
    const next = normalizeNote({ ...incoming, media });
    return Object.freeze({ note: next, sourceRank: candidate.sourceRank, membershipNameObservations: incomingMemberships.observations, mediaSlots });
  }
  const old = existing.canonicalNote;
  const candidateWins = compareSourceRank(candidate.sourceRank, oldRank!) > 0;
  const semantic = candidateWins ? incoming : old;
  const media = mediaSlots.filter((slot) => !slot.tombstone && slot.media !== null).map((slot) => slot.media!);
  const memberships = mergeMemberships(old.memberships, incoming.memberships, existing.membershipNameObservations, incomingMemberships.observations);
  const merged = normalizeNote({
    ...semantic,
    capturedAt: old.capturedAt > incoming.capturedAt ? old.capturedAt : incoming.capturedAt,
    memberships: memberships.memberships,
    media,
  });
  return Object.freeze({ note: merged, sourceRank: candidateWins ? candidate.sourceRank : oldRank!, membershipNameObservations: memberships.observations, mediaSlots });
}

export function mergeFailure(existing: FailureRecord | null, candidate: FailureRecord): FailureRecord {
  if (!existing) return Object.freeze(candidate);
  if (existing.failureId !== candidate.failureId || !sameScope(existing.scope, candidate.scope) || existing.noteId !== candidate.noteId || existing.stage !== candidate.stage || existing.category !== candidate.category) throw new SafeError("INVALID_INPUT", "failure key mismatch");
  let sourceRank: SourceRank | null = null;
  if (candidate.stage === "media") {
    if (!candidate.sourceRank || !existing.sourceRank) throw new SafeError("INVALID_INPUT", "media failure requires rank");
    sourceRank = maxSourceRank(existing.sourceRank, candidate.sourceRank);
  } else if (candidate.sourceRank !== null || existing.sourceRank !== null) throw new SafeError("INVALID_INPUT", "non-media failure forbids rank");
  return Object.freeze({ ...candidate, sourceRank, attemptCount: existing.attemptCount + 1, firstOccurredAt: existing.firstOccurredAt < candidate.firstOccurredAt ? existing.firstOccurredAt : candidate.firstOccurredAt, lastOccurredAt: existing.lastOccurredAt > candidate.lastOccurredAt ? existing.lastOccurredAt : candidate.lastOccurredAt });
}

export function computeFailureId(failure: Pick<FailureRecord, "scope" | "noteId" | "stage" | "mediaSlot" | "category">): string {
  return sha256Canonical([failure.scope, failure.noteId, failure.stage, failure.mediaSlot, failure.category]);
}

export function canResolveMediaFailure(failure: FailureRecord, acceptedRank: SourceRank, acceptedByCanonicalMerge: boolean): boolean {
  return failure.stage === "media" && failure.sourceRank !== null && acceptedByCanonicalMerge && compareSourceRank(acceptedRank, failure.sourceRank) >= 0;
}

export function reconcileTaskFailures(task: TaskRecord, unresolved: readonly FailureRecord[]): TaskRecord {
  const ids = unresolved.filter((failure) => sameScope(failure.scope, task.scope) && failure.noteId === task.noteId && failure.resolvedAt === null).map((failure) => failure.failureId).sort(utf8Compare);
  if (task.status === "skipped") return task;
  return Object.freeze({ ...task, failureIds: ids, status: ids.length === 0 ? "done" : "partial" });
}

// Kept as a v1 compatibility field; this is the same digest as contentHash.
export function indexEntryDigest(note: Note): Sha256 { return computeContentHash(note); }
export function csvRowDigest(row: string): Sha256 { return decodeSha256(sha256Bytes(Buffer.from(row, "utf8"))); }
function csvCell(value: unknown): string { const text = value === null || value === undefined ? "" : String(value); return `"${text.replaceAll('"', '""')}"`; }
export function renderIndexCsvRow(note: Note): string { return [note.hostId, note.accountId, note.noteId, note.title, note.publicUrl, note.contentHash].map(csvCell).join(","); }
export function noteCsvRowDigest(note: Note): Sha256 { return csvRowDigest(renderIndexCsvRow(note)); }
