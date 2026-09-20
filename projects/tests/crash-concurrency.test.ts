import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { repairViews } from "../src/commands.ts";
import { requestScopePause, resumeScope } from "../src/control.ts";
import { FileContentAddressedObjectStore } from "../src/object-store.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { accountPartition, type ObjectRef } from "../src/types.ts";
import { verifyRoot } from "../src/verify.ts";
import { makeScope, tempRoot } from "./helpers.ts";
import { fixtureDetail, fixtureFailure, fixturePage, openStage3bFixture, stage3bNow } from "./stage3b-fixtures.ts";

const clock = Object.freeze({ now: () => stage3bNow, sleep: async () => {} });

async function seeded(label: string, account: string) {
  const root = await tempRoot(label);
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope(account);
  await writeFile(path.join(root, "old.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
  const detail = fixtureDetail(scope, "crash-note", { body: "body v1", media: [
    { kind: "image", ordinal: 1, mediaId: "media-v1", relativePath: "old.png" },
    { kind: "image", ordinal: 2, mediaId: "media-missing", failure: fixtureFailure("MEDIA") },
  ] });
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, ["crash-note"], { details: [detail] })]);
  const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
  assert.equal(result.exitCode, 9);
  session.close();
  return { root, scope };
}

function worker(root: string, accountId: string, phase: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [path.resolve("tests/integration-worker.ts"), root, accountId, phase], { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
}

async function waitReady(child: ChildProcessWithoutNullStreams, phase: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic += String(chunk); });
    const timer = setTimeout(() => reject(new Error(`worker readiness timeout: ${output}/${diagnostic}`)), 10_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes(`READY:${phase}\n`)) { clearTimeout(timer); resolve(); } });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`worker exited before readiness: ${code}/${signal}: ${diagnostic}`)); });
  });
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function canonicalSnapshot(root: string, scope: ReturnType<typeof makeScope>) {
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const account = accountPartition(scope);
  try {
    return {
      state: snapshot.loadState(scope),
      generation: [...snapshot.enumerateAccountsWithGenerations()][0],
      manifest: [...snapshot.enumerateAccountManifests(account)][0] ?? null,
      task: [...snapshot.enumerateAccountTasks(account)][0] ?? null,
      failures: [...snapshot.enumerateUnresolvedFailures(account)],
      refs: [...snapshot.enumerateObjectRefs(account)].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    };
  } finally { snapshot.close(); store.close(); }
}

async function diskObjectHashes(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  const base = path.join(root, "objects", "sha256");
  for (const bucket of await readdir(base)) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) continue;
    for (const name of await readdir(path.join(base, bucket))) if (/^[0-9a-f]{64}$/.test(name)) result.add(name);
  }
  return result;
}

async function captureObjectBytes(root: string, refs: readonly ObjectRef[]): Promise<Map<string, Buffer>> {
  const objects = new FileContentAddressedObjectStore(root);
  return new Map(await Promise.all(refs.map(async (ref) => [ref.sha256, Buffer.from(await objects.readBytes(ref))] as const)));
}

async function assertObjectBytes(root: string, expected: ReadonlyMap<string, Buffer>, refs: readonly ObjectRef[]): Promise<void> {
  const objects = new FileContentAddressedObjectStore(root);
  for (const ref of refs) assert.deepEqual(Buffer.from(await objects.readBytes(ref)), expected.get(ref.sha256), `immutable object ${ref.sha256} changed`);
}

test("real SIGKILL at object/canonical/projection/finalize/commit boundaries leaves a v1→v2 note transaction all-old or all-new", async () => {
  for (const phase of ["object", "canonical", "projection", "finalize", "commit"] as const) {
    const { root, scope } = await seeded(`rednote-crash-${phase}-`, `crash-${phase}`);
    const before = await canonicalSnapshot(root, scope);
    assert.equal(before.manifest?.canonicalNote.body, "body v1");
    assert.equal(before.manifest?.mediaSlots.filter((slot) => slot.media?.status === "stored").length, 1);
    assert.equal(before.task?.status, "partial");
    assert.equal(before.failures.length, 1);
    const oldBytes = await captureObjectBytes(root, before.refs);
    const oldDisk = await diskObjectHashes(root);
    const child = worker(root, scope.accountId, phase);
    await waitReady(child, phase);
    const published = [...await diskObjectHashes(root)].filter((hash) => !oldDisk.has(hash));
    assert.ok(published.length >= 4, `${phase} must publish replacement media and artifacts before READY`);
    if (phase === "projection" || phase === "finalize") assert.equal((await verifyRoot(root)).exitCode, 9, "uncommitted v2 views are detectably ahead of committed v1");
    await kill(child);
    const after = await canonicalSnapshot(root, scope);
    await assertObjectBytes(root, oldBytes, before.refs);
    if (phase === "commit") {
      assert.equal(after.state?.revision, (before.state?.revision ?? 0) + 1);
      assert.equal(after.generation?.canonicalGeneration, (before.generation?.canonicalGeneration ?? 0) + 1);
      assert.equal(after.manifest?.revision, (before.manifest?.revision ?? 0) + 1);
      assert.equal(after.manifest?.canonicalNote.body, "body v2");
      assert.deepEqual(after.manifest?.canonicalNote.media.map((media) => [media.ordinal, media.status]), [[1, "stored"], [2, "stored"]]);
      assert.equal(after.task?.status, "done");
      assert.equal(after.task?.attemptCount, (before.task?.attemptCount ?? 0) + 1);
      assert.equal(after.failures.length, 0);
      const newRefHashes = new Set(after.refs.map((ref) => ref.sha256));
      assert.equal(before.refs.some((ref) => newRefHashes.has(ref.sha256)), false, "committed v2 cannot mix v1 manifest/media refs");
      assert.equal(after.refs.every((ref) => published.includes(ref.sha256)), true);
      assert.equal((await verifyRoot(root)).exitCode, 0);
    } else {
      assert.deepEqual(after, before, `${phase} must roll back state, manifest, task, failure, generation, and object refs together`);
      const referenced = new Set<string>(after.refs.map((ref) => ref.sha256));
      assert.equal(published.every((hash) => !referenced.has(hash)), true, "published v2 objects must remain harmless orphans before commit");
      const report = await verifyRoot(root);
      if (phase === "projection" || phase === "finalize") {
        assert.equal(report.exitCode, 9);
        assert.equal((await repairViews(root, accountPartition(scope), clock)).exitCode, 0);
        assert.equal((await verifyRoot(root)).exitCode, 0);
      } else assert.equal(report.exitCode, 0);
    }
  }
});

test("a real second CLI writer exits 8 immediately; SIGKILL releases the SQLite writer for repair", async () => {
  const { root, scope } = await seeded("rednote-double-writer-", "double-writer-account");
  const child = worker(root, scope.accountId, "canonical");
  await waitReady(child, "canonical");
  const second = spawnSync(process.execPath, [path.resolve("src/cli.ts"), "repair-views", "--root", root, "--host", scope.hostId, "--account", scope.accountId], { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 });
  assert.equal(second.status, 8);
  assert.equal(JSON.parse(second.stdout.trim()).error.category, "BUSY");
  await kill(child);
  assert.equal((await repairViews(root, accountPartition(scope), clock)).exitCode, 0);
  assert.equal((await verifyRoot(root)).exitCode, 0);
});
