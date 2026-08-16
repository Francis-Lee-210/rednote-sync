import { sha256Canonical, utf8Compare } from "./canonical.js";
import { invalidInput } from "./errors.js";
import { getHostAdapter } from "./host-adapter.js";

                                                                           
                                       
                                                   
                                                     
                                             
                                               
                                                         
                                                       
                                             
                                                         
                                                                              
                                                                        

                                
                                
                          
                                      
                         
 
                             
                                
                          
                                     
                            
 
                                                        
                                                                                            

                          
                            
                                
                          
                                      
                                    
                                   
 
                                                                                                                       
                                                                                                                                                                
                                                    
                                                          
                                                                                 
                                                                                                              
                                                                                                                                                                                                           
                                                                                                       
                                                                                                                                                                        
                       
                            
                                
                          
                          
                             
                                
                        
                                                                      
                          
                                           
                                         
                                   
                                   
                            
                                                    
                                   
                               
 
                                                                                                                                                        
                                                                                                                                             
                                                                                                                                                                                                                                                                                                                                               
                                                                                                                                                                                                                                                                                                                                          
                                                      
                                                                                            
                                                                                                                                                                                                    
                                                                                          
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                                                                                                      
                                                                                         
                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                               
                                                                                                                                                                                                                                                                                                                                         
                                                                                                                                                                                                                                                                                         

function exactRecord(value         , allowed                   )                          {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidInput();
  const record = value                           ;
  const actual = Object.keys(record).sort(utf8Compare);
  const expected = [...allowed].sort(utf8Compare);
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) invalidInput("unexpected object fields");
  return record;
}

function safeId(value         , label        )         {
  if (typeof value !== "string") invalidInput(`${label} must be a string`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(normalized) || normalized === "." || normalized === "..") invalidInput(`invalid ${label}`);
  return normalized;
}

export function decodeHostId(value         )         { if (value !== "xhs" && value !== "rednote") invalidInput("invalid host"); return value; }
export function decodeAccountId(value         )            { return safeId(value, "account id")             ; }
export function decodeNoteId(value         )         { return safeId(value, "note id")          ; }
export function decodeBoardId(value         )          { return safeId(value, "board id")           ; }
export function decodeServerCursor(value         )               { return safeId(value, "server cursor")                ; }
export function decodeSha256(value         )         { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalidInput("invalid sha256"); return value          ; }
export function decodeIsoDateTime(value         )              {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalidInput("invalid UTC time");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalidInput("invalid UTC time");
  return value               ;
}
export function decodePartitionScope(value         )                 {
  const r = exactRecord(value, ["accountId", "hostId", "target", "boardId"]);
  const hostId = decodeHostId(r.hostId);
  const accountId = decodeAccountId(r.accountId);
  if (r.target === "collected_album") {
    return Object.freeze({ hostId, accountId, target: "collected_album", boardId: decodeBoardId(r.boardId) });
  }
  if (r.target !== "posted" && r.target !== "collected" && r.target !== "liked") invalidInput("invalid target");
  if (r.boardId !== null) invalidInput("ordinary scope forbids board");
  return Object.freeze({ hostId, accountId, target: r.target, boardId: null });
}
export function decodeAccountPartition(value         )                   {
  const r = exactRecord(value, ["accountId", "hostId"]);
  return Object.freeze({ accountId: decodeAccountId(r.accountId), hostId: decodeHostId(r.hostId) });
}
export function accountPartition(scope                )                   { return { accountId: scope.accountId, hostId: scope.hostId }; }
export function accountKey(account                  )             { return sha256Canonical([account.hostId, account.accountId])              ; }
export function noteKey(account                  , noteId        )         { return sha256Canonical([account.hostId, account.accountId, noteId]); }
export function scopeKey(scope                )         { return sha256Canonical([scope.hostId, scope.accountId, scope.target, scope.boardId]); }
export function sameAccount(a                  , b                  )          { return a.hostId === b.hostId && a.accountId === b.accountId; }
export function sameScope(a                , b                )          { return sameAccount(a, b) && a.target === b.target && a.boardId === b.boardId; }
export function initialProgress()               { return Object.freeze({ phase: "backfill", cursor: null, cursorSource: null, reachedEnd: false, headFrontier: Object.freeze([]), catchupStop: null, pendingHeadFrontier: Object.freeze([]) }); }

export function assertTaskInvariant(task            )       {
  decodePartitionScope(task.scope);
  decodeNoteId(task.noteId);
  if (!Number.isSafeInteger(task.attemptCount) || task.attemptCount < 0) invalidInput("invalid task attempt count");
  if (task.status === "partial" && task.failureIds.length === 0) invalidInput("partial task requires failure");
  if (task.status === "failed" && task.failureIds.length === 0) invalidInput("failed task requires failure");
  if (task.status === "done" && task.failureIds.length !== 0) invalidInput("done task cannot have failure");
  if ((task.status === "pending" || task.status === "paused") && task.failureIds.length !== 0) invalidInput("inactive task cannot retain failure");
  if (task.status === "skipped" && (!task.skipReason || !task.skippedAt)) invalidInput("skipped task requires reason and time");
  if (task.status === "skipped" && task.failureIds.length !== 0) invalidInput("skipped task cannot retain failure");
  if (task.status !== "skipped" && (task.skipReason !== null || task.skippedAt !== null)) invalidInput("non-skipped task forbids skip fields");
}

export function assertProgressInvariant(progress              )       {
  if (progress.phase === "head") {
    if (progress.cursor !== null || progress.cursorSource !== null || !progress.reachedEnd || progress.catchupStop !== null || progress.pendingHeadFrontier.length !== 0) invalidInput("invalid head progress");
  } else if (progress.reachedEnd) invalidInput("non-head progress cannot reach end");
  if (progress.phase === "backfill") {
    if (progress.catchupStop !== null || progress.pendingHeadFrontier.length !== 0 || (progress.cursor === null) !== (progress.cursorSource === null)) invalidInput("invalid backfill progress");
    if (progress.cursorSource !== null && progress.cursorSource !== "response.nextCursor") invalidInput("invalid backfill cursor provenance");
  }
  if (progress.phase === "catchup") {
    if (progress.cursor === null || progress.cursorSource !== "response.nextCursor" || progress.catchupStop === null) invalidInput("invalid catchup progress");
    if (progress.catchupStop.kind === "frontier" && progress.catchupStop.noteIds.length === 0) invalidInput("empty frontier forbidden");
  }
}

function integer(value         , label        , minimum = 0)         {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalidInput(`invalid ${label}`);
  return value;
}
function nullableText(value         , label        )                {
  if (value === null) return null;
  if (typeof value !== "string") invalidInput(`invalid ${label}`);
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}
function nullableIso(value         )                     { return value === null ? null : decodeIsoDateTime(value); }

export function decodeAccount(value         )          {
  const r = exactRecord(value, ["schemaVersion", "accountId", "hostId", "displayName", "firstSeenAt", "lastSeenAt"]);
  if (r.schemaVersion !== 1) invalidInput("invalid account schema");
  const account = { schemaVersion: 1         , accountId: decodeAccountId(r.accountId), hostId: decodeHostId(r.hostId), displayName: nullableText(r.displayName, "display name"), firstSeenAt: decodeIsoDateTime(r.firstSeenAt), lastSeenAt: decodeIsoDateTime(r.lastSeenAt) };
  if (account.firstSeenAt > account.lastSeenAt) invalidInput("invalid account time range");
  return Object.freeze(account);
}

export function decodeObjectRef(value         )            {
  const r = exactRecord(value, ["sha256", "byteLength", "mimeType"]);
  if (typeof r.mimeType !== "string" || r.mimeType.length < 1 || r.mimeType.length > 200) invalidInput("invalid MIME type");
  return Object.freeze({ sha256: decodeSha256(r.sha256), byteLength: integer(r.byteLength, "byte length"), mimeType: r.mimeType });
}

export function decodeSourceRank(value         )             {
  const r = exactRecord(value, ["revisionAt", "payloadSha256"]);
  return Object.freeze({ revisionAt: nullableIso(r.revisionAt), payloadSha256: decodeSha256(r.payloadSha256) });
}

export function decodeMediaSlot(value         )            {
  const r = exactRecord(value, ["kind", "ordinal"]);
  if (r.kind !== "cover" && r.kind !== "image" && r.kind !== "video") invalidInput("invalid media kind");
  return Object.freeze({ kind: r.kind, ordinal: integer(r.ordinal, "media ordinal", 1) });
}

export function decodeMedia(value         )        {
  const r = exactRecord(value, ["mediaId", "kind", "ordinal", "status", "extension", "object"]);
  const slot = decodeMediaSlot({ kind: r.kind, ordinal: r.ordinal });
  if (r.status !== "stored" && r.status !== "failed" && r.status !== "skipped") invalidInput("invalid media status");
  const mediaId = safeId(r.mediaId, "media id");
  const extension = nullableText(r.extension, "media extension");
  if (extension !== null && !/^[a-z0-9]{1,8}$/.test(extension)) invalidInput("invalid media extension");
  const object = r.object === null ? null : decodeObjectRef(r.object);
  if (r.status === "stored" ? object === null || extension === null : object !== null) invalidInput("invalid media object status");
  return Object.freeze({ mediaId, ...slot, status: r.status, extension, object });
}

export function decodeSourceMembership(value         )                   {
  const r = exactRecord(value, ["target", "boardId", "boardName", "observedAt"]);
  if (r.target !== "posted" && r.target !== "collected" && r.target !== "liked" && r.target !== "collected_album") invalidInput("invalid membership target");
  if (r.target === "collected_album") {
    return Object.freeze({ target: r.target, boardId: decodeBoardId(r.boardId), boardName: nullableText(r.boardName, "board name"), observedAt: decodeIsoDateTime(r.observedAt) });
  }
  if (r.boardId !== null || r.boardName !== null) invalidInput("ordinary membership forbids board fields");
  return Object.freeze({ target: r.target, boardId: null, boardName: null, observedAt: decodeIsoDateTime(r.observedAt) });
}

export function decodeNote(value         )       {
  const r = exactRecord(value, ["schemaVersion", "accountId", "hostId", "noteId", "publicUrl", "title", "body", "noteType", "author", "publishedAt", "updatedAt", "capturedAt", "tags", "metrics", "memberships", "media", "contentHash"]);
  if (r.schemaVersion !== 1) invalidInput("invalid note schema");
  const hostId = decodeHostId(r.hostId);
  const noteId = decodeNoteId(r.noteId);
  const adapter = getHostAdapter(hostId);
  if (typeof r.publicUrl !== "string" || r.publicUrl !== adapter.publicNoteUrl(noteId)) invalidInput("invalid canonical public URL");
  if (typeof r.body !== "string") invalidInput("invalid note body");
  if (r.noteType !== "text" && r.noteType !== "image" && r.noteType !== "video" && r.noteType !== "mixed" && r.noteType !== "unknown") invalidInput("invalid note type");
  const authorRaw = exactRecord(r.author, ["id", "name", "publicUrl"]);
  const authorPublicUrl = nullableText(authorRaw.publicUrl, "author URL");
  if (authorPublicUrl !== null) {
    let canonicalAuthor               ;
    try { canonicalAuthor = adapter.normalizeAuthorPublicUrl(authorPublicUrl); } catch { invalidInput("invalid canonical author URL"); }
    if (canonicalAuthor !== authorPublicUrl) invalidInput("invalid canonical author URL");
  }
  const metricsRaw = exactRecord(r.metrics, ["liked", "collected", "commented", "shared"]);
  const metric = (item         ) => item === null ? null : integer(item, "metric");
  if (!Array.isArray(r.tags) || r.tags.some((tag) => typeof tag !== "string")) invalidInput("invalid tags");
  if (!Array.isArray(r.memberships) || !Array.isArray(r.media)) invalidInput("invalid note collections");
  return Object.freeze({
    schemaVersion: 1,
    accountId: decodeAccountId(r.accountId), hostId, noteId, publicUrl: r.publicUrl,
    title: nullableText(r.title, "title"), body: r.body.normalize("NFC").replace(/\r\n?/g, "\n"), noteType: r.noteType,
    author: Object.freeze({ id: nullableText(authorRaw.id, "author id"), name: nullableText(authorRaw.name, "author name"), publicUrl: authorPublicUrl }),
    publishedAt: nullableIso(r.publishedAt), updatedAt: nullableIso(r.updatedAt), capturedAt: decodeIsoDateTime(r.capturedAt),
    tags: Object.freeze(r.tags.map((tag) => tag.normalize("NFC"))), metrics: Object.freeze({ liked: metric(metricsRaw.liked), collected: metric(metricsRaw.collected), commented: metric(metricsRaw.commented), shared: metric(metricsRaw.shared) }),
    memberships: Object.freeze(r.memberships.map(decodeSourceMembership)), media: Object.freeze(r.media.map(decodeMedia)), contentHash: decodeSha256(r.contentHash),
  });
}

export function decodeMediaSlotState(value         )                 {
  const r = exactRecord(value, ["slot", "sourceRank", "media", "tombstone"]);
  if (typeof r.tombstone !== "boolean") invalidInput("invalid tombstone");
  const slot = decodeMediaSlot(r.slot);
  const media = r.media === null ? null : decodeMedia(r.media);
  if (media && (media.kind !== slot.kind || media.ordinal !== slot.ordinal)) invalidInput("media slot mismatch");
  if (r.tombstone && media !== null) invalidInput("tombstone forbids media");
  return Object.freeze({ slot, sourceRank: decodeSourceRank(r.sourceRank), media, tombstone: r.tombstone });
}

export function decodeNoteManifest(value         )               {
  const r = exactRecord(value, ["schemaVersion", "revision", "accountId", "hostId", "noteId", "canonicalNote", "semanticSourceRank", "membershipNameObservations", "mediaSlots", "artifacts", "indexEntrySha256", "csvRowSha256"]);
  if (r.schemaVersion !== 1 || !Array.isArray(r.mediaSlots) || !Array.isArray(r.membershipNameObservations)) invalidInput("invalid manifest schema");
  const artifacts = exactRecord(r.artifacts, ["json", "markdown"]);
  const canonicalNote = decodeNote(r.canonicalNote);
  const membershipNameObservations = r.membershipNameObservations.map((item) => {
    const observation = exactRecord(item, ["target", "boardId", "boardName", "observedAt"]);
    if (observation.target !== "collected_album" || typeof observation.boardName !== "string" || observation.boardName.length === 0) invalidInput("invalid membership name observation");
    return Object.freeze({ target: "collected_album"         , boardId: decodeBoardId(observation.boardId), boardName: observation.boardName.normalize("NFC").trim(), observedAt: decodeIsoDateTime(observation.observedAt) });
  });
  const result               = { schemaVersion: 1, revision: integer(r.revision, "manifest revision", 1), accountId: decodeAccountId(r.accountId), hostId: decodeHostId(r.hostId), noteId: decodeNoteId(r.noteId), canonicalNote, semanticSourceRank: decodeSourceRank(r.semanticSourceRank), membershipNameObservations: Object.freeze(membershipNameObservations), mediaSlots: Object.freeze(r.mediaSlots.map(decodeMediaSlotState)), artifacts: Object.freeze({ json: decodeObjectRef(artifacts.json), markdown: decodeObjectRef(artifacts.markdown) }), indexEntrySha256: decodeSha256(r.indexEntrySha256), csvRowSha256: decodeSha256(r.csvRowSha256) };
  if (!sameAccount(result, canonicalNote) || result.noteId !== canonicalNote.noteId) invalidInput("manifest note key mismatch");
  const observationKeys = new Set        ();
  for (const observation of membershipNameObservations) {
    const key = `${observation.target}\u0000${observation.boardId}`;
    if (observationKeys.has(key)) invalidInput("duplicate membership name observation");
    observationKeys.add(key);
    const membership = canonicalNote.memberships.find((item) => item.target === observation.target && item.boardId === observation.boardId);
    if (!membership || membership.boardName !== observation.boardName || membership.observedAt < observation.observedAt) invalidInput("membership name observation mismatch");
  }
  for (const membership of canonicalNote.memberships) {
    if (membership.target === "collected_album" && membership.boardName !== null && !membershipNameObservations.some((item) => item.boardId === membership.boardId && item.boardName === membership.boardName)) invalidInput("membership name observation missing");
  }
  const slotKeys = new Set        ();
  for (const slot of result.mediaSlots) {
    const key = `${slot.slot.kind}\u0000${slot.slot.ordinal}`;
    if (slotKeys.has(key)) invalidInput("duplicate media slot");
    slotKeys.add(key);
  }
  return Object.freeze(result);
}

export function decodeSyncProgress(value         )               {
  const r = exactRecord(value, ["phase", "cursor", "cursorSource", "reachedEnd", "headFrontier", "catchupStop", "pendingHeadFrontier"]);
  if (r.phase !== "backfill" && r.phase !== "head" && r.phase !== "catchup" || typeof r.reachedEnd !== "boolean" || !Array.isArray(r.headFrontier) || !Array.isArray(r.pendingHeadFrontier)) invalidInput("invalid progress");
  let stop                     = null;
  if (r.catchupStop !== null) {
    const raw = r.catchupStop                           ;
    if (raw.kind === "service_end") { exactRecord(raw, ["kind"]); stop = { kind: "service_end" }; }
    else { const f = exactRecord(raw, ["kind", "noteIds"]); if (f.kind !== "frontier" || !Array.isArray(f.noteIds) || f.noteIds.length === 0) invalidInput("invalid frontier"); stop = { kind: "frontier", noteIds: f.noteIds.map(decodeNoteId)                          }; }
  }
  const progress               = { phase: r.phase, cursor: r.cursor === null ? null : decodeServerCursor(r.cursor), cursorSource: r.cursorSource === null ? null : r.cursorSource                         , reachedEnd: r.reachedEnd, headFrontier: Object.freeze(r.headFrontier.map(decodeNoteId)), catchupStop: stop, pendingHeadFrontier: Object.freeze(r.pendingHeadFrontier.map(decodeNoteId)) };
  if (progress.cursorSource !== null && progress.cursorSource !== "response.nextCursor") invalidInput("invalid cursor source");
  assertProgressInvariant(progress);
  return Object.freeze(progress);
}

export function decodeState(value         )                         {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidInput("invalid state");
  const input = value                           ;
  const album = input.target === "collected_album";
  const fields = ["schemaVersion", "revision", "accountId", "hostId", "target", "boardId", ...(album ? ["boardName"] : []), "progress", "stopReason", "lastAttemptAt", "lastSuccessfulAt", "nextAllowedAt"];
  const r = exactRecord(value, fields);
  if (r.schemaVersion !== 1 || (r.stopReason !== null && r.stopReason !== "AUTH_REQUIRED" && r.stopReason !== "RATE_LIMITED" && r.stopReason !== "PROTOCOL")) invalidInput("invalid state fields");
  const scope = decodePartitionScope({ accountId: r.accountId, hostId: r.hostId, target: r.target, boardId: r.boardId });
  const common = { ...scope, schemaVersion: 1         , revision: integer(r.revision, "state revision"), progress: decodeSyncProgress(r.progress), stopReason: r.stopReason                           , lastAttemptAt: nullableIso(r.lastAttemptAt), lastSuccessfulAt: nullableIso(r.lastSuccessfulAt), nextAllowedAt: nullableIso(r.nextAllowedAt) };
  return Object.freeze(album ? { ...common, boardName: nullableText(r.boardName, "board name") }               : common             );
}

export function decodeTaskRecord(value         )             {
  const r = exactRecord(value, ["schemaVersion", "scope", "noteId", "status", "attemptCount", "failureIds", "skipReason", "skippedAt", "firstSeenAt", "updatedAt"]);
  if (r.schemaVersion !== 1 || !["pending", "paused", "done", "partial", "failed", "skipped"].includes(String(r.status)) || !Array.isArray(r.failureIds) || r.failureIds.some((id) => typeof id !== "string")) invalidInput("invalid task");
  const task             = { schemaVersion: 1, scope: decodePartitionScope(r.scope), noteId: decodeNoteId(r.noteId), status: r.status              , attemptCount: integer(r.attemptCount, "task attempts"), failureIds: Object.freeze(r.failureIds.map(String)), skipReason: nullableText(r.skipReason, "skip reason"), skippedAt: nullableIso(r.skippedAt), firstSeenAt: decodeIsoDateTime(r.firstSeenAt), updatedAt: decodeIsoDateTime(r.updatedAt) };
  if (task.firstSeenAt > task.updatedAt || new Set(task.failureIds).size !== task.failureIds.length) invalidInput("invalid task ordering");
  assertTaskInvariant(task); return Object.freeze(task);
}

export function decodeFailureRecord(value         )                {
  const r = exactRecord(value, ["schemaVersion", "failureId", "scope", "noteId", "mediaSlot", "sourceRank", "category", "stage", "safeMessage", "retryable", "attemptCount", "firstOccurredAt", "lastOccurredAt", "retryAt", "resolvedAt", "resolvedReason"]);
  const categories = ["INVALID_INPUT", "AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "MEDIA", "EXPORT", "STATE", "DERIVED_VIEW", "PAUSED", "BUSY", "INTERNAL"];
  if (r.schemaVersion !== 1 || typeof r.failureId !== "string" || !categories.includes(String(r.category)) || (r.stage !== "detail" && r.stage !== "media" && r.stage !== "export") || typeof r.safeMessage !== "string" || typeof r.retryable !== "boolean") invalidInput("invalid failure");
  const failure                = { schemaVersion: 1, failureId: r.failureId, scope: decodePartitionScope(r.scope), noteId: decodeNoteId(r.noteId), mediaSlot: r.mediaSlot === null ? null : decodeMediaSlot(r.mediaSlot), sourceRank: r.sourceRank === null ? null : decodeSourceRank(r.sourceRank), category: r.category                 , stage: r.stage, safeMessage: r.safeMessage, retryable: r.retryable, attemptCount: integer(r.attemptCount, "failure attempts", 1), firstOccurredAt: decodeIsoDateTime(r.firstOccurredAt), lastOccurredAt: decodeIsoDateTime(r.lastOccurredAt), retryAt: nullableIso(r.retryAt), resolvedAt: nullableIso(r.resolvedAt), resolvedReason: r.resolvedReason                                    };
  if (failure.stage === "media" ? failure.mediaSlot === null || failure.sourceRank === null : failure.mediaSlot !== null || failure.sourceRank !== null) invalidInput("invalid failure rank/slot");
  if ((failure.resolvedAt === null) !== (failure.resolvedReason === null) || (failure.resolvedReason !== null && failure.resolvedReason !== "repaired" && failure.resolvedReason !== "skipped")) invalidInput("invalid failure resolution");
  if (failure.firstOccurredAt > failure.lastOccurredAt || failure.resolvedAt !== null && failure.resolvedAt < failure.lastOccurredAt) invalidInput("invalid failure time range");
  return Object.freeze(failure);
}

export function decodeRunRecord(value         )            {
  const r = exactRecord(value, ["runId", "command", "account", "scope", "outcome", "startedAt", "finishedAt", "safeErrorCategory", "listed", "done", "partial", "failed", "skipped"]);
  if (typeof r.runId !== "string" || !["committed", "committed_with_warnings", "not_due", "paused", "blocked", "failed"].includes(String(r.outcome))) invalidInput("invalid run");
  const account = decodeAccountPartition(r.account);
  const categories = ["INVALID_INPUT", "AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "MEDIA", "EXPORT", "STATE", "DERIVED_VIEW", "PAUSED", "BUSY", "INTERNAL"];
  if (r.safeErrorCategory !== null && !categories.includes(String(r.safeErrorCategory))) invalidInput("invalid run error category");
  const base = { runId: r.runId, outcome: r.outcome              , startedAt: decodeIsoDateTime(r.startedAt), finishedAt: decodeIsoDateTime(r.finishedAt), safeErrorCategory: r.safeErrorCategory === null ? null : String(r.safeErrorCategory)                 , listed: integer(r.listed, "listed"), done: integer(r.done, "done"), partial: integer(r.partial, "partial"), failed: integer(r.failed, "failed"), skipped: integer(r.skipped, "skipped") };
  if (base.startedAt > base.finishedAt || base.done + base.partial + base.failed + base.skipped > base.listed) invalidInput("invalid run counts or time range");
  if (r.command === "repair_views") { if (r.scope !== null) invalidInput("repair run forbids scope"); return Object.freeze({ ...base, command: r.command, account, scope: null }); }
  if (r.command !== "sync" && r.command !== "retry" && r.command !== "skip" && r.command !== "ack") invalidInput("invalid run command");
  const scope = decodePartitionScope(r.scope);
  if (!sameAccount(scope, account)) invalidInput("run account mismatch");
  return Object.freeze({ ...base, command: r.command, account, scope });
}
