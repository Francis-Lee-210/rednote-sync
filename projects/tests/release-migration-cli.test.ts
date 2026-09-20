import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStateStore } from "../src/state-store.ts";
import { tempRoot } from "./helpers.ts";

interface CliRecord { readonly ok: boolean; readonly command: string | null; readonly exitCode: number; readonly result?: unknown; readonly error?: { readonly category?: string } }

function migrateCli(root: string): { readonly status: number; readonly record: CliRecord; readonly stderr: string } {
  const result = spawnSync(process.execPath, [path.resolve("src/bin.js"), "migrate", "--root", root], { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${result.stdout}`);
  const record = JSON.parse(lines[0]!) as CliRecord;
  assert.equal(record.exitCode, result.status);
  assert.equal(`${result.stdout}${result.stderr}`.includes(root), false, "migration diagnostics cannot reflect root paths");
  return { status: result.status!, record, stderr: result.stderr };
}

async function legacyRoot(label: string): Promise<{ readonly root: string; readonly dbPath: string }> {
  const root = await tempRoot(label);
  const initialized = await SqliteStateStore.init(root);
  initialized.close();
  const dbPath = path.join(root, "state", "rednote-sync.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("ALTER TABLE meta RENAME TO meta_v1; CREATE TABLE meta (schema_version INTEGER NOT NULL CHECK(schema_version = 0)); INSERT INTO meta VALUES(0); DROP TABLE meta_v1; DELETE FROM schema_migrations");
  database.close();
  return { root, dbPath };
}

test("migrate CLI upgrades exact v0 to v1 and refuses current v1", async () => {
  const { root, dbPath } = await legacyRoot("rednote-release-migrate-ok-");
  try {
    const migrated = migrateCli(root);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(migrated.record.result, { migrated: true, fromVersion: 0, toVersion: 1, backupCreated: false });
    const database = new DatabaseSync(dbPath);
    const meta = database.prepare("SELECT schema_version,schema_fingerprint FROM meta").get() as Record<string, unknown>;
    const audit = database.prepare("SELECT from_version,to_version,outcome FROM schema_migrations WHERE command='migrate_schema'").get() as Record<string, unknown>;
    database.close();
    assert.equal(Number(meta.schema_version), 1);
    assert.match(String(meta.schema_fingerprint), /^[0-9a-f]{64}$/u);
    assert.deepEqual([Number(audit.from_version), Number(audit.to_version), audit.outcome], [0, 1, "committed"]);
    const current = migrateCli(root);
    assert.equal(current.status, 6);
    assert.equal(current.record.error?.category, "STATE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrate CLI refuses future and structurally modified v0 schemas", async () => {
  const future = await legacyRoot("rednote-release-migrate-future-");
  const modified = await legacyRoot("rednote-release-migrate-modified-");
  try {
    const futureDb = new DatabaseSync(future.dbPath);
    futureDb.exec("PRAGMA ignore_check_constraints=ON; UPDATE meta SET schema_version=2");
    futureDb.close();
    assert.equal(migrateCli(future.root).status, 6);

    const modifiedDb = new DatabaseSync(modified.dbPath);
    modifiedDb.exec("CREATE TABLE unauthorized_schema_change(value TEXT)");
    modifiedDb.close();
    assert.equal(migrateCli(modified.root).status, 6);
  } finally {
    await rm(future.root, { recursive: true, force: true });
    await rm(modified.root, { recursive: true, force: true });
  }
});

test("migrate CLI reports BUSY while a second writer holds BEGIN IMMEDIATE", async () => {
  const { root, dbPath } = await legacyRoot("rednote-release-migrate-busy-");
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const busy = migrateCli(root);
    assert.equal(busy.status, 8, JSON.stringify(busy));
    assert.equal(busy.record.error?.category, "BUSY");
  } finally {
    try { writer.exec("ROLLBACK"); } catch { /* preserve cleanup */ }
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});
