import { SafeError } from "./errors.js";
import { decodeServerCursor } from "./types.js";
function frozenIds(values) { return Object.freeze([...values]); }
function head(frontier) {
    return Object.freeze({ phase: "head", cursor: null, cursorSource: null, reachedEnd: true, headFrontier: frozenIds(frontier), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
}
export function assertPageCursorProtocol(input) {
    if (!input.hasMore)
        return;
    if (input.nextCursor === null)
        throw new SafeError("INVALID_INPUT", "continued page requires response cursor");
    decodeServerCursor(input.nextCursor);
    if (input.nextCursor === input.requestCursor)
        throw new SafeError("INVALID_INPUT", "response cursor did not advance");
}
export function transitionSyncProgress(before, input) {
    assertPageCursorProtocol(input);
    const nextCursor = input.nextCursor;
    const noteIds = frozenIds(input.noteIds);
    if (before.phase === "backfill") {
        const frontier = before.cursor === null ? noteIds : before.headFrontier;
        if (!input.hasMore)
            return head(frontier);
        return Object.freeze({ phase: "backfill", cursor: nextCursor, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: frozenIds(frontier), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
    }
    if (before.phase === "head") {
        if (!input.hasMore)
            return head(noteIds);
        const oldFrontier = new Set(before.headFrontier);
        const hitFrontier = input.noteIds.some((id) => oldFrontier.has(id));
        const hasNew = input.newNoteIds.length > 0;
        if (!hasNew && hitFrontier)
            return head(noteIds);
        const stop = hasNew && before.headFrontier.length > 0 && !hitFrontier
            ? Object.freeze({ kind: "frontier", noteIds: Object.freeze([before.headFrontier[0], ...before.headFrontier.slice(1)]) })
            : Object.freeze({ kind: "service_end" });
        return Object.freeze({ phase: "catchup", cursor: nextCursor, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: before.headFrontier, catchupStop: stop, pendingHeadFrontier: noteIds });
    }
    const stop = before.catchupStop;
    const hitFrontier = stop.kind === "frontier" && input.noteIds.some((id) => stop.noteIds.includes(id));
    if (!input.hasMore || hitFrontier)
        return head(before.pendingHeadFrontier);
    return Object.freeze({ phase: "catchup", cursor: nextCursor, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: before.headFrontier, catchupStop: stop, pendingHeadFrontier: before.pendingHeadFrontier });
}
