import { SafeError } from "./errors.ts";
import { decodeServerCursor, type NoteId, type ServerCursor, type SyncProgress } from "./types.ts";

export interface PageTransitionInput {
  readonly requestCursor: ServerCursor | null;
  readonly nextCursor: ServerCursor | null;
  readonly hasMore: boolean;
  readonly noteIds: readonly NoteId[];
  readonly newNoteIds: readonly NoteId[];
}

function frozenIds(values: readonly NoteId[]): readonly NoteId[] { return Object.freeze([...values]); }

function head(frontier: readonly NoteId[]): SyncProgress {
  return Object.freeze({ phase: "head", cursor: null, cursorSource: null, reachedEnd: true, headFrontier: frozenIds(frontier), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
}

export function assertPageCursorProtocol(input: Pick<PageTransitionInput, "requestCursor" | "nextCursor" | "hasMore">): void {
  if (!input.hasMore) return;
  if (input.nextCursor === null) throw new SafeError("INVALID_INPUT", "continued page requires response cursor");
  decodeServerCursor(input.nextCursor);
  if (input.nextCursor === input.requestCursor) throw new SafeError("INVALID_INPUT", "response cursor did not advance");
}

export function transitionSyncProgress(before: SyncProgress, input: PageTransitionInput): SyncProgress {
  assertPageCursorProtocol(input);
  const nextCursor = input.nextCursor;
  const noteIds = frozenIds(input.noteIds);
  if (before.phase === "backfill") {
    const frontier = before.cursor === null ? noteIds : before.headFrontier;
    if (!input.hasMore) return head(frontier);
    return Object.freeze({ phase: "backfill", cursor: nextCursor!, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: frozenIds(frontier), catchupStop: null, pendingHeadFrontier: Object.freeze([]) });
  }
  if (before.phase === "head") {
    if (!input.hasMore) return head(noteIds);
    const oldFrontier = new Set(before.headFrontier);
    const hitFrontier = input.noteIds.some((id) => oldFrontier.has(id));
    const hasNew = input.newNoteIds.length > 0;
    if (!hasNew && hitFrontier) return head(noteIds);
    const stop = hasNew && before.headFrontier.length > 0 && !hitFrontier
      ? Object.freeze({ kind: "frontier" as const, noteIds: Object.freeze([before.headFrontier[0]!, ...before.headFrontier.slice(1)]) as readonly [NoteId, ...NoteId[]] })
      : Object.freeze({ kind: "service_end" as const });
    return Object.freeze({ phase: "catchup", cursor: nextCursor!, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: before.headFrontier, catchupStop: stop, pendingHeadFrontier: noteIds });
  }
  const stop = before.catchupStop!;
  const hitFrontier = stop.kind === "frontier" && input.noteIds.some((id) => stop.noteIds.includes(id));
  if (!input.hasMore || hitFrontier) return head(before.pendingHeadFrontier);
  return Object.freeze({ phase: "catchup", cursor: nextCursor!, cursorSource: "response.nextCursor", reachedEnd: false, headFrontier: before.headFrontier, catchupStop: stop, pendingHeadFrontier: before.pendingHeadFrontier });
}
