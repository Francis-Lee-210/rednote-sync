import { canonicalJson, equalHexConstantTime, sha256Canonical, utf8Compare } from "./canonical.js";
import { SafeError, invalidInput } from "./errors.js";
import { decodeIsoDateTime, decodeSha256 } from "./types.js";
export function createValidatedSourceRank(semanticPayload, revisionAtInput, claimedPayloadSha256, observedAtInput) {
    const revisionAt = revisionAtInput === null ? null : decodeIsoDateTime(revisionAtInput);
    const computed = decodeSha256(sha256Canonical(semanticPayload));
    if (claimedPayloadSha256 !== undefined) {
        const claimed = decodeSha256(claimedPayloadSha256);
        if (!equalHexConstantTime(computed, claimed))
            invalidInput("source rank payload digest mismatch");
    }
    return Object.freeze({ revisionAt, payloadSha256: computed, ...(observedAtInput === undefined ? {} : { observedAt: decodeIsoDateTime(observedAtInput) }) });
}
export function semanticNotePayload(note) {
    const normalized = (value) => value === null ? null : value.normalize("NFC").replace(/\r\n?/g, "\n");
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
        tags: [...new Set(note.tags.map((tag) => normalized(tag)).filter(Boolean))].sort(utf8Compare),
        metrics: note.metrics,
        memberships,
        media,
    };
}
export function createValidatedNoteRank(note, revisionAtInput, claimedPayloadSha256) {
    return createValidatedSourceRank(semanticNotePayload(note), revisionAtInput, claimedPayloadSha256, note.capturedAt);
}
export function assertValidatedRankForNote(value, note) {
    assertValidatedSourceRank(value);
    const computed = decodeSha256(sha256Canonical(semanticNotePayload(note)));
    if (!equalHexConstantTime(value.payloadSha256, computed))
        throw new SafeError("INVALID_INPUT", "source rank payload digest mismatch");
    if (value.observedAt !== undefined && value.observedAt !== note.capturedAt)
        throw new SafeError("INVALID_INPUT", "source observation time mismatch");
}
export function isValidatedSourceRank(value) {
    try {
        assertValidatedSourceRank(value);
        return true;
    }
    catch {
        return false;
    }
}
export function assertValidatedSourceRank(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new SafeError("INVALID_INPUT", "invalid source rank");
    const rank = value;
    decodeSha256(rank.payloadSha256);
    if (rank.revisionAt !== null)
        decodeIsoDateTime(rank.revisionAt);
    if (rank.observedAt !== undefined)
        decodeIsoDateTime(rank.observedAt);
}
export function hydrateStoredSourceRank(value) {
    return Object.freeze({
        revisionAt: value.revisionAt === null ? null : decodeIsoDateTime(value.revisionAt),
        payloadSha256: decodeSha256(value.payloadSha256),
        ...(value.observedAt === undefined ? {} : { observedAt: decodeIsoDateTime(value.observedAt) }),
    });
}
export function compareSourceRank(left, right) {
    // One ordering key keeps mixed known/unknown source revisions transitive.
    // capturedAt is the observation time, never the time an old file is imported.
    const leftAt = left.observedAt ?? left.revisionAt;
    const rightAt = right.observedAt ?? right.revisionAt;
    return leftAt !== null && rightAt !== null ? leftAt.localeCompare(rightAt) : 0;
}
export function maxSourceRank(left, right) {
    return compareSourceRank(left, right) >= 0 ? left : right;
}
