import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { SafeError, invalidInput } from "./errors.js";
import { getHostAdapter } from "./host-adapter.js";
import { computeContentHash } from "./merge.js";
import {} from "./object-store.js";
import { decodeRelativePath } from "./paths.js";
import { createValidatedNoteRank } from "./rank.js";
import { decodeAccount, decodeAccountPartition, decodeHostId, decodeIsoDateTime, decodeMedia, decodeNote, decodeNoteId, decodePartitionScope, decodeServerCursor, sameAccount, sameScope, } from "./types.js";
/** A payload-free source failure. Raw service messages never cross this boundary. */
export class OfflineAdapterError extends Error {
    category;
    retryAt;
    collector;
    constructor(category, retryAt, collector) {
        super("offline adapter operation failed");
        this.name = "OfflineAdapterError";
        this.category = category;
        this.retryAt = retryAt;
        this.collector = collector;
        this.stack = undefined;
        Object.freeze(this);
    }
}
const READ_ONLY_ROOT_ISSUER = Symbol("read-only-input-root-issuer");
const FIXTURE_SESSION_ISSUER = Symbol("fixture-session-issuer");
function pathIdentity(value) {
    return value.normalize("NFC").toLocaleLowerCase("en-US");
}
async function rejectIdentityCollision(parent, child) {
    const wanted = pathIdentity(child);
    let exactMatches = 0;
    for (const entry of await readdir(parent)) {
        if (pathIdentity(entry) !== wanted)
            continue;
        if (entry !== child)
            throw new SafeError("SECURITY_BOUNDARY", "Unicode or case input path collision");
        exactMatches += 1;
    }
    if (exactMatches !== 1)
        throw new SafeError("SECURITY_BOUNDARY", "input path component missing");
}
async function inspectDirectoryChain(root) {
    if (root.includes("\0") || !path.isAbsolute(root))
        invalidInput("input root must be absolute");
    const resolved = path.resolve(root);
    const parsed = path.parse(resolved);
    const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    const chain = [];
    let current = parsed.root;
    const rootInfo = await lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
        throw new SafeError("SECURITY_BOUNDARY", "unsafe input root ancestor");
    chain.push(Object.freeze({ path: current, dev: rootInfo.dev, ino: rootInfo.ino }));
    for (const component of components) {
        await rejectIdentityCollision(current, component);
        current = path.join(current, component);
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new SafeError("SECURITY_BOUNDARY", "unsafe input root ancestor");
        chain.push(Object.freeze({ path: current, dev: info.dev, ino: info.ino }));
    }
    return Object.freeze(chain);
}
async function verifyDirectoryChain(chain) {
    for (const expected of chain) {
        const current = await lstat(expected.path);
        if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
            throw new SafeError("SECURITY_BOUNDARY", "input ancestor changed during read");
        }
    }
}
function positiveLimit(value, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        invalidInput("invalid input byte limit");
    return value;
}
/** A capability that only opens existing regular files below an immutable root identity. */
export class ReadOnlyInputRoot {
    #root;
    #chain;
    constructor(token, root, chain) {
        if (token !== READ_ONLY_ROOT_ISSUER)
            throw new SafeError("SECURITY_BOUNDARY", "input capability must be factory-issued");
        this.#root = root;
        this.#chain = chain;
        Object.freeze(this);
    }
    static async open(root) {
        const chain = await inspectDirectoryChain(root);
        return new ReadOnlyInputRoot(READ_ONLY_ROOT_ISSUER, path.resolve(root), chain);
    }
    async read(relativeInput, signal, maxBytes) {
        const chunks = [];
        for await (const chunk of this.stream(relativeInput, signal, maxBytes))
            chunks.push(chunk);
        return Buffer.concat(chunks);
    }
    async *stream(relativeInput, signal, maxBytes) {
        if (signal.aborted)
            throw new SafeError("STATE", "input read aborted");
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
            invalidInput("invalid input byte limit");
        const relative = decodeRelativePath(relativeInput);
        const parts = relative.split("/");
        let current = this.#root;
        const descendants = [];
        await verifyDirectoryChain(this.#chain);
        for (const component of parts.slice(0, -1)) {
            await rejectIdentityCollision(current, component);
            current = path.join(current, component);
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory())
                throw new SafeError("SECURITY_BOUNDARY", "unsafe input path ancestor");
            descendants.push(Object.freeze({ path: current, dev: info.dev, ino: info.ino }));
        }
        const leaf = parts.at(-1);
        await rejectIdentityCollision(current, leaf);
        const target = path.join(current, leaf);
        if (!target.startsWith(`${this.#root}${path.sep}`))
            throw new SafeError("SECURITY_BOUNDARY", "input path escaped root");
        const before = await lstat(target);
        if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes)
            throw new SafeError("SECURITY_BOUNDARY", "unsafe input file");
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > maxBytes) {
                throw new SafeError("SECURITY_BOUNDARY", "input changed during open");
            }
            let total = 0;
            while (true) {
                if (signal.aborted)
                    throw new SafeError("STATE", "input read aborted");
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
                const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
                if (bytesRead === 0)
                    break;
                total += bytesRead;
                if (total > maxBytes)
                    throw new SafeError("SECURITY_BOUNDARY", "input exceeds byte limit");
                yield buffer.subarray(0, bytesRead);
            }
            const afterRead = await handle.stat();
            const afterPath = await lstat(target);
            if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.size !== total
                || afterPath.isSymbolicLink() || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino) {
                throw new SafeError("SECURITY_BOUNDARY", "input changed during read");
            }
            await verifyDirectoryChain(this.#chain);
            await verifyDirectoryChain(descendants);
        }
        finally {
            await handle.close();
        }
    }
}
function exactRecord(value, fields, optional = []) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        invalidInput("invalid offline input object");
    const record = value;
    if (fields.some((field) => !Object.hasOwn(record, field)) || Object.keys(record).some((field) => !fields.includes(field) && !optional.includes(field)))
        invalidInput("unexpected offline input fields");
    return record;
}
function decodeCollector(value, owner) {
    if (value === undefined || value === null)
        return null;
    const collector = decodeAccountPartition(value);
    if (collector.hostId !== owner.hostId)
        invalidInput("collector host mismatch");
    return collector;
}
function decodeMode(value) {
    if (value !== "fixture" && value !== "import-json")
        invalidInput("invalid offline input mode");
    return value;
}
function decodeAdapterFailure(value, allowed, collector) {
    const raw = exactRecord(value, ["category", "retryAt"]);
    if (typeof raw.category !== "string" || !allowed.includes(raw.category))
        invalidInput("invalid offline adapter failure category");
    const retryAt = raw.retryAt === null ? null : decodeIsoDateTime(raw.retryAt);
    if (raw.category !== "RATE_LIMITED" && retryAt !== null)
        invalidInput("only rate failures may carry retryAt");
    return new OfflineAdapterError(raw.category, retryAt, collector);
}
function decodeNullableCursor(value) {
    return value === null ? null : decodeServerCursor(value);
}
function mediaKey(kind, ordinal) {
    return `${kind}\u0000${ordinal}`;
}
function assertScopeMembership(scope, note) {
    if (!note.memberships.some((membership) => membership.target === scope.target && membership.boardId === scope.boardId)) {
        invalidInput("detail note is outside page scope");
    }
}
function decodeDetail(value, scope, input, maxMediaBytes, collector) {
    const raw = exactRecord(value, ["note", "revisionAt", "claimedPayloadSha256", "mediaSetComplete", "media"], ["contentCollector"]);
    if (typeof raw.mediaSetComplete !== "boolean" || !Array.isArray(raw.media))
        invalidInput("invalid offline detail");
    const noteRaw = exactRecord(raw.note, ["schemaVersion", "accountId", "hostId", "noteId", "publicUrl", "title", "body", "noteType", "author", "publishedAt", "updatedAt", "capturedAt", "tags", "metrics", "memberships"]);
    const noteId = decodeNoteId(noteRaw.noteId);
    const adapter = getHostAdapter(decodeHostId(noteRaw.hostId));
    const authorRaw = exactRecord(noteRaw.author, ["id", "name", "publicUrl"]);
    if (typeof noteRaw.publicUrl !== "string" || authorRaw.publicUrl !== null && typeof authorRaw.publicUrl !== "string")
        invalidInput("invalid imported public URL");
    const sanitizedAuthor = { ...authorRaw, publicUrl: adapter.normalizeAuthorPublicUrl(authorRaw.publicUrl) };
    const decoded = decodeNote({ ...noteRaw, noteId, publicUrl: adapter.sanitizeImportedUrl(noteRaw.publicUrl, noteId), author: sanitizedAuthor, media: [], contentHash: "0".repeat(64) });
    const semanticNote = Object.freeze({ ...decoded, contentHash: computeContentHash(decoded) });
    if (!sameAccount(semanticNote, scope))
        invalidInput("detail account provenance mismatch");
    assertScopeMembership(scope, semanticNote);
    const note = Object.freeze({
        schemaVersion: semanticNote.schemaVersion,
        accountId: semanticNote.accountId,
        hostId: semanticNote.hostId,
        noteId: semanticNote.noteId,
        publicUrl: semanticNote.publicUrl,
        title: semanticNote.title,
        body: semanticNote.body,
        noteType: semanticNote.noteType,
        author: semanticNote.author,
        publishedAt: semanticNote.publishedAt,
        updatedAt: semanticNote.updatedAt,
        capturedAt: semanticNote.capturedAt,
        tags: semanticNote.tags,
        metrics: semanticNote.metrics,
        memberships: semanticNote.memberships,
    });
    const revisionAt = raw.revisionAt === null ? null : decodeIsoDateTime(raw.revisionAt);
    const sourceRank = createValidatedNoteRank(semanticNote, revisionAt, raw.claimedPayloadSha256 === null ? undefined : raw.claimedPayloadSha256);
    const seen = new Set();
    let mediaFailureCount = 0;
    const mediaSources = raw.media.map((entry) => {
        const isFailure = entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "failure");
        const item = exactRecord(entry, ["kind", "ordinal", "mediaId", isFailure ? "failure" : "relativePath"]);
        if (item.kind !== "cover" && item.kind !== "image" && item.kind !== "video")
            invalidInput("invalid offline media kind");
        if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 1)
            invalidInput("invalid offline media ordinal");
        const kind = item.kind;
        const ordinal = item.ordinal;
        const key = mediaKey(kind, ordinal);
        if (seen.has(key))
            invalidInput("duplicate offline media slot");
        seen.add(key);
        const decodedMedia = decodeMedia({ mediaId: item.mediaId, kind, ordinal, status: "failed", extension: null, object: null });
        const relativePath = isFailure ? null : decodeRelativePath(item.relativePath);
        const failure = isFailure ? decodeAdapterFailure(item.failure, ["MEDIA"]) : null;
        if (failure !== null)
            mediaFailureCount += 1;
        const openMedia = async (signal) => {
            if (failure)
                throw failure;
            if (signal.aborted)
                throw new SafeError("STATE", "input read aborted");
            const iterator = input.stream(relativePath, signal, maxMediaBytes)[Symbol.asyncIterator]();
            return new ReadableStream({
                async pull(controller) {
                    const next = await iterator.next();
                    if (next.done)
                        controller.close();
                    else
                        controller.enqueue(next.value);
                },
                async cancel() { await iterator.return?.(); },
            });
        };
        return Object.freeze({ slot: Object.freeze({ kind, ordinal }), mediaId: decodedMedia.mediaId, suggestedMimeType: null, open: openMedia });
    });
    return Object.freeze({ note, semanticNote, sourceRank, mediaSetComplete: raw.mediaSetComplete, mediaSources: Object.freeze(mediaSources), mediaFailureCount, contentCollector: Object.hasOwn(raw, "contentCollector") ? decodeCollector(raw.contentCollector, scope) : collector });
}
function decodePage(value, account, input, maxMediaBytes, listCollector, contentCollector) {
    const hasListFailure = value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "listFailure");
    const raw = exactRecord(value, ["scope", "requestCursor", "nextCursor", "hasMore", "items", "details", ...(hasListFailure ? ["listFailure"] : [])], ["listCollector"]);
    if (typeof raw.hasMore !== "boolean" || !Array.isArray(raw.items) || !Array.isArray(raw.details))
        invalidInput("invalid offline page");
    const scope = decodePartitionScope(raw.scope);
    if (!sameAccount(scope, account))
        invalidInput("page account provenance mismatch");
    const itemIds = new Set();
    const items = raw.items.map((entry) => {
        const item = exactRecord(entry, ["noteId"]);
        const noteId = decodeNoteId(item.noteId);
        if (itemIds.has(noteId))
            invalidInput("duplicate page item");
        itemIds.add(noteId);
        return Object.freeze({ noteId });
    });
    const details = new Map();
    for (const entry of raw.details) {
        const isFailure = entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "failure");
        if (isFailure) {
            const item = exactRecord(entry, ["noteId", "failure"], ["contentCollector"]);
            const noteId = decodeNoteId(item.noteId);
            if (!itemIds.has(noteId) || details.has(noteId))
                invalidInput("page detail provenance mismatch");
            details.set(noteId, decodeAdapterFailure(item.failure, ["AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "EXPORT"], Object.hasOwn(item, "contentCollector") ? decodeCollector(item.contentCollector, scope) : contentCollector));
        }
        else {
            const detail = decodeDetail(entry, scope, input, maxMediaBytes, contentCollector);
            if (!itemIds.has(detail.note.noteId) || details.has(detail.note.noteId))
                invalidInput("page detail provenance mismatch");
            details.set(detail.note.noteId, detail);
        }
    }
    if (details.size !== items.length)
        invalidInput("page details must exactly match items");
    const pageCollector = Object.hasOwn(raw, "listCollector") ? decodeCollector(raw.listCollector, account) : listCollector;
    const listFailure = hasListFailure ? decodeAdapterFailure(raw.listFailure, ["AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL"], pageCollector) : null;
    if (listFailure !== null && (items.length !== 0 || details.size !== 0))
        invalidInput("list failure page must not contain items");
    return Object.freeze({
        scope,
        requestCursor: decodeNullableCursor(raw.requestCursor),
        nextCursor: decodeNullableCursor(raw.nextCursor),
        hasMore: raw.hasMore,
        items: Object.freeze(items),
        details,
        listFailure,
        listCollector: pageCollector,
    });
}
function decodeRetryItem(value, account, input, maxMediaBytes, contentCollector) {
    const raw = exactRecord(value, ["scope", "noteId", "detail"]);
    const scope = decodePartitionScope(raw.scope);
    if (!sameAccount(scope, account))
        invalidInput("retry account provenance mismatch");
    const noteId = decodeNoteId(raw.noteId);
    const isFailure = raw.detail !== null && typeof raw.detail === "object" && !Array.isArray(raw.detail) && Object.hasOwn(raw.detail, "failure");
    let detail;
    if (isFailure) {
        const failure = exactRecord(raw.detail, ["failure"], ["contentCollector"]);
        detail = decodeAdapterFailure(failure.failure, ["AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "EXPORT"], Object.hasOwn(failure, "contentCollector") ? decodeCollector(failure.contentCollector, scope) : contentCollector);
    }
    else {
        detail = decodeDetail(raw.detail, scope, input, maxMediaBytes, contentCollector);
        if (detail.note.noteId !== noteId)
            invalidInput("retry note provenance mismatch");
    }
    return Object.freeze({ scope, noteId, detail });
}
function decodeEnvelope(value, input, maxMediaBytes) {
    const raw = exactRecord(value, ["schemaVersion", "mode", "account", "pages", "retryItems"], ["listCollector", "contentCollector"]);
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.pages) || !Array.isArray(raw.retryItems))
        invalidInput("unsupported offline input schema");
    const mode = decodeMode(raw.mode);
    const account = decodeAccount(raw.account);
    const accountPartition = Object.freeze({ accountId: account.accountId, hostId: account.hostId });
    const listCollector = decodeCollector(raw.listCollector, accountPartition);
    const contentCollector = decodeCollector(raw.contentCollector, accountPartition);
    const pages = raw.pages.map((page) => decodePage(page, accountPartition, input, maxMediaBytes, listCollector, contentCollector));
    const pageKeys = new Set();
    for (const page of pages) {
        const key = `${page.scope.hostId}\u0000${page.scope.accountId}\u0000${page.scope.target}\u0000${page.scope.boardId ?? ""}\u0000${page.requestCursor ?? ""}`;
        if (pageKeys.has(key))
            invalidInput("ambiguous offline page provenance");
        pageKeys.add(key);
    }
    const retryItems = raw.retryItems.map((item) => decodeRetryItem(item, accountPartition, input, maxMediaBytes, contentCollector));
    const retryKeys = new Set();
    for (const item of retryItems) {
        const key = `${item.scope.hostId}\u0000${item.scope.accountId}\u0000${item.scope.target}\u0000${item.scope.boardId ?? ""}\u0000${item.noteId}`;
        if (retryKeys.has(key))
            invalidInput("ambiguous retry item provenance");
        retryKeys.add(key);
    }
    return Object.freeze({ schemaVersion: 1, mode, account, pages: Object.freeze(pages), retryItems: Object.freeze(retryItems), listCollector, contentCollector });
}
function summarizeEnvelope(envelope) {
    const pageDetails = envelope.pages.flatMap((page) => [...page.details.values()]);
    const retryDetails = envelope.retryItems.map((item) => item.detail);
    const successfulDetails = [...pageDetails, ...retryDetails].filter((detail) => !(detail instanceof OfflineAdapterError));
    const adapterFailureCount = envelope.pages.filter((page) => page.listFailure !== null).length
        + pageDetails.filter((detail) => detail instanceof OfflineAdapterError).length
        + retryDetails.filter((detail) => detail instanceof OfflineAdapterError).length;
    const mediaFailureCount = successfulDetails.reduce((total, detail) => total + detail.mediaFailureCount, 0);
    return Object.freeze({
        schemaVersion: 1,
        mode: envelope.mode,
        pageCount: envelope.pages.length,
        pageItemCount: envelope.pages.reduce((total, page) => total + page.items.length, 0),
        detailSuccessCount: pageDetails.filter((detail) => !(detail instanceof OfflineAdapterError)).length,
        retryItemCount: envelope.retryItems.length,
        retrySuccessCount: retryDetails.filter((detail) => !(detail instanceof OfflineAdapterError)).length,
        mediaSlotCount: successfulDetails.reduce((total, detail) => total + detail.mediaSources.length, 0),
        declaredFailureCount: adapterFailureCount + mediaFailureCount,
        mediaFailureCount,
    });
}
function findPage(pages, scope, requestCursor) {
    const matches = pages.filter((page) => sameScope(page.scope, scope) && page.requestCursor === requestCursor);
    if (matches.length !== 1)
        invalidInput("offline page provenance match must be unique");
    return matches[0];
}
export class FixtureSession {
    account;
    client;
    retrySource;
    mode;
    summary;
    listCollector;
    contentCollector;
    hasListPage;
    #closed = false;
    #listCalls = 0;
    #activePage = null;
    #detailCalls = 0;
    #retryCalls = 0;
    constructor(token, envelope) {
        if (token !== FIXTURE_SESSION_ISSUER)
            throw new SafeError("SECURITY_BOUNDARY", "fixture session must be factory-issued");
        this.account = envelope.account;
        this.mode = envelope.mode;
        this.summary = summarizeEnvelope(envelope);
        this.listCollector = envelope.listCollector;
        this.contentCollector = envelope.contentCollector;
        this.hasListPage = (scope, requestCursor) => envelope.pages.some((page) => sameScope(page.scope, scope) && page.requestCursor === requestCursor);
        const account = Object.freeze({ accountId: envelope.account.accountId, hostId: envelope.account.hostId });
        const assertOpen = () => {
            if (this.#closed)
                throw new SafeError("STATE", "offline session is closed");
        };
        const listPage = async (scopeInput, cursorInput, limit) => {
            assertOpen();
            this.#listCalls += 1;
            const scope = decodePartitionScope(scopeInput);
            if (!sameAccount(scope, account))
                invalidInput("client account provenance mismatch");
            const requestCursor = cursorInput === null ? null : decodeServerCursor(cursorInput);
            if (!Number.isSafeInteger(limit) || limit < 1)
                invalidInput("list limit must be positive");
            const page = findPage(envelope.pages, scope, requestCursor);
            if (page.listFailure)
                throw page.listFailure;
            this.#activePage = page;
            return Object.freeze({ scope: page.scope, requestCursor: page.requestCursor, nextCursor: page.nextCursor, hasMore: page.hasMore, items: page.items, listCollector: page.listCollector });
        };
        const findDetail = (scope, noteId) => {
            const retry = envelope.retryItems.find((item) => sameScope(item.scope, scope) && item.noteId === noteId);
            if (retry)
                return retry.detail;
            if (this.#activePage && sameScope(this.#activePage.scope, scope) && this.#activePage.details.has(noteId))
                return this.#activePage.details.get(noteId);
            const matches = envelope.pages.filter((page) => sameScope(page.scope, scope)).flatMap((page) => page.details.has(noteId) ? [page.details.get(noteId)] : []);
            if (matches.length === 0)
                throw new OfflineAdapterError("DETAIL", null);
            return matches.at(-1);
        };
        const getDetail = async (scopeInput, noteIdInput) => {
            assertOpen();
            const scope = decodePartitionScope(scopeInput);
            const noteId = decodeNoteId(noteIdInput);
            if (!sameAccount(scope, account))
                invalidInput("detail account provenance mismatch");
            const detail = findDetail(scope, noteId);
            this.#detailCalls += 1;
            if (detail instanceof OfflineAdapterError)
                throw detail;
            return detail;
        };
        const getRetry = async (scopeInput, noteIdInput) => {
            assertOpen();
            const scope = decodePartitionScope(scopeInput);
            const noteId = decodeNoteId(noteIdInput);
            if (!sameAccount(scope, account))
                invalidInput("retry account provenance mismatch");
            this.#retryCalls += 1;
            const detail = findDetail(scope, noteId);
            if (detail instanceof OfflineAdapterError)
                throw detail;
            return detail;
        };
        this.client = Object.freeze({ account, listPage, getDetail });
        this.retrySource = Object.freeze({ account, get: getRetry });
        Object.freeze(this);
    }
    static async open(options) {
        const expectedMode = decodeMode(options.mode);
        const expectedAccount = decodeAccountPartition(options.account);
        const maxJsonBytes = positiveLimit(options.maxJsonBytes, 16 * 1024 * 1024);
        const maxMediaBytes = positiveLimit(options.maxMediaBytes, 512 * 1024 * 1024);
        const input = await ReadOnlyInputRoot.open(options.inputRoot);
        const bytes = await input.read(options.inputFile, new AbortController().signal, maxJsonBytes);
        const text = Buffer.from(bytes).toString("utf8");
        if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)))
            invalidInput("offline input must be valid UTF-8");
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            invalidInput("offline input must be valid JSON");
        }
        const envelope = decodeEnvelope(parsed, input, maxMediaBytes);
        if (envelope.mode !== expectedMode)
            invalidInput("offline adapter mode provenance mismatch");
        if (!sameAccount(envelope.account, expectedAccount))
            invalidInput("offline account provenance mismatch");
        return new FixtureSession(FIXTURE_SESSION_ISSUER, envelope);
    }
    close() {
        this.#closed = true;
        this.#activePage = null;
    }
    usage() {
        return Object.freeze({ listCalls: this.#listCalls, detailCalls: this.#detailCalls, retryCalls: this.#retryCalls });
    }
}
