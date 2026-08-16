import { canonicalJson, equalHexConstantTime, sha256Canonical, utf8Compare } from "./canonical.js";
import { SafeError, invalidInput } from "./errors.js";
import { decodeIsoDateTime, decodeSha256,                                                } from "./types.js";
                                       

const VALIDATED_SOURCE_RANK                = Symbol("validated-source-rank");
const validatedRanks = new WeakSet        ();
const noteBindings = new WeakMap                ();

                                                         
                                         
 

function build(revisionAt                    , payloadSha256        )                      {
  const rank = Object.create(null)                                                      ;
  Object.defineProperties(rank, {
    revisionAt: { value: revisionAt, enumerable: true, writable: false, configurable: false },
    payloadSha256: { value: payloadSha256, enumerable: true, writable: false, configurable: false },
    [VALIDATED_SOURCE_RANK]: { value: true, enumerable: false, writable: false, configurable: false },
  });
  validatedRanks.add(rank);
  return Object.freeze(rank);
}

export function createValidatedSourceRank(
  semanticPayload         ,
  revisionAtInput         ,
  claimedPayloadSha256          ,
)                      {
  const revisionAt = revisionAtInput === null ? null : decodeIsoDateTime(revisionAtInput);
  const computed = decodeSha256(sha256Canonical(semanticPayload));
  if (claimedPayloadSha256 !== undefined) {
    const claimed = decodeSha256(claimedPayloadSha256);
    if (!equalHexConstantTime(computed, claimed)) invalidInput("source rank payload digest mismatch");
  }
  return build(revisionAt, computed);
}

export function semanticNotePayload(note      )          {
  const normalized = (value               ) => value === null ? null : value.normalize("NFC").replace(/\r\n?/g, "\n");
  const memberships = note.memberships.map((membership) => ({ target: membership.target, boardId: membership.boardId, boardName: normalized(membership.boardName) })).sort((a, b) => utf8Compare(canonicalJson(a), canonicalJson(b)));
  const media = note.media.map((item) => ({ kind: item.kind, ordinal: item.ordinal, status: item.status, extension: item.extension, object: item.object })).sort((a, b) => utf8Compare(canonicalJson(a), canonicalJson(b)));
  return {
    schemaVersion: note.schemaVersion,
    hostId: note.hostId,
    accountId: note.accountId,
    noteId: note.noteId,
    publicUrl: note.publicUrl,
    title: normalized(note.title),
    body: normalized(note.body),
    noteType: note.noteType,
    author: { id: normalized(note.author.id), name: normalized(note.author.name), publicUrl: normalized(note.author.publicUrl) },
    publishedAt: note.publishedAt,
    updatedAt: note.updatedAt,
    tags: [...new Set(note.tags.map((tag) => normalized(tag) ).filter(Boolean))].sort(utf8Compare),
    metrics: note.metrics,
    memberships,
    media,
  };
}

export function createValidatedNoteRank(note      , revisionAtInput         , claimedPayloadSha256          )                      {
  const rank = createValidatedSourceRank(semanticNotePayload(note), revisionAtInput, claimedPayloadSha256);
  noteBindings.set(rank, rank.payloadSha256);
  return rank;
}

export function assertValidatedRankForNote(value         , note      )                                       {
  assertValidatedSourceRank(value);
  const binding = noteBindings.get(value);
  const computed = decodeSha256(sha256Canonical(semanticNotePayload(note)));
  if (!binding || !equalHexConstantTime(binding, computed) || !equalHexConstantTime(value.payloadSha256, computed)) throw new SafeError("INVALID_INPUT", "source rank is not bound to semantic note payload");
}

export function isValidatedSourceRank(value         )                               {
  return value !== null && typeof value === "object" && validatedRanks.has(value);
}

export function assertValidatedSourceRank(value         )                                       {
  if (!isValidatedSourceRank(value)) throw new SafeError("INVALID_INPUT", "unvalidated source rank");
  decodeSha256(value.payloadSha256);
  if (value.revisionAt !== null) decodeIsoDateTime(value.revisionAt);
}

export function hydrateStoredSourceRank(value            )             {
  return Object.freeze({
    revisionAt: value.revisionAt === null ? null : decodeIsoDateTime(value.revisionAt),
    payloadSha256: decodeSha256(value.payloadSha256),
  });
}

export function compareSourceRank(left            , right            )         {
  if (left.revisionAt !== right.revisionAt) {
    if (left.revisionAt === null) return -1;
    if (right.revisionAt === null) return 1;
    const time = left.revisionAt.localeCompare(right.revisionAt);
    if (time !== 0) return time;
  }
  return left.payloadSha256.localeCompare(right.payloadSha256);
}

export function maxSourceRank(left            , right            )             {
  return compareSourceRank(left, right) >= 0 ? left : right;
}
