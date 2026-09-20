import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { exportAccount } from "../src/projectors.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { accountKey, accountPartition } from "../src/types.ts";
import { verifyRoot } from "../src/verify.ts";
import { makeAccount, makeRun, makeScope, tempRoot } from "./helpers.ts";
const scope = makeScope("recovery-fixture");
const account = accountPartition(scope);
async function seed() {
  const root = await tempRoot("rednote-export-recovery-");
  const store = await SqliteStateStore.init(root);
  const tx = store.beginImmediate({ command: "sync", scope }); store.upsertAccount(tx, makeAccount(scope.accountId)); store.commitCanonical(tx); store.close();
  return root;
}

test("a live exporter owns the account lock without holding a database writer", async () => {
  const root = await seed();
  try {
    let notify!: () => void; const entered = new Promise<void>((resolve) => { notify = resolve; });
    let unblock!: () => void; const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let firstPoint = true;
    const first = exportAccount(root, account, { async onCheckpoint() { if (firstPoint) { firstPoint = false; notify(); await blocked; } } });
    await entered;
    try { assert.equal((await exportAccount(root, account)).exitCode, 9); }
    finally { unblock(); }
    assert.equal((await first).exitCode, 0);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical changes during export keep it dirty until the next committed generation is exported", async () => {
  const root = await seed();
  try {
    let changed = false;
    const result = await exportAccount(root, account, { async onCheckpoint() {
      if (changed) return; changed = true;
      const writer = await SqliteStateStore.open(root);
      try { const tx = writer.beginImmediate({ command: "sync", scope }); writer.upsertAccount(tx, makeAccount(scope.accountId)); writer.commitCanonical(tx); }
      finally { writer.close(); }
    } });
    assert.equal(result.exitCode, 9);
    const store = await SqliteStateStore.openReadOnly(root); const read = store.openReadSnapshot();
    assert.equal([...read.enumerateAccountsWithGenerations()][0]!.viewsDirty, true); read.close(); store.close();
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed output paths reject symlinks without writing through them", async () => {
  const root = await seed(); const outside = await tempRoot("rednote-outside-");
  try {
    await mkdir(path.join(root, "accounts"), { mode: 0o700 });
    await symlink(outside, path.join(root, "accounts", accountKey(account)));
    await writeFile(path.join(outside, "sentinel"), "unchanged");
    await assert.rejects(exportAccount(root, account), /unsafe path ancestor/);
    assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "unchanged");
    await assert.rejects(stat(path.join(outside, "account.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("full repair removes legacy undo remnants and keeps their external symlink targets untouched", async () => {
  const root = await seed(); const outside = await tempRoot("rednote-undo-outside-");
  try {
    await exportAccount(root, account, { full: true });
    const notes = path.join(root, "accounts", accountKey(account), "notes");
    const backup = path.join(notes, `.rednote-sync-undo-${"a".repeat(24)}.bak`);
    await writeFile(backup, "obsolete derived backup", { mode: 0o600 });
    await exportAccount(root, account, { full: true }); await assert.rejects(stat(backup), { code: "ENOENT" });
    const target = path.join(outside, "sentinel"); await writeFile(target, "unchanged"); await symlink(target, backup);
    await assert.rejects(exportAccount(root, account, { full: true }), /symlink in derived files/);
    assert.equal(await readFile(target, "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test("a concurrent run record cannot be hidden by an older export marking the account clean", async () => {
  const root = await seed();
  try {
    let recorded = false;
    const result = await exportAccount(root, account, { async onCheckpoint() {
      if (recorded) return; recorded = true;
      const competing = await exportAccount(root, account, { run: makeRun(scope, "sync", "concurrent-run") });
      assert.equal(competing.exitCode, 9);
    } });
    assert.equal(result.exitCode, 9);
    const store = await SqliteStateStore.openReadOnly(root); const read = store.openReadSnapshot();
    assert.equal([...read.enumerateAccountsWithGenerations()][0]!.viewsDirty, true);
    assert.equal([...read.enumerateRuns(account)][0]!.runId, "concurrent-run"); read.close(); store.close();
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    assert.match(await readFile(path.join(root, `accounts/${accountKey(account)}/logs/export-runs.jsonl`), "utf8"), /concurrent-run/);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("an interrupted refresh marks a previously clean account dirty until recovery", async () => {
  const root = await seed();
  try {
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    const abort = new AbortController();
    const interrupted = await exportAccount(root, account, { signal: abort.signal, onCheckpoint() { abort.abort(); } });
    assert.equal(interrupted.exitCode, 9);
    const store = await SqliteStateStore.openReadOnly(root); const read = store.openReadSnapshot();
    assert.equal([...read.enumerateAccountsWithGenerations()][0]!.viewsDirty, true); read.close(); store.close();
    assert.equal((await exportAccount(root, account)).exitCode, 0);
    assert.equal((await verifyRoot(root)).exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
