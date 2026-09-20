import { constants } from "node:fs";
import { chmodSync, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Bytes, sha256Canonical, utf8Compare } from "./canonical.js";
import { SafeError, isSqliteBusy, normalizeSafeError } from "./errors.js";
import { computeContentHash, computeFailureId, indexEntryDigest, mergeAccount, mergeCanonicalNote, mergeFailure } from "./merge.js";
import { noteCsvRowDigest } from "./merge.js";
import { assertValidatedRankForNote, compareSourceRank } from "./rank.js";
import { FileContentAddressedObjectStore, objectExtension } from "./object-store.js";
import { renderNoteJsonBytes, renderNoteMarkdownBytes } from "./exporters.js";
import { ensureSecureRoot } from "./paths.js";
import { decodeRelativePath } from "./paths.js";
import { MemorySecretRegistry, assertPersistenceSafe, assertSerializedPersistenceSafe } from "./secrets.js";
import { accountKey, accountPartition, assertProgressInvariant, assertTaskInvariant, decodeAccountId, decodeAccount, decodeAccountPartition, decodeBoardId, decodeHostId, decodeIsoDateTime, decodeNoteId, decodeNote, decodeNoteManifest, decodeMediaSlotState, decodeObjectRef, decodePartitionScope, decodeSha256, decodeState, decodeTaskRecord, decodeFailureRecord, decodeRunRecord, noteKey, sameAccount, sameScope, scopeKey, } from "./types.js";
import { PROJECTOR_ORDER, assertProjectorNamespace } from "./view-types.js";
import { assertProjectionMaterialized, assertTrustedProjectionOutcome, projectionBatchProvenance } from "./projectors.js";
const CURRENT_SCHEMA_VERSION = 1;
const REQUIRED_TABLES = Object.freeze(["meta", "schema_migrations", "accounts", "account_generations", "sync_states", "album_states", "note_manifests", "media_slots", "target_tasks", "failures", "task_failures", "objects", "runs", "view_generations"]);
const DDL = `
CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version >= 0), schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64));
CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY, command TEXT NOT NULL CHECK(command IN ('init_schema','migrate_schema')),
  from_version INTEGER, to_version INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome='committed'), safe_error_category TEXT CHECK(safe_error_category IS NULL)
);
CREATE TABLE accounts (
  account_key TEXT PRIMARY KEY CHECK(length(account_key)=64), host_id TEXT NOT NULL CHECK(host_id IN ('xhs','rednote')),
  account_id TEXT NOT NULL, display_name TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  UNIQUE(host_id,account_id)
);
CREATE TABLE account_generations (
  account_key TEXT PRIMARY KEY REFERENCES accounts(account_key) ON DELETE CASCADE,
  canonical_generation INTEGER NOT NULL DEFAULT 0 CHECK(canonical_generation>=0), views_dirty INTEGER NOT NULL DEFAULT 1 CHECK(views_dirty IN (0,1))
);
CREATE TABLE sync_states (
  scope_key TEXT PRIMARY KEY CHECK(length(scope_key)=64), account_key TEXT NOT NULL REFERENCES accounts(account_key), host_id TEXT NOT NULL,
  account_id TEXT NOT NULL, target TEXT NOT NULL CHECK(target IN ('posted','collected','liked')), board_id TEXT CHECK(board_id IS NULL),
  progress_json TEXT NOT NULL, stop_reason TEXT, last_attempt_at TEXT, last_successful_at TEXT, next_allowed_at TEXT,
  revision INTEGER NOT NULL CHECK(revision>=0), record_json TEXT NOT NULL
);
CREATE TABLE album_states (
  scope_key TEXT PRIMARY KEY CHECK(length(scope_key)=64), account_key TEXT NOT NULL REFERENCES accounts(account_key), host_id TEXT NOT NULL,
  account_id TEXT NOT NULL, target TEXT NOT NULL CHECK(target='collected_album'), board_id TEXT NOT NULL, board_name TEXT,
  progress_json TEXT NOT NULL, stop_reason TEXT, last_attempt_at TEXT, last_successful_at TEXT, next_allowed_at TEXT,
  revision INTEGER NOT NULL CHECK(revision>=0), record_json TEXT NOT NULL
);
CREATE TABLE objects (hash TEXT PRIMARY KEY CHECK(length(hash)=64), byte_length INTEGER NOT NULL CHECK(byte_length>=0), mime_type TEXT NOT NULL, first_seen_at TEXT NOT NULL);
CREATE TABLE note_manifests (
  note_key TEXT PRIMARY KEY CHECK(length(note_key)=64), account_key TEXT NOT NULL REFERENCES accounts(account_key), host_id TEXT NOT NULL,
  account_id TEXT NOT NULL, note_id TEXT NOT NULL, canonical_note_json TEXT NOT NULL, semantic_rank_json TEXT NOT NULL,
  content_hash TEXT NOT NULL, json_object_hash TEXT NOT NULL REFERENCES objects(hash), markdown_object_hash TEXT NOT NULL REFERENCES objects(hash),
  entry_hash TEXT NOT NULL, csv_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), record_json TEXT NOT NULL,
  UNIQUE(host_id,account_id,note_id)
);
CREATE TABLE media_slots (
  note_key TEXT NOT NULL REFERENCES note_manifests(note_key) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('cover','image','video')),
  ordinal INTEGER NOT NULL CHECK(ordinal>0), source_rank_json TEXT NOT NULL, status TEXT, object_hash TEXT REFERENCES objects(hash), extension TEXT,
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)), record_json TEXT NOT NULL, PRIMARY KEY(note_key,kind,ordinal)
);
CREATE TABLE target_tasks (
  scope_key TEXT NOT NULL, account_key TEXT NOT NULL REFERENCES accounts(account_key), note_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','paused','done','partial','failed','skipped')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count>=0), skip_reason TEXT, skipped_at TEXT, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL, PRIMARY KEY(scope_key,note_key), CHECK((status='skipped')=(skip_reason IS NOT NULL AND skipped_at IS NOT NULL))
);
CREATE TABLE failures (
  failure_id TEXT PRIMARY KEY, account_key TEXT NOT NULL REFERENCES accounts(account_key), scope_key TEXT NOT NULL,
  note_key TEXT NOT NULL, media_kind TEXT, media_ordinal INTEGER, source_rank_json TEXT,
  category TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('detail','media','export')), safe_message TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK(retryable IN (0,1)), attempts INTEGER NOT NULL CHECK(attempts>0), first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL, retry_at TEXT, resolved_at TEXT, resolved_reason TEXT,
  record_json TEXT NOT NULL, CHECK((resolved_at IS NULL AND resolved_reason IS NULL) OR (resolved_at IS NOT NULL AND resolved_reason IN ('repaired','skipped'))),
  CHECK((stage='media' AND media_kind IS NOT NULL AND media_ordinal>0 AND source_rank_json IS NOT NULL) OR (stage!='media' AND media_kind IS NULL AND media_ordinal IS NULL AND source_rank_json IS NULL))
);
CREATE TABLE task_failures (
  scope_key TEXT NOT NULL, note_key TEXT NOT NULL, failure_id TEXT NOT NULL REFERENCES failures(failure_id) ON DELETE CASCADE,
  PRIMARY KEY(scope_key,note_key,failure_id), FOREIGN KEY(scope_key,note_key) REFERENCES target_tasks(scope_key,note_key) ON DELETE CASCADE
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, account_key TEXT NOT NULL REFERENCES accounts(account_key), scope_key TEXT, command TEXT NOT NULL,
  outcome TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, safe_error_category TEXT,
  listed INTEGER NOT NULL CHECK(listed>=0), done INTEGER NOT NULL CHECK(done>=0), partial INTEGER NOT NULL CHECK(partial>=0),
  failed INTEGER NOT NULL CHECK(failed>=0), skipped INTEGER NOT NULL CHECK(skipped>=0), record_json TEXT NOT NULL,
  CHECK((command='repair_views' AND scope_key IS NULL) OR (command!='repair_views' AND scope_key IS NOT NULL))
);
CREATE TABLE view_generations (
  account_key TEXT NOT NULL REFERENCES accounts(account_key), projector_id TEXT NOT NULL CHECK(projector_id IN ('notes','assets','index','failures','runs')),
  generation INTEGER NOT NULL CHECK(generation>=0), complete INTEGER NOT NULL CHECK(complete IN (0,1)), receipts_json TEXT NOT NULL,
  safe_error TEXT, PRIMARY KEY(account_key,projector_id), CHECK((complete=1 AND safe_error IS NULL) OR (complete=0 AND safe_error IS NOT NULL AND length(safe_error)>0))
);
CREATE INDEX failures_retry_idx ON failures(scope_key,resolved_at,retry_at,first_occurred_at,failure_id);
CREATE INDEX manifests_account_idx ON note_manifests(account_key,note_key);
CREATE INDEX tasks_scope_idx ON target_tasks(scope_key,note_key);
CREATE INDEX runs_account_idx ON runs(account_key,finished_at,run_id);
`;
const LEGACY_V0_DDL = DDL.replace("CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version >= 0), schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64));", "CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version = 0));");
function parseJson(text) {
    if (typeof text !== "string")
        throw new SafeError("CANONICAL_INTEGRITY", "invalid database JSON");
    try {
        return JSON.parse(text);
    }
    catch {
        throw new SafeError("CANONICAL_INTEGRITY", "invalid database JSON");
    }
}
function rowString(row, field) { const v = row[field]; if (typeof v !== "string")
    throw new SafeError("CANONICAL_INTEGRITY", "invalid database row"); return v; }
function asRows(value) { return value; }
function exactCommand(value, fields) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new SafeError("INVALID_INPUT", "invalid canonical mutation");
    const record = value;
    const actual = Object.keys(record).sort();
    const expected = [...fields].sort();
    if (canonicalJson(actual) !== canonicalJson(expected))
        throw new SafeError("INVALID_INPUT", "unexpected canonical mutation fields");
    return record;
}
function decodeCanonicalMutation(value) {
    const r = exactCommand(value, ["scope", "expectedStateRevision", "expectedManifestRevisions", "nextState", "candidates", "manifests", "tasks", "failureOccurrences", "failureResolutions", "failures"]);
    const scope = decodePartitionScope(r.scope);
    const nextState = decodeState(r.nextState);
    if (!sameScope(scope, nextState) || typeof r.expectedStateRevision !== "number" || !Number.isSafeInteger(r.expectedStateRevision) || r.expectedStateRevision < 0)
        throw new SafeError("INVALID_INPUT", "invalid canonical mutation state");
    if (!Array.isArray(r.candidates) || !Array.isArray(r.manifests) || !Array.isArray(r.tasks) || !Array.isArray(r.failureOccurrences) || !Array.isArray(r.failureResolutions) || !Array.isArray(r.failures) || r.expectedManifestRevisions === null || typeof r.expectedManifestRevisions !== "object" || Array.isArray(r.expectedManifestRevisions))
        throw new SafeError("INVALID_INPUT", "invalid canonical mutation collections");
    const expectedManifestRevisions = Object.create(null);
    for (const [rawId, revision] of Object.entries(r.expectedManifestRevisions)) {
        const id = decodeNoteId(rawId);
        if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1))
            throw new SafeError("INVALID_INPUT", "invalid expected manifest revision");
        expectedManifestRevisions[id] = revision;
    }
    const candidates = r.candidates.map((value) => {
        const candidate = exactCommand(value, ["note", "sourceRank", "mediaSlots", "mediaSetComplete"]);
        if (!Array.isArray(candidate.mediaSlots) || typeof candidate.mediaSetComplete !== "boolean")
            throw new SafeError("INVALID_INPUT", "invalid merge candidate");
        const note = decodeNote(candidate.note);
        assertValidatedRankForNote(candidate.sourceRank, note);
        return Object.freeze({ note, sourceRank: candidate.sourceRank, mediaSlots: Object.freeze(candidate.mediaSlots.map(decodeMediaSlotState)), mediaSetComplete: candidate.mediaSetComplete });
    });
    const failureOccurrences = r.failureOccurrences.map((value) => { const occurrence = exactCommand(value, ["failure"]); return Object.freeze({ failure: decodeFailureRecord(occurrence.failure) }); });
    return Object.freeze({ scope, expectedStateRevision: r.expectedStateRevision, expectedManifestRevisions: Object.freeze(expectedManifestRevisions), nextState, candidates: Object.freeze(candidates), manifests: Object.freeze(r.manifests.map(decodeNoteManifest)), tasks: Object.freeze(r.tasks.map(decodeTaskRecord)), failureOccurrences: Object.freeze(failureOccurrences), failureResolutions: Object.freeze(r.failureResolutions.map(decodeFailureRecord)), failures: Object.freeze(r.failures.map(decodeFailureRecord)) });
}
function decodeViewReceipt(value) {
    const r = exactCommand(value, ["projectorId", "accountKey", "generation", "relativePath", "sha256", "byteLength"]);
    if (!PROJECTOR_ORDER.includes(r.projectorId) || typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 0 || typeof r.byteLength !== "number" || !Number.isSafeInteger(r.byteLength) || r.byteLength < 0)
        throw new SafeError("CANONICAL_INTEGRITY", "invalid view receipt");
    const receipt = Object.freeze({ projectorId: r.projectorId, accountKey: decodeSha256(r.accountKey), generation: r.generation, relativePath: decodeRelativePath(r.relativePath), sha256: decodeSha256(r.sha256), byteLength: r.byteLength });
    assertProjectorNamespace(receipt.accountKey, receipt.projectorId, receipt.relativePath);
    return receipt;
}
function secureOpenDatabaseFiles(dbPath) {
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            const before = lstatSync(candidate);
            if (before.isSymbolicLink() || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0)
                throw new SafeError("SECURITY_BOUNDARY", "unsafe open SQLite file");
            chmodSync(candidate, 0o600);
            const after = lstatSync(candidate);
            if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || (after.mode & 0o777) !== 0o600)
                throw new SafeError("SECURITY_BOUNDARY", "SQLite permission hardening failed");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
function inspectOpenDatabaseFiles(dbPath) {
    const database = lstatSync(dbPath);
    if (database.isSymbolicLink() || !database.isFile() || database.uid !== process.getuid?.() || (database.mode & 0o777) !== 0o600)
        throw new SafeError("SECURITY_BOUNDARY", "unsafe read-only SQLite file");
    for (const candidate of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            const info = lstatSync(candidate);
            if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
                throw new SafeError("SECURITY_BOUNDARY", "unsafe read-only SQLite sidecar");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
function configure(db, dbPath) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const fk = db.prepare("PRAGMA foreign_keys").get();
    const mode = db.prepare("PRAGMA journal_mode").get();
    if (Number(Object.values(fk)[0]) !== 1 || String(Object.values(mode)[0]).toLowerCase() !== "wal")
        throw new SafeError("STATE", "SQLite capability check failed");
    if (dbPath)
        secureOpenDatabaseFiles(dbPath);
}
function configureReadOnly(db, dbPath) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
    const fk = db.prepare("PRAGMA foreign_keys").get();
    const mode = db.prepare("PRAGMA journal_mode").get();
    if (Number(Object.values(fk)[0]) !== 1 || String(Object.values(mode)[0]).toLowerCase() !== "wal")
        throw new SafeError("STATE", "read-only SQLite capability check failed");
    inspectOpenDatabaseFiles(dbPath);
}
function tableNames(db) {
    return asRows(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).map((row) => rowString(row, "name"));
}
function schemaShape(db) {
    return asRows(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : null }));
}
let expectedSchemaFingerprintCache = null;
function expectedSchemaFingerprint() {
    if (expectedSchemaFingerprintCache)
        return expectedSchemaFingerprintCache;
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(DDL);
        expectedSchemaFingerprintCache = sha256Canonical(schemaShape(db));
        return expectedSchemaFingerprintCache;
    }
    finally {
        db.close();
    }
}
let legacySchemaFingerprintCache = null;
function legacySchemaFingerprint() {
    if (legacySchemaFingerprintCache)
        return legacySchemaFingerprintCache;
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(LEGACY_V0_DDL);
        legacySchemaFingerprintCache = sha256Canonical(schemaShape(db));
        return legacySchemaFingerprintCache;
    }
    finally {
        db.close();
    }
}
function validateSchema(db) {
    const names = new Set(tableNames(db));
    for (const table of REQUIRED_TABLES)
        if (!names.has(table))
            throw new SafeError("STATE", "required schema missing");
    const meta = asRows(db.prepare("SELECT schema_version,schema_fingerprint FROM meta").all());
    const expectedFingerprint = expectedSchemaFingerprint();
    if (meta.length !== 1 || Number(meta[0].schema_version) !== CURRENT_SCHEMA_VERSION || meta[0].schema_fingerprint !== expectedFingerprint || sha256Canonical(schemaShape(db)) !== expectedFingerprint)
        throw new SafeError("STATE", "unsupported or modified schema");
    const fk = asRows(db.prepare("PRAGMA foreign_key_check").all());
    if (fk.length !== 0)
        throw new SafeError("STATE", "foreign key check failed");
}
function migrationSourceVersion(db) {
    const names = new Set(tableNames(db));
    for (const table of REQUIRED_TABLES)
        if (!names.has(table))
            throw new SafeError("STATE", "migration source schema is incomplete");
    const columns = asRows(db.prepare("PRAGMA table_info(meta)").all());
    if (columns.length !== 1 || columns[0].name !== "schema_version" || String(columns[0].type).toUpperCase() !== "INTEGER" || Number(columns[0].notnull) !== 1)
        throw new SafeError("STATE", "migration source meta is invalid");
    const rows = asRows(db.prepare("SELECT schema_version FROM meta").all());
    if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0].schema_version)))
        throw new SafeError("STATE", "migration source meta is invalid");
    const version = Number(rows[0].schema_version);
    if (version >= CURRENT_SCHEMA_VERSION || version !== 0)
        throw new SafeError("STATE", version > CURRENT_SCHEMA_VERSION ? "future schema version" : "unsupported migration source");
    if (sha256Canonical(schemaShape(db)) !== legacySchemaFingerprint())
        throw new SafeError("STATE", "migration source schema is modified");
    if (asRows(db.prepare("PRAGMA foreign_key_check").all()).length !== 0)
        throw new SafeError("STATE", "migration source foreign key check failed");
    return version;
}
async function prepareDatabasePath(root) {
    const trusted = await ensureSecureRoot(root);
    const state = path.join(trusted, "state");
    let stateCreated = false;
    try {
        await lstat(state);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await mkdir(state, { mode: 0o700 });
        stateCreated = true;
    }
    if (stateCreated)
        await chmod(state, 0o700);
    const stateInfo = await lstat(state);
    if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory() || stateInfo.uid !== process.getuid?.() || (stateInfo.mode & 0o777) !== 0o700)
        throw new SafeError("SECURITY_BOUNDARY", "unsafe state directory");
    const dbPath = path.join(state, "rednote-sync.sqlite");
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            const info = await lstat(candidate);
            const unsafeMode = (info.mode & 0o777) !== 0o600;
            if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || unsafeMode)
                throw new SafeError("SECURITY_BOUNDARY", "unsafe SQLite file");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return dbPath;
}
async function existingDatabasePath(root) {
    const requested = path.resolve(root);
    const rootInfo = await lstat(requested);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
        throw new SafeError("SECURITY_BOUNDARY", "unsafe read-only root");
    const resolved = await ensureSecureRoot(requested);
    const state = path.join(resolved, "state");
    const stateInfo = await lstat(state);
    if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory() || stateInfo.uid !== process.getuid?.() || (stateInfo.mode & 0o777) !== 0o700)
        throw new SafeError("SECURITY_BOUNDARY", "unsafe read-only state directory");
    const dbPath = path.join(state, "rednote-sync.sqlite");
    inspectOpenDatabaseFiles(dbPath);
    return dbPath;
}
export function sqliteRuntimeSelfCheck() {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id)); BEGIN IMMEDIATE; INSERT INTO p VALUES(1); ROLLBACK;");
        const count = db.prepare("SELECT count(*) AS n FROM p").get();
        if (Number(count.n) !== 0)
            throw new SafeError("STATE", "SQLite rollback check failed");
    }
    finally {
        db.close();
    }
}
export function applySequentialMigrations(db, fromVersion, toVersion, steps) {
    if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion) || fromVersion < 0 || toVersion < fromVersion)
        throw new SafeError("INVALID_INPUT", "invalid migration range");
    db.exec("BEGIN IMMEDIATE");
    try {
        for (let version = fromVersion + 1; version <= toVersion; version += 1) {
            const step = steps.get(version);
            if (!step)
                throw new SafeError("STATE", "missing sequential migration");
            step(db);
            db.prepare("UPDATE meta SET schema_version=?").run(version);
        }
        db.exec("COMMIT");
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
class SnapshotBase {
    snapshotBrand = Symbol("sqlite-snapshot");
    connectionIdentity;
    #active = true;
    constructor(store, issuanceToken) {
        if (issuanceToken !== SNAPSHOT_ISSUANCE_TOKEN)
            throw new SafeError("STATE", "snapshot constructor is private");
        SNAPSHOT_STORES.set(this, store);
        SNAPSHOT_ACTIVE.add(this);
        this.connectionIdentity = store.connectionIdentity;
    }
    #owner() { const owner = SNAPSHOT_STORES.get(this); if (!owner)
        throw new SafeError("STATE", "invalid snapshot capability"); return owner; }
    assertActive() { if (!this.#active || !isExactActiveSnapshot(this))
        throw new SafeError("STATE", "closed or foreign snapshot"); }
    invalidate() { this.#active = false; SNAPSHOT_ACTIVE.delete(this); const owner = SNAPSHOT_STORES.get(this); if (owner && STORE_ACTIVE_SNAPSHOTS.get(owner) === this)
        STORE_ACTIVE_SNAPSHOTS.delete(owner); }
    enumerateAccountsWithGenerations() { assertExactSnapshot(this); return storeQueries(this.#owner()).accounts(); }
    enumerateViewGenerations(key) { assertExactSnapshot(this); return storeQueries(this.#owner()).views(key); }
    accountGeneration(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).generation(account); }
    loadState(scope) { assertExactSnapshot(this); return storeQueries(this.#owner()).state(scope); }
    loadManifest(account, id) { assertExactSnapshot(this); return storeQueries(this.#owner()).manifest(account, id); }
    loadTask(scope, id) { assertExactSnapshot(this); return storeQueries(this.#owner()).task(scope, id); }
    enumerateAccountManifests(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).manifests(account); }
    enumerateAccountTasks(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).tasks(account); }
    listNoteTasks(account, noteId) { assertExactSnapshot(this); return storeQueries(this.#owner()).noteTasks(account, noteId); }
    listNoteFailures(account, noteId) { assertExactSnapshot(this); return storeQueries(this.#owner()).noteFailures(account, noteId); }
    enumerateUnresolvedFailures(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).failures(account); }
    enumerateRuns(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).runs(account); }
    enumerateObjectRefs(account) { assertExactSnapshot(this); return storeQueries(this.#owner()).objectRefs(account); }
    retryCandidates(scope, limit) { assertExactSnapshot(this); return storeQueries(this.#owner()).retry(scope, limit); }
    close() { this.#owner().closeSnapshot(this); }
}
const SNAPSHOT_STORES = new WeakMap();
const SNAPSHOT_ACTIVE = new WeakSet();
const SNAPSHOT_ISSUANCE_TOKEN = Object.freeze({});
const STORE_ACTIVE_SNAPSHOTS = new WeakMap();
const WRITE_SNAPSHOTS = new WeakSet();
const WRITE_STATES = new WeakMap();
const WRITE_PLANS = new WeakMap();
const BUSINESS_RESULTS = new WeakMap();
const STORE_QUERIES = new WeakMap();
const STORE_OBJECTS = new WeakMap();
function storeQueries(store) { const queries = STORE_QUERIES.get(store); if (!queries)
    throw new SafeError("STATE", "invalid store query capability"); return queries; }
function snapshotOwner(snapshot) { const owner = SNAPSHOT_STORES.get(snapshot); if (!owner)
    throw new SafeError("STATE", "invalid snapshot capability"); return owner; }
function isExactActiveSnapshot(snapshot) { const owner = SNAPSHOT_STORES.get(snapshot); return !!owner && SNAPSHOT_ACTIVE.has(snapshot) && STORE_ACTIVE_SNAPSHOTS.get(owner) === snapshot; }
function assertExactSnapshot(snapshot) { if (!isExactActiveSnapshot(snapshot))
    throw new SafeError("STATE", "closed or foreign snapshot"); }
function writeState(snapshot) { const state = WRITE_STATES.get(snapshot); if (!state)
    throw new SafeError("STATE", "invalid write transaction capability"); return state; }
class ReadSnapshot extends SnapshotBase {
    kind = "read";
}
class WriteSnapshot extends SnapshotBase {
    kind = "write";
    transactionIdentity = Symbol("sqlite-write-transaction");
    intent;
    constructor(store, intent, issuanceToken) { super(store, issuanceToken); this.intent = intent; WRITE_SNAPSHOTS.add(this); WRITE_STATES.set(this, { intent, finalized: false, mutationWritten: false, businessResultIssued: false, primaryNoteIds: intent.command === "repair_views" ? Object.freeze([]) : null, summary: intent.command === "repair_views" ? Object.freeze({ listed: 0, done: 0, partial: 0, failed: 0, skipped: 0, mutationApplied: false }) : null }); Object.freeze(this); }
}
export function assertTrustedWriteSnapshot(value) {
    if (!(value instanceof WriteSnapshot) || !WRITE_SNAPSHOTS.has(value))
        throw new SafeError("STATE", "untrusted write snapshot");
    if (!isExactActiveSnapshot(value))
        throw new SafeError("STATE", "closed write snapshot");
    if (writeState(value).finalized)
        throw new SafeError("STATE", "finalized snapshot cannot project");
}
export function projectorTransactionCapability(value, accountInput) {
    assertTrustedWriteSnapshot(value);
    const snapshot = value;
    const account = decodeAccountPartition(accountInput);
    const state = writeState(snapshot);
    const intended = state.intent.command === "repair_views" ? state.intent.account : accountPartition(state.intent.scope);
    if (!sameAccount(account, intended) || state.summary === null)
        throw new SafeError("STATE", "projector transaction is not ready");
    const queries = storeQueries(snapshotOwner(snapshot));
    const frozenAccount = Object.freeze({ ...account });
    const view = Object.freeze({ account: frozenAccount, manifests: () => queries.manifests(frozenAccount), tasks: () => queries.tasks(frozenAccount), failures: () => queries.failures(frozenAccount), runs: () => queries.runs(frozenAccount) });
    return Object.freeze({ account: frozenAccount, generation: queries.generation(frozenAccount), views: Object.freeze(queries.views(accountKey(frozenAccount))), summary: state.summary, intent: state.intent, objects: STORE_OBJECTS.get(snapshotOwner(snapshot)), view });
}
export function businessResultProvenance(value, transaction) {
    if (value === null || typeof value !== "object")
        throw new SafeError("STATE", "untrusted business result");
    assertTrustedWriteSnapshot(transaction);
    const provenance = BUSINESS_RESULTS.get(value);
    const state = writeState(transaction);
    if (!provenance || provenance.transaction !== transaction || provenance.result !== value || state.summary === null || provenance.summary !== state.summary)
        throw new SafeError("STATE", "untrusted or foreign business result");
    return Object.freeze({ result: provenance.result, summary: state.summary });
}
class SchemaTransaction {
    transactionBrand = Symbol("sqlite-schema-transaction");
    active = true;
    store;
    command;
    constructor(store, command) { this.store = store; this.command = command; }
}
export class SqliteStateStore {
    connectionIdentity = Symbol("sqlite-connection");
    registry;
    #objects;
    #active = null;
    #closed = false;
    root;
    #db;
    #beforeCommit;
    #beforeFinalizeStep;
    #readOnly = false;
    constructor(root, db, registry = new MemorySecretRegistry(), options = {}, readOnly = false) {
        this.root = root;
        this.#db = db;
        this.registry = registry;
        this.#objects = new FileContentAddressedObjectStore(root, registry);
        this.#beforeCommit = options.beforeCommit;
        this.#beforeFinalizeStep = options.beforeFinalizeStep;
        this.#readOnly = readOnly;
        STORE_OBJECTS.set(this, this.#objects);
        STORE_QUERIES.set(this, Object.freeze({ accounts: () => this.#queryAccounts(), views: (key) => this.#queryViews(key), generation: (account) => this.#queryGeneration(account), state: (scope) => this.#queryState(scope), manifest: (account, id) => this.#queryManifest(account, id), task: (scope, id) => this.#queryTask(scope, id), manifests: (account) => this.#queryManifests(account), tasks: (account) => this.#queryTasks(account), noteTasks: (account, id) => this.#queryTasks(account, id), noteFailures: (account, id) => this.#queryFailures(account, id), failures: (account) => this.#queryFailures(account), runs: (account) => this.#queryRuns(account), objectRefs: (account) => this.#queryObjectRefs(account), retry: (scope, limit) => this.#queryRetry(scope, limit) }));
        Object.freeze(this);
    }
    static async init(root, registry = new MemorySecretRegistry(), options = {}) {
        sqliteRuntimeSelfCheck();
        const dbPath = await prepareDatabasePath(root);
        const existed = await stat(dbPath).then(() => true, () => false);
        const db = new DatabaseSync(dbPath);
        try {
            configure(db, dbPath);
            const names = tableNames(db);
            if (names.length !== 0)
                throw new SafeError("STATE", "init requires an empty database");
            db.exec("BEGIN IMMEDIATE");
            try {
                db.exec(DDL);
                db.prepare("INSERT INTO meta(schema_version,schema_fingerprint) VALUES(?,?)").run(CURRENT_SCHEMA_VERSION, expectedSchemaFingerprint());
                const now = new Date().toISOString();
                db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?,?,?,?,?)").run("init-v1", "init_schema", null, 1, now, now, "committed", null);
                validateSchema(db);
                db.exec("COMMIT");
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
            await chmod(dbPath, 0o600);
            secureOpenDatabaseFiles(dbPath);
            return new SqliteStateStore(root, db, registry, options);
        }
        catch (error) {
            db.close();
            if (!existed)
                await chmod(dbPath, 0o600).catch(() => { });
            throw normalizeSafeError(error, "STATE", "schema initialization failed");
        }
    }
    static async open(root, registry = new MemorySecretRegistry(), options = {}) {
        sqliteRuntimeSelfCheck();
        const dbPath = await prepareDatabasePath(root);
        const db = new DatabaseSync(dbPath, { open: true });
        try {
            configure(db, dbPath);
            validateSchema(db);
            return new SqliteStateStore(root, db, registry, options);
        }
        catch (error) {
            db.close();
            throw normalizeSafeError(error, "STATE", "state database open failed");
        }
    }
    static async openReadOnly(root, registry = new MemorySecretRegistry()) {
        sqliteRuntimeSelfCheck();
        const dbPath = await existingDatabasePath(root);
        const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        try {
            configureReadOnly(db, dbPath);
            validateSchema(db);
            return new SqliteStateStore(root, db, registry, {}, true);
        }
        catch (error) {
            db.close();
            throw normalizeSafeError(error, "STATE", "read-only state database open failed");
        }
    }
    static async migrate(root, registry = new MemorySecretRegistry(), options = {}) {
        sqliteRuntimeSelfCheck();
        const dbPath = await prepareDatabasePath(root);
        const db = new DatabaseSync(dbPath, { open: true });
        try {
            configure(db, dbPath);
            const fromVersion = migrationSourceVersion(db);
            db.exec("BEGIN IMMEDIATE");
            try {
                let version = fromVersion;
                while (version < CURRENT_SCHEMA_VERSION) {
                    const next = version + 1;
                    if (version !== 0 || next !== 1)
                        throw new SafeError("STATE", "missing sequential migration");
                    const now = new Date().toISOString();
                    db.exec("ALTER TABLE meta RENAME TO meta_v0; CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version >= 0), schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64))");
                    db.prepare("INSERT INTO meta(schema_version,schema_fingerprint) VALUES(?,?)").run(next, expectedSchemaFingerprint());
                    db.exec("DROP TABLE meta_v0");
                    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?,?,?,?,?)").run(`migrate-v${version}-v${next}`, "migrate_schema", version, next, now, now, "committed", null);
                    version = next;
                }
                options.beforeFinalValidation?.();
                validateSchema(db);
                db.exec("COMMIT");
            }
            catch (error) {
                try {
                    db.exec("ROLLBACK");
                }
                catch { /* preserve the migration failure */ }
                if (isSqliteBusy(error))
                    throw new SafeError("BUSY", "SQLite writer busy");
                throw normalizeSafeError(error, "STATE", "schema migration failed");
            }
            secureOpenDatabaseFiles(dbPath);
            return new SqliteStateStore(root, db, registry);
        }
        catch (error) {
            db.close();
            if (isSqliteBusy(error))
                throw new SafeError("BUSY", "SQLite writer busy");
            throw normalizeSafeError(error, "STATE", "schema migration failed");
        }
    }
    objectStore() { this.assertAvailable(); return this.#objects; }
    close() {
        if (this.#active instanceof SnapshotBase)
            this.closeSnapshot(this.#active);
        else if (this.#active)
            this.rollback(this.#active);
        if (!this.#closed)
            this.#db.close();
        this.#closed = true;
    }
    assertAvailable() { if (this.#closed)
        throw new SafeError("STATE", "store is closed"); if (this.#active)
        throw new SafeError("STATE", "connection already has a transaction"); }
    assertSnapshot(snapshot) {
        if (this.#closed || !(snapshot instanceof SnapshotBase) || snapshotOwner(snapshot) !== this || STORE_ACTIVE_SNAPSHOTS.get(this) !== snapshot || !isExactActiveSnapshot(snapshot) || this.#active !== snapshot)
            throw new SafeError("STATE", "foreign snapshot");
        return snapshot;
    }
    assertWrite(snapshot, allowFinalized = false) {
        const checked = this.assertSnapshot(snapshot);
        if (!(checked instanceof WriteSnapshot))
            throw new SafeError("STATE", "write snapshot required");
        if (writeState(checked).finalized && !allowFinalized)
            throw new SafeError("STATE", "transaction already finalized");
        return checked;
    }
    openReadSnapshot() { this.assertAvailable(); try {
        this.#db.exec("BEGIN");
    }
    catch (error) {
        throw normalizeSafeError(error, "STATE", "read snapshot failed");
    } const snapshot = new ReadSnapshot(this, SNAPSHOT_ISSUANCE_TOKEN); this.#active = snapshot; STORE_ACTIVE_SNAPSHOTS.set(this, snapshot); return snapshot; }
    beginImmediate(intent) {
        this.assertAvailable();
        if (this.#readOnly)
            throw new SafeError("STATE", "read-only state store forbids writer transaction");
        const raw = intent;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
            throw new SafeError("INVALID_INPUT", "invalid mutation intent");
        const command = raw.command;
        let normalizedIntent;
        if (command === "repair_views") {
            const decoded = exactCommand(raw, ["command", "account"]);
            normalizedIntent = Object.freeze({ command: "repair_views", account: decodeAccountPartition(decoded.account) });
        }
        else {
            const decoded = exactCommand(raw, ["command", "scope"]);
            if (!['sync', 'retry', 'skip', 'ack'].includes(String(decoded.command)))
                throw new SafeError("INVALID_INPUT", "invalid mutation intent");
            normalizedIntent = Object.freeze({ command: decoded.command, scope: decodePartitionScope(decoded.scope) });
        }
        try {
            this.#db.exec("BEGIN IMMEDIATE");
        }
        catch (error) {
            if (isSqliteBusy(error))
                throw new SafeError("BUSY", "SQLite writer busy");
            throw normalizeSafeError(error, "STATE", "write transaction failed");
        }
        const snapshot = new WriteSnapshot(this, normalizedIntent, SNAPSHOT_ISSUANCE_TOKEN);
        this.#active = snapshot;
        STORE_ACTIVE_SNAPSHOTS.set(this, snapshot);
        return snapshot;
    }
    beginSchemaImmediate(command) {
        this.assertAvailable();
        if (this.#readOnly)
            throw new SafeError("STATE", "read-only state store forbids schema transaction");
        if (command !== "init_schema" && command !== "migrate_schema")
            throw new SafeError("INVALID_INPUT", "invalid schema transaction command");
        try {
            this.#db.exec("BEGIN IMMEDIATE");
        }
        catch (error) {
            if (isSqliteBusy(error))
                throw new SafeError("BUSY", "SQLite writer busy");
            throw normalizeSafeError(error, "STATE", "schema transaction failed");
        }
        const tx = new SchemaTransaction(this, command);
        this.#active = tx;
        return tx;
    }
    closeSnapshot(snapshot) { this.assertSnapshot(snapshot); try {
        this.#db.exec("ROLLBACK");
    }
    catch (error) {
        throw normalizeSafeError(error, "STATE", "snapshot close failed");
    } snapshot.invalidate(); this.#active = null; }
    safeJson(value) { assertPersistenceSafe(value, this.registry); return canonicalJson(value); }
    safeRun(sql, ...values) {
        for (const value of values) {
            if (typeof value === "string" && /^[\[{]/.test(value.trimStart()))
                assertSerializedPersistenceSafe(value, this.registry);
            else
                assertPersistenceSafe(value, this.registry);
        }
        this.#db.prepare(sql).run(...values);
    }
    beforeFinalize(step) {
        try {
            this.#beforeFinalizeStep?.(step);
        }
        catch (error) {
            throw normalizeSafeError(error, "STATE", "SQLite finalization failed");
        }
    }
    upsertAccount(tx, account) {
        const write = this.assertWrite(tx);
        const transaction = writeState(write);
        if (transaction.businessResultIssued)
            throw new SafeError("STATE", "business result already sealed transaction writes");
        const decoded = decodeAccount(account);
        const intended = transaction.intent.command === "repair_views" ? transaction.intent.account : accountPartition(transaction.intent.scope);
        if (!sameAccount(decoded, intended))
            throw new SafeError("INVALID_INPUT", "account mutation outside intent");
        const existing = this.loadAccount(tx, decoded.hostId, decoded.accountId);
        const merged = existing ? mergeAccount(existing, decoded) : decoded;
        const key = accountKey(merged);
        this.safeRun("INSERT INTO accounts(account_key,host_id,account_id,display_name,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET display_name=excluded.display_name,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at", key, merged.hostId, merged.accountId, merged.displayName, merged.firstSeenAt, merged.lastSeenAt);
        this.safeRun("INSERT OR IGNORE INTO account_generations(account_key,canonical_generation,views_dirty) VALUES(?,0,1)", key);
        return merged;
    }
    loadAccount(snapshot, hostId, accountId) {
        this.assertSnapshot(snapshot);
        const row = this.#db.prepare("SELECT * FROM accounts WHERE account_key=?").get(accountKey({ hostId, accountId }));
        if (!row)
            return null;
        const value = decodeAccount({ schemaVersion: 1, hostId: row.host_id, accountId: row.account_id, displayName: row.display_name, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at });
        if (accountKey(value) !== row.account_key)
            throw new SafeError("CANONICAL_INTEGRITY", "account key mismatch");
        return Object.freeze(value);
    }
    insertObject(ref, firstSeen) {
        decodeSha256(ref.sha256);
        this.safeRun("INSERT INTO objects(hash,byte_length,mime_type,first_seen_at) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING", ref.sha256, ref.byteLength, ref.mimeType, firstSeen);
        const row = this.#db.prepare("SELECT byte_length,mime_type FROM objects WHERE hash=?").get(ref.sha256);
        if (Number(row.byte_length) !== ref.byteLength || String(row.mime_type) !== ref.mimeType)
            throw new SafeError("CANONICAL_INTEGRITY", "object metadata conflict");
    }
    auditTaskFailureRelations(account, noteIds) {
        const unresolved = noteIds.flatMap((id) => this.#queryFailures(account, id));
        const failuresByTask = new Map();
        for (const failure of unresolved) {
            const key = `${scopeKey(failure.scope)}:${noteKey(account, failure.noteId)}`;
            const ids = failuresByTask.get(key) ?? [];
            ids.push(failure.failureId);
            failuresByTask.set(key, ids);
        }
        const seen = new Set();
        for (const task of noteIds.flatMap((id) => this.#queryTasks(account, id))) {
            const sKey = scopeKey(task.scope);
            const nKey = noteKey(account, task.noteId);
            const key = `${sKey}:${nKey}`;
            seen.add(key);
            const expected = [...(failuresByTask.get(key) ?? [])].sort();
            const recorded = [...task.failureIds].sort();
            if (canonicalJson(recorded) !== canonicalJson(expected))
                throw new SafeError("INVALID_INPUT", "task and unresolved failure relations disagree");
            if ((task.status === "partial" || task.status === "failed") !== (expected.length > 0) || (task.status === "done" || task.status === "skipped" || task.status === "pending" || task.status === "paused") && expected.length !== 0)
                throw new SafeError("INVALID_INPUT", "task status disagrees with failures");
        }
        for (const key of failuresByTask.keys())
            if (!seen.has(key))
                throw new SafeError("INVALID_INPUT", "unresolved failure has no task");
    }
    preflightCanonicalMutation(tx, command) {
        const current = this.#queryState(command.scope);
        const actualRevision = current?.revision ?? 0;
        if (actualRevision !== command.expectedStateRevision || command.nextState.revision !== actualRevision + 1)
            throw new SafeError("STATE", "state revision mismatch");
        const account = accountPartition(command.scope);
        if (!this.loadAccount(tx, account.hostId, account.accountId))
            throw new SafeError("STATE", "account must exist before mutation");
        const expectedIds = Object.keys(command.expectedManifestRevisions).sort(utf8Compare);
        const manifestIds = command.manifests.map((manifest) => manifest.noteId).sort(utf8Compare);
        if (new Set(manifestIds).size !== manifestIds.length || canonicalJson(expectedIds) !== canonicalJson(manifestIds))
            throw new SafeError("INVALID_INPUT", "manifest revisions must exactly cover mutations");
        const prospectiveManifests = new Map();
        for (const manifest of command.manifests) {
            if (!sameAccount(manifest, account) || manifest.noteId !== manifest.canonicalNote.noteId || manifest.canonicalNote.contentHash !== computeContentHash(manifest.canonicalNote) || manifest.indexEntrySha256 !== indexEntryDigest(manifest.canonicalNote) || manifest.csvRowSha256 !== noteCsvRowDigest(manifest.canonicalNote))
                throw new SafeError("INVALID_INPUT", "manifest account or content mismatch");
            const expected = command.expectedManifestRevisions[manifest.noteId];
            const prior = this.#queryManifest(account, manifest.noteId);
            if ((prior?.revision ?? null) !== expected || manifest.revision !== (expected ?? 0) + 1)
                throw new SafeError("STATE", "manifest revision mismatch");
            const projectedSlots = manifest.mediaSlots.filter((slot) => !slot.tombstone && slot.media !== null).map((slot) => slot.media).sort((a, b) => utf8Compare(a.kind, b.kind) || a.ordinal - b.ordinal);
            const noteMedia = [...manifest.canonicalNote.media].sort((a, b) => utf8Compare(a.kind, b.kind) || a.ordinal - b.ordinal);
            if (canonicalJson(projectedSlots) !== canonicalJson(noteMedia))
                throw new SafeError("INVALID_INPUT", "manifest media slots disagree with canonical note");
            prospectiveManifests.set(manifest.noteId, manifest);
        }
        const affected = [...new Set([...command.tasks.map((task) => task.noteId), ...command.failures.map((failure) => failure.noteId)])];
        const prospectiveFailures = new Map();
        for (const failure of affected.flatMap((id) => this.#queryFailures(account, id)))
            prospectiveFailures.set(failure.failureId, failure);
        if (new Set(command.failures.map((failure) => failure.failureId)).size !== command.failures.length)
            throw new SafeError("INVALID_INPUT", "duplicate failure input");
        for (const failure of command.failures) {
            if (!sameAccount(failure.scope, account) || failure.failureId !== computeFailureId(failure))
                throw new SafeError("INVALID_INPUT", "failure account or digest mismatch");
            const existingRow = this.#db.prepare("SELECT record_json FROM failures WHERE failure_id=?").get(failure.failureId);
            const existingFailure = existingRow ? decodeFailureRecord(parseJson(existingRow.record_json)) : null;
            if (existingFailure) {
                if (!sameScope(existingFailure.scope, failure.scope) || existingFailure.noteId !== failure.noteId || existingFailure.stage !== failure.stage || existingFailure.category !== failure.category || canonicalJson(existingFailure.mediaSlot) !== canonicalJson(failure.mediaSlot))
                    throw new SafeError("INVALID_INPUT", "failure key mutation blocked");
                if (failure.attemptCount < existingFailure.attemptCount || failure.stage === "media" && compareSourceRank(failure.sourceRank, existingFailure.sourceRank) < 0)
                    throw new SafeError("INVALID_INPUT", "failure rank or attempts regressed");
            }
            else if (failure.resolvedAt !== null)
                throw new SafeError("INVALID_INPUT", "cannot create an already-resolved failure");
            if (failure.resolvedAt !== null && failure.resolvedReason === "repaired" && failure.stage === "media") {
                const manifest = prospectiveManifests.get(failure.noteId) ?? this.#queryManifest(account, failure.noteId);
                const accepted = manifest?.mediaSlots.find((slot) => slot.slot.kind === failure.mediaSlot.kind && slot.slot.ordinal === failure.mediaSlot.ordinal);
                if (!accepted || !accepted.tombstone && accepted.media?.status !== "stored" || compareSourceRank(accepted.sourceRank, failure.sourceRank) < 0)
                    throw new SafeError("INVALID_INPUT", "media failure resolution lacks accepted source rank");
            }
            if (failure.resolvedAt === null)
                prospectiveFailures.set(failure.failureId, failure);
            else
                prospectiveFailures.delete(failure.failureId);
        }
        const prospectiveTasks = new Map();
        const relationKey = (scope, noteId) => `${scopeKey(scope)}:${noteKey(account, noteId)}`;
        for (const task of affected.flatMap((id) => this.#queryTasks(account, id)))
            prospectiveTasks.set(relationKey(task.scope, task.noteId), task);
        if (new Set(command.tasks.map((task) => relationKey(task.scope, task.noteId))).size !== command.tasks.length)
            throw new SafeError("INVALID_INPUT", "duplicate task input");
        for (const task of command.tasks) {
            if (!sameAccount(task.scope, account))
                throw new SafeError("INVALID_INPUT", "task account mismatch");
            assertTaskInvariant(task);
            prospectiveTasks.set(relationKey(task.scope, task.noteId), task);
        }
        const failuresByTask = new Map();
        for (const failure of prospectiveFailures.values()) {
            const key = relationKey(failure.scope, failure.noteId);
            const ids = failuresByTask.get(key) ?? [];
            ids.push(failure.failureId);
            failuresByTask.set(key, ids);
        }
        for (const [key, task] of prospectiveTasks) {
            const expected = [...(failuresByTask.get(key) ?? [])].sort(utf8Compare);
            const recorded = [...task.failureIds].sort(utf8Compare);
            if (canonicalJson(expected) !== canonicalJson(recorded))
                throw new SafeError("INVALID_INPUT", "task and unresolved failure relations disagree");
            if ((task.status === "partial" || task.status === "failed") !== (expected.length > 0) || (task.status === "done" || task.status === "skipped" || task.status === "pending" || task.status === "paused") && expected.length !== 0)
                throw new SafeError("INVALID_INPUT", "task status disagrees with failures");
            failuresByTask.delete(key);
        }
        if (failuresByTask.size !== 0)
            throw new SafeError("INVALID_INPUT", "unresolved failure has no task");
        return account;
    }
    prepareCanonicalWritePlan(snapshot, mutation) {
        const tx = this.assertWrite(snapshot);
        const transaction = writeState(tx);
        if (transaction.mutationWritten || transaction.businessResultIssued)
            throw new SafeError("STATE", "canonical transaction is already sealed");
        const command = decodeCanonicalMutation(mutation);
        if (transaction.intent.command === "repair_views" || !sameScope(transaction.intent.scope, command.scope))
            throw new SafeError("INVALID_INPUT", "mutation intent mismatch");
        assertPersistenceSafe(command, this.registry);
        const rawManifests = mutation.manifests;
        const candidateIds = command.candidates.map((candidate) => candidate.note.noteId);
        const manifestIds = command.manifests.map((manifest) => manifest.noteId);
        if (new Set(candidateIds).size !== candidateIds.length || canonicalJson([...candidateIds].sort(utf8Compare)) !== canonicalJson([...manifestIds].sort(utf8Compare)))
            throw new SafeError("INVALID_INPUT", "merge candidates must exactly cover final manifests");
        for (let index = 0; index < command.manifests.length; index += 1) {
            const manifest = command.manifests[index];
            const rawManifest = rawManifests[index];
            const candidate = command.candidates.find((item) => item.note.noteId === manifest.noteId);
            const prior = this.#queryManifest(accountPartition(command.scope), manifest.noteId);
            const merged = mergeCanonicalNote(prior, candidate);
            if (canonicalJson(merged.note) !== canonicalJson(manifest.canonicalNote) || canonicalJson(merged.mediaSlots) !== canonicalJson(manifest.mediaSlots) || canonicalJson(merged.membershipNameObservations) !== canonicalJson(manifest.membershipNameObservations) || canonicalJson(merged.sourceRank) !== canonicalJson(manifest.semanticSourceRank))
                throw new SafeError("INVALID_INPUT", "manifest is not a canonical merge result");
            const refs = [manifest.artifacts.json, manifest.artifacts.markdown, ...manifest.mediaSlots.flatMap((slot) => slot.media?.object ? [slot.media.object] : [])];
            const rawRefs = [rawManifest.artifacts.json, rawManifest.artifacts.markdown, ...rawManifest.mediaSlots.flatMap((slot) => slot.media?.object ? [slot.media.object] : [])];
            for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
                const ref = refs[refIndex];
                const known = this.#db.prepare("SELECT 1 AS present FROM objects WHERE hash=?").get(ref.sha256) !== undefined;
                if (!known && !this.#objects.owns(rawRefs[refIndex]))
                    throw new SafeError("SECURITY_BOUNDARY", "object reference was not issued by the state object store");
            }
            const jsonBytes = renderNoteJsonBytes(manifest.canonicalNote, this.registry);
            const markdownBytes = renderNoteMarkdownBytes(manifest.canonicalNote, this.registry);
            if (sha256Bytes(jsonBytes) !== manifest.artifacts.json.sha256 || jsonBytes.byteLength !== manifest.artifacts.json.byteLength || sha256Bytes(markdownBytes) !== manifest.artifacts.markdown.sha256 || markdownBytes.byteLength !== manifest.artifacts.markdown.byteLength)
                throw new SafeError("CANONICAL_INTEGRITY", "note artifacts do not match canonical note");
            for (const slot of manifest.mediaSlots)
                if (slot.media?.status === "stored" && slot.media.object && slot.media.extension !== objectExtension(slot.media.object))
                    throw new SafeError("CANONICAL_INTEGRITY", "media extension does not match canonical MIME");
        }
        const account = this.preflightCanonicalMutation(tx, command);
        const expectedFailures = new Map(command.failures.map((failure) => [failure.failureId, failure]));
        const covered = new Set();
        const rawOccurrences = mutation.failureOccurrences;
        for (let index = 0; index < command.failureOccurrences.length; index += 1) {
            const occurrence = command.failureOccurrences[index].failure;
            const expected = expectedFailures.get(occurrence.failureId);
            if (!expected || covered.has(occurrence.failureId) || occurrence.resolvedAt !== null)
                throw new SafeError("INVALID_INPUT", "invalid failure occurrence coverage");
            const existingRow = this.#db.prepare("SELECT record_json FROM failures WHERE failure_id=?").get(occurrence.failureId);
            const existing = existingRow ? decodeFailureRecord(parseJson(existingRow.record_json)) : null;
            if (occurrence.stage === "media") {
                const candidate = command.candidates.find((item) => item.note.noteId === occurrence.noteId);
                const rawRank = rawOccurrences[index].failure.sourceRank;
                if (!candidate || rawRank !== candidate.sourceRank)
                    throw new SafeError("INVALID_INPUT", "media occurrence rank is not bound to its note candidate");
                assertValidatedRankForNote(rawRank, candidate.note);
            }
            if (canonicalJson(mergeFailure(existing, occurrence)) !== canonicalJson(expected))
                throw new SafeError("INVALID_INPUT", "failure occurrence does not produce expected canonical failure");
            covered.add(occurrence.failureId);
        }
        for (const resolution of command.failureResolutions) {
            const expected = expectedFailures.get(resolution.failureId);
            const existing = this.#db.prepare("SELECT record_json FROM failures WHERE failure_id=?").get(resolution.failureId);
            if (!expected || covered.has(resolution.failureId) || !existing || resolution.resolvedAt === null || canonicalJson(expected) !== canonicalJson(resolution))
                throw new SafeError("INVALID_INPUT", "invalid failure resolution coverage");
            covered.add(resolution.failureId);
        }
        if (covered.size !== expectedFailures.size)
            throw new SafeError("INVALID_INPUT", "expected failures are not exactly explained by occurrences and resolutions");
        const plan = Object.freeze({ planBrand: Symbol("canonical-write-plan") });
        WRITE_PLANS.set(plan, Object.freeze({ transaction: tx, command, account }));
        return plan;
    }
    putCanonicalMutation(snapshot, plan) {
        const tx = this.assertWrite(snapshot);
        const transaction = writeState(tx);
        if (transaction.mutationWritten || transaction.businessResultIssued)
            throw new SafeError("STATE", "canonical transaction is already sealed");
        const provenance = plan !== null && typeof plan === "object" ? WRITE_PLANS.get(plan) : undefined;
        if (!provenance || provenance.transaction !== tx)
            throw new SafeError("STATE", "untrusted or foreign canonical write plan");
        const { command, account } = provenance;
        const table = command.scope.target === "collected_album" ? "album_states" : "sync_states";
        const stateJson = this.safeJson(command.nextState);
        const values = [scopeKey(command.scope), accountKey(account), command.scope.hostId, command.scope.accountId, command.scope.target, command.scope.boardId, ...(table === "album_states" ? [command.nextState.boardName] : []), this.safeJson(command.nextState.progress), command.nextState.stopReason, command.nextState.lastAttemptAt, command.nextState.lastSuccessfulAt, command.nextState.nextAllowedAt, command.nextState.revision, stateJson];
        const placeholders = table === "album_states" ? "?,?,?,?,?,?,?,?,?,?,?,?,?,?" : "?,?,?,?,?,?,?,?,?,?,?,?,?";
        const columns = table === "album_states" ? "scope_key,account_key,host_id,account_id,target,board_id,board_name,progress_json,stop_reason,last_attempt_at,last_successful_at,next_allowed_at,revision,record_json" : "scope_key,account_key,host_id,account_id,target,board_id,progress_json,stop_reason,last_attempt_at,last_successful_at,next_allowed_at,revision,record_json";
        this.safeRun(`INSERT OR REPLACE INTO ${table}(${columns}) VALUES(${placeholders})`, ...values);
        for (const manifest of command.manifests) {
            if (!sameAccount(manifest, account) || manifest.noteId !== manifest.canonicalNote.noteId || manifest.canonicalNote.contentHash !== computeContentHash(manifest.canonicalNote) || manifest.indexEntrySha256 !== indexEntryDigest(manifest.canonicalNote) || manifest.csvRowSha256 !== noteCsvRowDigest(manifest.canonicalNote))
                throw new SafeError("INVALID_INPUT", "manifest account or content mismatch");
            const expected = command.expectedManifestRevisions[manifest.noteId];
            if (expected === undefined)
                throw new SafeError("INVALID_INPUT", "missing expected manifest revision");
            const prior = this.#queryManifest(account, manifest.noteId);
            if ((prior?.revision ?? null) !== expected || manifest.revision !== (expected ?? 0) + 1)
                throw new SafeError("STATE", "manifest revision mismatch");
            const projectedSlots = manifest.mediaSlots.filter((slot) => !slot.tombstone && slot.media !== null).map((slot) => slot.media).sort((a, b) => a.kind.localeCompare(b.kind) || a.ordinal - b.ordinal);
            const noteMedia = [...manifest.canonicalNote.media].sort((a, b) => a.kind.localeCompare(b.kind) || a.ordinal - b.ordinal);
            if (canonicalJson(projectedSlots) !== canonicalJson(noteMedia))
                throw new SafeError("INVALID_INPUT", "manifest media slots disagree with canonical note");
            this.insertObject(manifest.artifacts.json, manifest.canonicalNote.capturedAt);
            this.insertObject(manifest.artifacts.markdown, manifest.canonicalNote.capturedAt);
            for (const slot of manifest.mediaSlots)
                if (slot.media?.object)
                    this.insertObject(slot.media.object, manifest.canonicalNote.capturedAt);
            const key = noteKey(account, manifest.noteId);
            this.safeRun("INSERT OR REPLACE INTO note_manifests(note_key,account_key,host_id,account_id,note_id,canonical_note_json,semantic_rank_json,content_hash,json_object_hash,markdown_object_hash,entry_hash,csv_hash,revision,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", key, accountKey(account), account.hostId, account.accountId, manifest.noteId, this.safeJson(manifest.canonicalNote), this.safeJson(manifest.semanticSourceRank), manifest.canonicalNote.contentHash, manifest.artifacts.json.sha256, manifest.artifacts.markdown.sha256, manifest.indexEntrySha256, manifest.csvRowSha256, manifest.revision, this.safeJson(manifest));
            this.safeRun("DELETE FROM media_slots WHERE note_key=?", key);
            for (const slot of manifest.mediaSlots)
                this.safeRun("INSERT INTO media_slots(note_key,kind,ordinal,source_rank_json,status,object_hash,extension,tombstone,record_json) VALUES(?,?,?,?,?,?,?,?,?)", key, slot.slot.kind, slot.slot.ordinal, this.safeJson(slot.sourceRank), slot.media?.status ?? null, slot.media?.object?.sha256 ?? null, slot.media?.extension ?? null, slot.tombstone ? 1 : 0, this.safeJson(slot));
        }
        for (const failure of command.failures) {
            if (!sameAccount(failure.scope, account))
                throw new SafeError("INVALID_INPUT", "failure account mismatch");
            if (failure.failureId !== computeFailureId(failure))
                throw new SafeError("INVALID_INPUT", "failure digest mismatch");
            if (failure.stage === "media" && (!failure.mediaSlot || !failure.sourceRank))
                throw new SafeError("INVALID_INPUT", "media failure requires rank");
            if (failure.stage !== "media" && (failure.mediaSlot || failure.sourceRank))
                throw new SafeError("INVALID_INPUT", "non-media failure forbids rank");
            const key = noteKey(account, failure.noteId);
            const existingRow = this.#db.prepare("SELECT record_json FROM failures WHERE failure_id=?").get(failure.failureId);
            const existingFailure = existingRow ? decodeFailureRecord(parseJson(existingRow.record_json)) : null;
            if (existingFailure) {
                if (!sameScope(existingFailure.scope, failure.scope) || existingFailure.noteId !== failure.noteId || existingFailure.stage !== failure.stage || existingFailure.category !== failure.category || canonicalJson(existingFailure.mediaSlot) !== canonicalJson(failure.mediaSlot))
                    throw new SafeError("INVALID_INPUT", "failure key mutation blocked");
                if (failure.attemptCount < existingFailure.attemptCount || (failure.stage === "media" && compareSourceRank(failure.sourceRank, existingFailure.sourceRank) < 0))
                    throw new SafeError("INVALID_INPUT", "failure rank or attempts regressed");
            }
            else if (failure.resolvedAt !== null)
                throw new SafeError("INVALID_INPUT", "cannot create an already-resolved failure");
            if (failure.resolvedAt !== null && failure.resolvedReason === "repaired" && failure.stage === "media") {
                const manifest = this.#queryManifest(account, failure.noteId);
                const accepted = manifest?.mediaSlots.find((slot) => slot.slot.kind === failure.mediaSlot.kind && slot.slot.ordinal === failure.mediaSlot.ordinal);
                if (!accepted || (!accepted.tombstone && accepted.media?.status !== "stored") || compareSourceRank(accepted.sourceRank, failure.sourceRank) < 0)
                    throw new SafeError("INVALID_INPUT", "media failure resolution lacks accepted source rank");
            }
            this.safeRun("INSERT INTO failures(failure_id,account_key,scope_key,note_key,media_kind,media_ordinal,source_rank_json,category,stage,safe_message,retryable,attempts,first_occurred_at,last_occurred_at,retry_at,resolved_at,resolved_reason,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(failure_id) DO UPDATE SET account_key=excluded.account_key,scope_key=excluded.scope_key,note_key=excluded.note_key,media_kind=excluded.media_kind,media_ordinal=excluded.media_ordinal,source_rank_json=excluded.source_rank_json,category=excluded.category,stage=excluded.stage,safe_message=excluded.safe_message,retryable=excluded.retryable,attempts=excluded.attempts,first_occurred_at=excluded.first_occurred_at,last_occurred_at=excluded.last_occurred_at,retry_at=excluded.retry_at,resolved_at=excluded.resolved_at,resolved_reason=excluded.resolved_reason,record_json=excluded.record_json", failure.failureId, accountKey(account), scopeKey(failure.scope), key, failure.mediaSlot?.kind ?? null, failure.mediaSlot?.ordinal ?? null, failure.sourceRank ? this.safeJson(failure.sourceRank) : null, failure.category, failure.stage, failure.safeMessage, failure.retryable ? 1 : 0, failure.attemptCount, failure.firstOccurredAt, failure.lastOccurredAt, failure.retryAt, failure.resolvedAt, failure.resolvedReason, this.safeJson(failure));
        }
        for (const task of command.tasks) {
            if (!sameAccount(task.scope, account))
                throw new SafeError("INVALID_INPUT", "task account mismatch");
            assertTaskInvariant(task);
            const nKey = noteKey(account, task.noteId);
            this.safeRun("INSERT OR REPLACE INTO target_tasks(scope_key,account_key,note_key,status,attempt_count,skip_reason,skipped_at,first_seen_at,updated_at,record_json) VALUES(?,?,?,?,?,?,?,?,?,?)", scopeKey(task.scope), accountKey(account), nKey, task.status, task.attemptCount, task.skipReason, task.skippedAt, task.firstSeenAt, task.updatedAt, this.safeJson(task));
            this.safeRun("DELETE FROM task_failures WHERE scope_key=? AND note_key=?", scopeKey(task.scope), nKey);
            for (const failureId of task.failureIds) {
                const failureRow = this.#db.prepare("SELECT record_json FROM failures WHERE failure_id=?").get(failureId);
                if (!failureRow)
                    throw new SafeError("INVALID_INPUT", "task references missing failure");
                const failure = decodeFailureRecord(parseJson(failureRow.record_json));
                if (!sameScope(failure.scope, task.scope) || failure.noteId !== task.noteId || failure.resolvedAt !== null)
                    throw new SafeError("INVALID_INPUT", "task failure relation mismatch");
                this.safeRun("INSERT INTO task_failures(scope_key,note_key,failure_id) VALUES(?,?,?)", scopeKey(task.scope), nKey, failureId);
            }
        }
        for (const failure of command.failures) {
            if (failure.resolvedAt === null)
                continue;
            const dangling = this.#db.prepare("SELECT count(*) AS n FROM task_failures WHERE failure_id=?").get(failure.failureId);
            if (Number(dangling.n) !== 0)
                throw new SafeError("INVALID_INPUT", "resolved failure still linked to a task");
        }
        this.auditTaskFailureRelations(account, [...new Set([...command.tasks.map((task) => task.noteId), ...command.failures.map((failure) => failure.noteId)])]);
        transaction.mutationWritten = true;
        const primaryTasks = command.tasks.filter((task) => sameScope(task.scope, command.scope));
        transaction.primaryNoteIds = Object.freeze(primaryTasks.map((task) => task.noteId).sort(utf8Compare));
        transaction.summary = Object.freeze({ listed: primaryTasks.length, done: primaryTasks.filter((task) => task.status === "done").length, partial: primaryTasks.filter((task) => task.status === "partial").length, failed: primaryTasks.filter((task) => task.status === "failed").length, skipped: primaryTasks.filter((task) => task.status === "skipped").length, mutationApplied: true });
    }
    prepareBusinessResult(snapshot, input) {
        const tx = this.assertWrite(snapshot);
        const state = writeState(tx);
        if (state.businessResultIssued)
            throw new SafeError("STATE", "business result already issued");
        const r = exactCommand(input, ["runId", "outcome", "startedAt", "finishedAt", "safeErrorCategory", "listed", "done", "partial", "failed", "skipped", "primaryNoteIds"]);
        if (!Array.isArray(r.primaryNoteIds))
            throw new SafeError("INVALID_INPUT", "primary note ids must be an array");
        const primaryNoteIds = r.primaryNoteIds.map(decodeNoteId).sort(utf8Compare);
        if (new Set(primaryNoteIds).size !== primaryNoteIds.length)
            throw new SafeError("INVALID_INPUT", "duplicate primary note id");
        if (!["committed", "not_due", "paused", "blocked", "failed"].includes(String(r.outcome)))
            throw new SafeError("INVALID_INPUT", "invalid business outcome");
        const intendedAccount = state.intent.command === "repair_views" ? state.intent.account : accountPartition(state.intent.scope);
        const { primaryNoteIds: _primaryNoteIds, ...runFields } = r;
        const decoded = decodeRunRecord({ ...runFields, command: state.intent.command, account: intendedAccount, scope: state.intent.command === "repair_views" ? null : state.intent.scope });
        if (decoded.outcome === "committed_with_warnings")
            throw new SafeError("INVALID_INPUT", "business result cannot pre-issue a projection warning");
        if (state.intent.command === "repair_views" && decoded.outcome !== "committed")
            throw new SafeError("INVALID_INPUT", "repair_views business result must be committed");
        const counters = { listed: decoded.listed, done: decoded.done, partial: decoded.partial, failed: decoded.failed, skipped: decoded.skipped };
        if (state.summary === null) {
            if (decoded.outcome !== "committed" && decoded.outcome !== "not_due" && decoded.outcome !== "paused" || Object.values(counters).some((count) => count !== 0))
                throw new SafeError("STATE", "zero-mutation business result must be a safe zero-count outcome");
            state.summary = Object.freeze({ ...counters, mutationApplied: false });
            state.primaryNoteIds = Object.freeze([]);
        }
        else if (canonicalJson(counters) !== canonicalJson({ listed: state.summary.listed, done: state.summary.done, partial: state.summary.partial, failed: state.summary.failed, skipped: state.summary.skipped }))
            throw new SafeError("STATE", "business result counters disagree with transaction summary");
        if (state.primaryNoteIds === null || canonicalJson(primaryNoteIds) !== canonicalJson(state.primaryNoteIds))
            throw new SafeError("STATE", "primary note ids disagree with current-scope mutation");
        if ((decoded.outcome === "committed" || decoded.outcome === "not_due") && decoded.safeErrorCategory !== null)
            throw new SafeError("INVALID_INPUT", "successful business result forbids error category");
        if (decoded.outcome === "paused" && decoded.safeErrorCategory !== "PAUSED" || (decoded.outcome === "blocked" || decoded.outcome === "failed") && decoded.safeErrorCategory === null)
            throw new SafeError("INVALID_INPUT", "business result error category mismatch");
        let outcome = decoded.outcome;
        let safeErrorCategory = decoded.safeErrorCategory;
        if (outcome === "committed" && state.summary.partial > 0 && state.intent.command !== "repair_views") {
            const primary = new Set(primaryNoteIds);
            const scope = state.intent.scope;
            const failures = this.#queryFailures(intendedAccount).filter((failure) => sameScope(failure.scope, scope) && primary.has(failure.noteId));
            if (failures.length === 0 || failures.some((failure) => failure.category !== "MEDIA"))
                throw new SafeError("STATE", "partial business result has a higher-priority blocker");
            outcome = "committed_with_warnings";
            safeErrorCategory = "MEDIA";
        }
        const result = Object.freeze({ runId: decoded.runId, outcome, startedAt: decoded.startedAt, finishedAt: decoded.finishedAt, safeErrorCategory, ...counters });
        state.businessResultIssued = true;
        BUSINESS_RESULTS.set(result, Object.freeze({ transaction: tx, result, summary: state.summary }));
        return result;
    }
    finalizeAccount(snapshot, batch) {
        const tx = this.assertWrite(snapshot);
        const transaction = writeState(tx);
        if (transaction.finalized)
            throw new SafeError("STATE", "duplicate finalization");
        const provenance = projectionBatchProvenance(batch, tx);
        if (transaction.summary === null || canonicalJson(transaction.summary) !== canonicalJson(provenance.summary))
            throw new SafeError("STATE", "projection batch mutation summary mismatch");
        const intendedAccount = transaction.intent.command === "repair_views" ? transaction.intent.account : accountPartition(transaction.intent.scope);
        const key = accountKey(intendedAccount);
        if (key !== provenance.accountKey)
            throw new SafeError("INVALID_INPUT", "finalization account mismatch");
        const generation = this.#queryGeneration(intendedAccount);
        if (provenance.generation !== generation + 1)
            throw new SafeError("STATE", "planned generation mismatch");
        if (batch.outcomes.length !== 5)
            throw new SafeError("INVALID_INPUT", "five projector outcomes required");
        let dirty = false;
        for (let index = 0; index < PROJECTOR_ORDER.length; index += 1) {
            const expected = PROJECTOR_ORDER[index];
            const outcome = batch.outcomes[index];
            assertTrustedProjectionOutcome(outcome, { projectorId: expected, accountKey: key, generation: provenance.generation });
            if (outcome.complete ? outcome.safeError !== null || !Array.isArray(outcome.receipts) : typeof outcome.safeError !== "string" || outcome.safeError.length === 0)
                throw new SafeError("INVALID_INPUT", "invalid projector outcome shape");
            const receipts = outcome.receipts ?? [];
            const receiptPaths = new Set();
            for (const receipt of receipts) {
                if (receipt.projectorId !== expected || receipt.accountKey !== key || receipt.generation !== provenance.generation || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 0)
                    throw new SafeError("INVALID_INPUT", "projector receipt mismatch");
                decodeSha256(receipt.sha256);
                decodeRelativePath(receipt.relativePath);
                if (receiptPaths.has(receipt.relativePath))
                    throw new SafeError("INVALID_INPUT", "duplicate projector receipt path");
                receiptPaths.add(receipt.relativePath);
            }
            if (!outcome.complete)
                dirty = true;
            assertProjectionMaterialized(outcome, this.root);
        }
        const run = decodeRunRecord(batch.finalRun);
        if (!sameAccount(run.account, intendedAccount))
            throw new SafeError("INVALID_INPUT", "run account mismatch");
        if (transaction.intent.command === "repair_views") {
            if (run.command !== "repair_views" || run.scope !== null)
                throw new SafeError("INVALID_INPUT", "repair run mismatch");
        }
        else if (run.command === "repair_views" || run.scope === null || !sameScope(run.scope, transaction.intent.scope))
            throw new SafeError("INVALID_INPUT", "business run mismatch");
        this.beforeFinalize("run");
        this.safeRun("INSERT INTO runs(run_id,account_key,scope_key,command,outcome,started_at,finished_at,safe_error_category,listed,done,partial,failed,skipped,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", run.runId, key, run.scope ? scopeKey(run.scope) : null, run.command, run.outcome, run.startedAt, run.finishedAt, run.safeErrorCategory, run.listed, run.done, run.partial, run.failed, run.skipped, this.safeJson(run));
        for (const outcome of batch.outcomes) {
            this.beforeFinalize(`view:${outcome.projectorId}`);
            this.safeRun("INSERT OR REPLACE INTO view_generations(account_key,projector_id,generation,complete,receipts_json,safe_error) VALUES(?,?,?,?,?,?)", key, outcome.projectorId, provenance.generation, outcome.complete ? 1 : 0, this.safeJson(outcome.receipts ?? []), outcome.safeError);
        }
        this.beforeFinalize("generation");
        this.safeRun("UPDATE account_generations SET canonical_generation=?,views_dirty=? WHERE account_key=?", provenance.generation, dirty ? 1 : 0, key);
        transaction.finalized = true;
    }
    putSchemaMigration(transaction, record) {
        if (!(transaction instanceof SchemaTransaction) || transaction.store !== this || this.#active !== transaction || !transaction.active)
            throw new SafeError("STATE", "foreign schema transaction");
        const raw = exactCommand(record, ["migrationId", "command", "fromVersion", "toVersion", "startedAt", "finishedAt", "outcome", "safeErrorCategory"]);
        if (raw.command !== transaction.command || raw.outcome !== "committed" || raw.safeErrorCategory !== null || !Number.isSafeInteger(raw.toVersion) || Number(raw.toVersion) < 1)
            throw new SafeError("INVALID_INPUT", "invalid schema migration record");
        const startedAt = decodeIsoDateTime(raw.startedAt);
        const finishedAt = decodeIsoDateTime(raw.finishedAt);
        if (startedAt > finishedAt)
            throw new SafeError("INVALID_INPUT", "invalid schema migration time range");
        const rows = asRows(this.#db.prepare("SELECT command,from_version,to_version FROM schema_migrations ORDER BY to_version,migration_id").all());
        if (raw.command === "init_schema") {
            if (raw.fromVersion !== null || raw.toVersion !== 1 || raw.migrationId !== "init-v1" || rows.length !== 0)
                throw new SafeError("INVALID_INPUT", "invalid schema initialization record");
        }
        else {
            if (!Number.isSafeInteger(raw.fromVersion) || Number(raw.fromVersion) < 0 || raw.toVersion !== Number(raw.fromVersion) + 1 || raw.migrationId !== `migrate-v${raw.fromVersion}-v${raw.toVersion}`)
                throw new SafeError("INVALID_INPUT", "invalid sequential schema migration record");
            const prior = rows.at(-1);
            if (prior ? Number(prior.to_version) !== raw.fromVersion : raw.fromVersion !== 0)
                throw new SafeError("STATE", "schema migration history gap");
        }
        const meta = this.#db.prepare("SELECT schema_version FROM meta").get();
        if (!meta || Number(meta.schema_version) !== raw.toVersion)
            throw new SafeError("STATE", "schema migration version mismatch");
        assertPersistenceSafe(record, this.registry);
        this.safeRun("INSERT INTO schema_migrations(migration_id,command,from_version,to_version,started_at,finished_at,outcome,safe_error_category) VALUES(?,?,?,?,?,?,?,?)", raw.migrationId, raw.command, raw.fromVersion, raw.toVersion, startedAt, finishedAt, "committed", null);
    }
    /** Commit collected facts independently from rebuildable exports. */
    commitCanonical(snapshot, run) {
        const tx = this.assertWrite(snapshot);
        const state = writeState(tx);
        const account = state.intent.command === "repair_views" ? state.intent.account : accountPartition(state.intent.scope);
        if (!this.loadAccount(tx, account.hostId, account.accountId))
            throw new SafeError("STATE", "account must exist before commit");
        if (run) {
            const decoded = decodeRunRecord(run);
            if (!sameAccount(decoded.account, account))
                throw new SafeError("INVALID_INPUT", "run account mismatch");
            this.#writeRun(decoded);
        }
        const generation = this.#queryGeneration(account) + 1;
        this.safeRun("UPDATE account_generations SET canonical_generation=?,views_dirty=1 WHERE account_key=?", generation, accountKey(account));
        state.finalized = true;
        this.commit(tx);
        return generation;
    }
    #writeRun(run) {
        this.safeRun("INSERT OR REPLACE INTO runs(run_id,account_key,scope_key,command,outcome,started_at,finished_at,safe_error_category,listed,done,partial,failed,skipped,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", run.runId, accountKey(run.account), run.scope ? scopeKey(run.scope) : null, run.command, run.outcome, run.startedAt, run.finishedAt, run.safeErrorCategory, run.listed, run.done, run.partial, run.failed, run.skipped, this.safeJson(run));
    }
    recordRun(input) {
        this.assertAvailable();
        const run = decodeRunRecord(input);
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            this.#writeRun(run);
            this.safeRun("UPDATE account_generations SET canonical_generation=canonical_generation+1,views_dirty=1 WHERE account_key=?", accountKey(run.account));
            this.#db.exec("COMMIT");
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    markProjectionPending(account) {
        this.assertAvailable();
        this.safeRun("UPDATE account_generations SET views_dirty=1 WHERE account_key=?", accountKey(decodeAccountPartition(account)));
    }
    recordProjection(account, generation, outcomes) {
        this.assertAvailable();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const key = accountKey(account);
            const current = this.#queryGeneration(account);
            if (current !== generation) {
                this.safeRun("UPDATE account_generations SET views_dirty=1 WHERE account_key=?", key);
                this.#db.exec("COMMIT");
                return false;
            }
            if (outcomes.length !== PROJECTOR_ORDER.length || outcomes.some((outcome, index) => outcome.projectorId !== PROJECTOR_ORDER[index] || outcome.accountKey !== key || outcome.generation !== generation))
                throw new SafeError("STATE", "projection result mismatch");
            for (const outcome of outcomes)
                this.safeRun("INSERT OR REPLACE INTO view_generations(account_key,projector_id,generation,complete,receipts_json,safe_error) VALUES(?,?,?,?,?,?)", key, outcome.projectorId, generation, outcome.complete ? 1 : 0, this.safeJson(outcome.receipts ?? []), outcome.safeError);
            this.safeRun("UPDATE account_generations SET views_dirty=? WHERE account_key=?", outcomes.some((outcome) => !outcome.complete) ? 1 : 0, key);
            this.#db.exec("COMMIT");
            return true;
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    commit(transaction) {
        if (transaction instanceof WriteSnapshot) {
            const tx = this.assertWrite(transaction, true);
            if (!writeState(tx).finalized)
                throw new SafeError("STATE", "write transaction must finalize exactly once");
            try {
                this.#beforeCommit?.();
                this.#db.exec("COMMIT");
            }
            catch (error) {
                throw normalizeSafeError(error, "STATE", "SQLite commit failed");
            }
            tx.invalidate();
            this.#active = null;
            return;
        }
        if (!(transaction instanceof SchemaTransaction) || transaction.store !== this || this.#active !== transaction || !transaction.active)
            throw new SafeError("STATE", "foreign schema transaction");
        try {
            this.#db.exec("COMMIT");
        }
        catch (error) {
            throw normalizeSafeError(error, "STATE", "schema commit failed");
        }
        transaction.active = false;
        this.#active = null;
    }
    rollback(transaction) {
        if (transaction instanceof WriteSnapshot) {
            if (this.#active !== transaction)
                throw new SafeError("STATE", "foreign transaction");
            try {
                this.#db.exec("ROLLBACK");
            }
            catch (error) {
                throw normalizeSafeError(error, "STATE", "SQLite rollback failed");
            }
            transaction.invalidate();
            this.#active = null;
            return;
        }
        if (!(transaction instanceof SchemaTransaction) || transaction.store !== this || this.#active !== transaction || !transaction.active)
            throw new SafeError("STATE", "foreign schema transaction");
        try {
            this.#db.exec("ROLLBACK");
        }
        catch (error) {
            throw normalizeSafeError(error, "STATE", "schema rollback failed");
        }
        transaction.active = false;
        this.#active = null;
    }
    #queryAccounts() {
        return asRows(this.#db.prepare("SELECT a.host_id,a.account_id,g.account_key,g.canonical_generation,g.views_dirty FROM account_generations g JOIN accounts a USING(account_key) ORDER BY g.account_key").all()).map((row) => {
            const account = { hostId: decodeHostId(row.host_id), accountId: decodeAccountId(row.account_id) };
            const key = decodeSha256(row.account_key);
            if (accountKey(account) !== key || !Number.isSafeInteger(Number(row.canonical_generation)) || ![0, 1].includes(Number(row.views_dirty)))
                throw new SafeError("CANONICAL_INTEGRITY", "invalid account generation row");
            return { account, accountKey: key, canonicalGeneration: Number(row.canonical_generation), viewsDirty: Number(row.views_dirty) === 1 };
        });
    }
    #queryViews(key) {
        decodeSha256(key);
        const rows = new Map(asRows(this.#db.prepare("SELECT * FROM view_generations WHERE account_key=?").all(key)).map((row) => [String(row.projector_id), row]));
        if ([...rows.keys()].some((id) => !PROJECTOR_ORDER.includes(id)))
            throw new SafeError("CANONICAL_INTEGRITY", "unknown view projector row");
        return PROJECTOR_ORDER.map((id) => {
            const row = rows.get(id);
            if (!row)
                return { accountKey: key, projectorId: id, generation: 0, complete: false, receipts: [], safeError: "view not projected" };
            const generation = Number(row.generation);
            const completeRaw = Number(row.complete);
            const safeError = row.safe_error === null ? null : String(row.safe_error);
            const receiptsRaw = parseJson(row.receipts_json);
            if (!Array.isArray(receiptsRaw) || row.account_key !== key || row.projector_id !== id || !Number.isSafeInteger(generation) || generation < 0 || ![0, 1].includes(completeRaw) || (completeRaw === 1 ? safeError !== null : safeError === null || safeError.length === 0))
                throw new SafeError("CANONICAL_INTEGRITY", "invalid view generation row");
            const receipts = receiptsRaw.map(decodeViewReceipt);
            const paths = receipts.map((receipt) => receipt.relativePath);
            for (const receipt of receipts)
                if (receipt.accountKey !== key || receipt.projectorId !== id || receipt.generation !== generation)
                    throw new SafeError("CANONICAL_INTEGRITY", "view receipt row mismatch");
            if (new Set(paths).size !== paths.length || canonicalJson(paths) !== canonicalJson([...paths].sort(utf8Compare)))
                throw new SafeError("CANONICAL_INTEGRITY", "view receipts are not canonical");
            return { accountKey: key, projectorId: id, generation, complete: completeRaw === 1, receipts, safeError };
        });
    }
    #queryGeneration(account) {
        const decoded = decodeAccountPartition(account);
        const row = this.#db.prepare("SELECT canonical_generation FROM account_generations WHERE account_key=?").get(accountKey(decoded));
        const generation = Number(row?.canonical_generation);
        if (!row || !Number.isSafeInteger(generation) || generation < 0)
            throw new SafeError("STATE", "account generation missing or invalid");
        return generation;
    }
    #queryState(scope) {
        const decodedScope = decodePartitionScope(scope);
        const table = decodedScope.target === "collected_album" ? "album_states" : "sync_states";
        const row = this.#db.prepare(`SELECT * FROM ${table} WHERE scope_key=?`).get(scopeKey(decodedScope));
        if (!row)
            return null;
        const state = decodeState(parseJson(row.record_json));
        const boardNameMatches = decodedScope.target !== "collected_album" || row.board_name === state.boardName;
        if (!sameScope(decodedScope, state) || row.scope_key !== scopeKey(decodedScope) || row.account_key !== accountKey(decodedScope) || row.host_id !== state.hostId || row.account_id !== state.accountId || row.target !== state.target || row.board_id !== state.boardId || !boardNameMatches || row.stop_reason !== state.stopReason || row.last_attempt_at !== state.lastAttemptAt || row.last_successful_at !== state.lastSuccessfulAt || row.next_allowed_at !== state.nextAllowedAt || Number(row.revision) !== state.revision || canonicalJson(parseJson(row.progress_json)) !== canonicalJson(state.progress))
            throw new SafeError("CANONICAL_INTEGRITY", "state structured row mismatch");
        return state;
    }
    #queryManifest(account, id) {
        const decodedAccount = decodeAccountPartition(account);
        const decodedId = decodeNoteId(id);
        const key = noteKey(decodedAccount, decodedId);
        const row = this.#db.prepare("SELECT * FROM note_manifests WHERE note_key=?").get(key);
        if (!row)
            return null;
        const slotRows = asRows(this.#db.prepare("SELECT * FROM media_slots WHERE note_key=? ORDER BY kind,ordinal").all(key));
        return this.#decodeManifestRow(row, decodedAccount, decodedId, slotRows);
    }
    #decodeManifestRow(row, decodedAccount, decodedId, slotRows) {
        const key = noteKey(decodedAccount, decodedId);
        const value = decodeNoteManifest(parseJson(row.record_json));
        if (!sameAccount(value, decodedAccount) || value.noteId !== decodedId || row.account_key !== accountKey(decodedAccount) || row.note_key !== key || row.host_id !== value.hostId || row.account_id !== value.accountId || row.note_id !== value.noteId || canonicalJson(parseJson(row.canonical_note_json)) !== canonicalJson(value.canonicalNote) || canonicalJson(parseJson(row.semantic_rank_json)) !== canonicalJson(value.semanticSourceRank) || row.content_hash !== value.canonicalNote.contentHash || row.json_object_hash !== value.artifacts.json.sha256 || row.markdown_object_hash !== value.artifacts.markdown.sha256 || row.entry_hash !== value.indexEntrySha256 || row.csv_hash !== value.csvRowSha256 || Number(row.revision) !== value.revision || value.canonicalNote.contentHash !== computeContentHash(value.canonicalNote) || value.indexEntrySha256 !== indexEntryDigest(value.canonicalNote) || value.csvRowSha256 !== noteCsvRowDigest(value.canonicalNote))
            throw new SafeError("CANONICAL_INTEGRITY", "manifest structured row mismatch");
        const slots = slotRows.map((slot) => {
            const decoded = decodeMediaSlotState(parseJson(slot.record_json));
            if (slot.note_key !== key || slot.kind !== decoded.slot.kind || Number(slot.ordinal) !== decoded.slot.ordinal || canonicalJson(parseJson(slot.source_rank_json)) !== canonicalJson(decoded.sourceRank) || slot.status !== (decoded.media?.status ?? null) || slot.object_hash !== (decoded.media?.object?.sha256 ?? null) || slot.extension !== (decoded.media?.extension ?? null) || Number(slot.tombstone) !== (decoded.tombstone ? 1 : 0))
                throw new SafeError("CANONICAL_INTEGRITY", "media slot structured row mismatch");
            return decoded;
        });
        const expectedSlots = [...value.mediaSlots].sort((a, b) => utf8Compare(a.slot.kind, b.slot.kind) || a.slot.ordinal - b.slot.ordinal);
        if (canonicalJson(slots) !== canonicalJson(expectedSlots))
            throw new SafeError("CANONICAL_INTEGRITY", "media slot rows mismatch");
        return value;
    }
    #queryTask(scope, id) {
        const decodedScope = decodePartitionScope(scope);
        const decodedId = decodeNoteId(id);
        const sKey = scopeKey(decodedScope);
        const nKey = noteKey(accountPartition(decodedScope), decodedId);
        const row = this.#db.prepare("SELECT * FROM target_tasks WHERE scope_key=? AND note_key=?").get(sKey, nKey);
        if (!row)
            return null;
        const value = decodeTaskRecord(parseJson(row.record_json));
        const relationIds = asRows(this.#db.prepare("SELECT failure_id FROM task_failures WHERE scope_key=? AND note_key=? ORDER BY failure_id").all(sKey, nKey)).map((item) => String(item.failure_id));
        if (!sameScope(value.scope, decodedScope) || value.noteId !== decodedId || row.scope_key !== sKey || row.note_key !== nKey || row.account_key !== accountKey(decodedScope) || row.status !== value.status || Number(row.attempt_count) !== value.attemptCount || row.skip_reason !== value.skipReason || row.skipped_at !== value.skippedAt || row.first_seen_at !== value.firstSeenAt || row.updated_at !== value.updatedAt || canonicalJson(relationIds) !== canonicalJson([...value.failureIds].sort(utf8Compare)))
            throw new SafeError("CANONICAL_INTEGRITY", "task structured row mismatch");
        return value;
    }
    #queryManifests(account) {
        const decoded = decodeAccountPartition(account);
        const key = accountKey(decoded);
        const rows = asRows(this.#db.prepare("SELECT * FROM note_manifests WHERE account_key=? ORDER BY note_id").all(key));
        const slots = new Map();
        for (const row of asRows(this.#db.prepare("SELECT ms.* FROM media_slots ms JOIN note_manifests n USING(note_key) WHERE n.account_key=? ORDER BY ms.kind,ms.ordinal").all(key))) {
            const values = slots.get(String(row.note_key)) ?? [];
            values.push(row);
            slots.set(String(row.note_key), values);
        }
        return rows.map((row) => this.#decodeManifestRow(row, decoded, decodeNoteId(row.note_id), slots.get(String(row.note_key)) ?? []));
    }
    #queryTasks(account, noteId) {
        const decoded = decodeAccountPartition(account);
        const key = accountKey(decoded);
        const params = noteId === undefined ? [key] : [key, noteKey(decoded, noteId)];
        const clause = noteId === undefined ? "t.account_key=?" : "t.account_key=? AND t.note_key=?";
        const rows = asRows(this.#db.prepare(`SELECT t.* FROM target_tasks t WHERE ${clause} ORDER BY t.scope_key,t.note_key`).all(...params));
        const relations = new Map();
        for (const row of asRows(this.#db.prepare(`SELECT f.scope_key,f.note_key,f.failure_id FROM task_failures f JOIN target_tasks t USING(scope_key,note_key) WHERE ${clause} ORDER BY f.failure_id`).all(...params))) {
            const relation = `${row.scope_key}:${row.note_key}`;
            const ids = relations.get(relation) ?? [];
            ids.push(String(row.failure_id));
            relations.set(relation, ids);
        }
        return rows.map((row) => {
            const value = decodeTaskRecord(parseJson(row.record_json));
            const relationIds = relations.get(`${row.scope_key}:${row.note_key}`) ?? [];
            if (!sameAccount(value.scope, decoded) || row.scope_key !== scopeKey(value.scope) || row.note_key !== noteKey(decoded, value.noteId) || row.account_key !== key || row.status !== value.status || Number(row.attempt_count) !== value.attemptCount || row.skip_reason !== value.skipReason || row.skipped_at !== value.skippedAt || row.first_seen_at !== value.firstSeenAt || row.updated_at !== value.updatedAt || canonicalJson(relationIds) !== canonicalJson([...value.failureIds].sort(utf8Compare)))
                throw new SafeError("CANONICAL_INTEGRITY", "task structured row mismatch");
            return value;
        });
    }
    #decodeFailureRow(row) {
        const value = decodeFailureRecord(parseJson(row.record_json));
        const account = accountPartition(value.scope);
        if (row.failure_id !== value.failureId || row.account_key !== accountKey(account) || row.scope_key !== scopeKey(value.scope) || row.note_key !== noteKey(account, value.noteId) || row.media_kind !== (value.mediaSlot?.kind ?? null) || (row.media_ordinal === null ? null : Number(row.media_ordinal)) !== (value.mediaSlot?.ordinal ?? null) || (row.source_rank_json === null ? null : canonicalJson(parseJson(row.source_rank_json))) !== (value.sourceRank === null ? null : canonicalJson(value.sourceRank)) || row.category !== value.category || row.stage !== value.stage || row.safe_message !== value.safeMessage || Number(row.retryable) !== (value.retryable ? 1 : 0) || Number(row.attempts) !== value.attemptCount || row.first_occurred_at !== value.firstOccurredAt || row.last_occurred_at !== value.lastOccurredAt || row.retry_at !== value.retryAt || row.resolved_at !== value.resolvedAt || row.resolved_reason !== value.resolvedReason || value.failureId !== computeFailureId(value))
            throw new SafeError("CANONICAL_INTEGRITY", "failure structured row mismatch");
        return value;
    }
    #queryFailures(account, noteId) { const decoded = decodeAccountPartition(account); return asRows(this.#db.prepare(`SELECT * FROM failures WHERE account_key=? AND resolved_at IS NULL${noteId === undefined ? "" : " AND note_key=?"}`).all(...(noteId === undefined ? [accountKey(decoded)] : [accountKey(decoded), noteKey(decoded, noteId)]))).map((row) => this.#decodeFailureRow(row)).sort((a, b) => utf8Compare(canonicalJson([a.scope.hostId, a.scope.accountId, a.scope.target, a.scope.boardId, a.noteId, a.mediaSlot?.kind ?? null, a.mediaSlot?.ordinal ?? null, a.stage, a.category, a.failureId]), canonicalJson([b.scope.hostId, b.scope.accountId, b.scope.target, b.scope.boardId, b.noteId, b.mediaSlot?.kind ?? null, b.mediaSlot?.ordinal ?? null, b.stage, b.category, b.failureId]))); }
    #decodeRunRow(row) {
        const value = decodeRunRecord(parseJson(row.record_json));
        if (row.run_id !== value.runId || row.account_key !== accountKey(value.account) || row.scope_key !== (value.scope === null ? null : scopeKey(value.scope)) || row.command !== value.command || row.outcome !== value.outcome || row.started_at !== value.startedAt || row.finished_at !== value.finishedAt || row.safe_error_category !== value.safeErrorCategory || Number(row.listed) !== value.listed || Number(row.done) !== value.done || Number(row.partial) !== value.partial || Number(row.failed) !== value.failed || Number(row.skipped) !== value.skipped)
            throw new SafeError("CANONICAL_INTEGRITY", "run structured row mismatch");
        return value;
    }
    #queryRuns(account) { const decoded = decodeAccountPartition(account); return asRows(this.#db.prepare("SELECT * FROM runs WHERE account_key=? ORDER BY finished_at,run_id").all(accountKey(decoded))).map((row) => this.#decodeRunRow(row)); }
    #queryObjectRefs(account) { const decoded = decodeAccountPartition(account); return asRows(this.#db.prepare("SELECT DISTINCT o.hash,o.byte_length,o.mime_type FROM objects o JOIN (SELECT json_object_hash h FROM note_manifests WHERE account_key=? UNION SELECT markdown_object_hash FROM note_manifests WHERE account_key=? UNION SELECT ms.object_hash FROM media_slots ms JOIN note_manifests n USING(note_key) WHERE n.account_key=? AND ms.object_hash IS NOT NULL) r ON r.h=o.hash ORDER BY o.hash").all(accountKey(decoded), accountKey(decoded), accountKey(decoded))).map((row) => decodeObjectRef({ sha256: row.hash, byteLength: Number(row.byte_length), mimeType: row.mime_type })); }
    #queryRetry(scope, limit) { const decoded = decodePartitionScope(scope); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
        throw new SafeError("INVALID_INPUT", "invalid retry limit"); return asRows(this.#db.prepare("SELECT * FROM failures WHERE scope_key=? AND resolved_at IS NULL AND retryable=1 ORDER BY coalesce(retry_at,first_occurred_at),first_occurred_at,failure_id LIMIT ?").all(scopeKey(decoded), limit)).map((row) => { const failure = this.#decodeFailureRow(row); if (!sameScope(failure.scope, decoded))
        throw new SafeError("CANONICAL_INTEGRITY", "retry scope mismatch"); return failure; }); }
}
export class SqliteAccountStore {
    load(snapshot, hostId, accountId) {
        if (!(snapshot instanceof SnapshotBase))
            throw new SafeError("STATE", "invalid snapshot");
        return snapshotOwner(snapshot).loadAccount(snapshot, hostId, accountId);
    }
    upsert(snapshot, account) {
        if (!(snapshot instanceof SnapshotBase))
            throw new SafeError("STATE", "invalid snapshot");
        return snapshotOwner(snapshot).upsertAccount(snapshot, account);
    }
}
