import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, type CliDependencies } from "../src/cli.ts";
import { repairViews } from "../src/commands.ts";
import { requestScopePause, resumeScope } from "../src/control.ts";
import { SafeError } from "../src/errors.ts";
import { FileContentAddressedObjectStore } from "../src/object-store.ts";
import type { ProjectionRecoveryActionPoint, ProjectionSettlementPoint } from "../src/projectors.ts";
import { SqliteStateStore } from "../src/state-store.ts";
import { SyncEngine, type SyncEngineOptions } from "../src/sync-engine.ts";
import { accountKey, accountPartition, noteKey, type ObjectRef } from "../src/types.ts";
import { verifyRoot } from "../src/verify.ts";
import { makeScope, tempRoot } from "./helpers.ts";
import { fixtureDetail, fixtureFailure, fixturePage, openStage3bFixture, stage3bNow } from "./stage3b-fixtures.ts";

const RECOVERY_ACCOUNT = "recover3";
const RECOVERY_NOTE = "recovery-note";
const SECOND_NOTE = "steady-note";
const clock = Object.freeze({ now: () => stage3bNow, sleep: async () => {} });
const BACKUP_RE = /^\.rednote-sync-undo-[0-9a-f]{24}\.bak$/u;

interface BackupRecord { readonly path: string; readonly name: string }

async function seedRecoveryRoot(label: string): Promise<{ readonly root: string; readonly scope: ReturnType<typeof makeScope> }> {
  const root = await tempRoot(label);
  (await SqliteStateStore.init(root)).close();
  const scope = makeScope(RECOVERY_ACCOUNT);
  await writeFile(path.join(root, "recovery-old-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]));
  await writeFile(path.join(root, "recovery-old-3.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x13]));
  await writeFile(path.join(root, "recovery-new-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x21]));
  await writeFile(path.join(root, "recovery-new-2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x22]));
  const initial = fixtureDetail(scope, RECOVERY_NOTE, { body: "body v1", media: [
    { kind: "image", ordinal: 1, mediaId: "media-v1-1", relativePath: "recovery-old-1.png" },
    { kind: "image", ordinal: 2, mediaId: "media-v1-missing", failure: fixtureFailure("MEDIA") },
    { kind: "image", ordinal: 3, mediaId: "media-v1-3", relativePath: "recovery-old-3.png" },
  ] });
  const steady = fixtureDetail(scope, SECOND_NOTE, { body: "steady body" });
  const session = await openStage3bFixture(root, scope, [fixturePage(scope, null, [RECOVERY_NOTE, SECOND_NOTE], { details: [initial, steady] })], [], "fixture", "recovery-seed.json");
  try {
    const result = await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0 }).runPage(new AbortController().signal);
    assert.equal(result.exitCode, 9);
  } finally { session.close(); }
  return { root, scope };
}

function updateDetail(scope: ReturnType<typeof makeScope>): unknown {
  return fixtureDetail(scope, RECOVERY_NOTE, {
    body: "body v2",
    revisionAt: "2026-03-02T00:00:00.000Z",
    media: [
      { kind: "image", ordinal: 1, mediaId: "media-v2-1", relativePath: "recovery-new-1.png" },
      { kind: "image", ordinal: 2, mediaId: "media-v2-2", relativePath: "recovery-new-2.png" },
    ],
  });
}

async function runUpdate(root: string, scope: ReturnType<typeof makeScope>, options: Pick<SyncEngineOptions, "projectionBoundaryObserver" | "projectionRecoveryObserver" | "projectionSettlementObserver"> = {}) {
  const session = await openStage3bFixture(root, scope, [], [{ scope, noteId: RECOVERY_NOTE, detail: updateDetail(scope) }], "fixture", "recovery-update.json");
  try {
    return await new SyncEngine({ root, scope, session, clock, minimumIntervalMs: 0, ...options }).retryFailures(new AbortController().signal);
  } finally { session.close(); }
}

async function canonicalSnapshot(root: string, scope: ReturnType<typeof makeScope>) {
  const store = await SqliteStateStore.openReadOnly(root);
  const snapshot = store.openReadSnapshot();
  const account = accountPartition(scope);
  try {
    return {
      state: snapshot.loadState(scope),
      generation: [...snapshot.enumerateAccountsWithGenerations()][0] ?? null,
      manifest: snapshot.loadManifest(account, RECOVERY_NOTE),
      task: snapshot.loadTask(scope, RECOVERY_NOTE),
      failures: [...snapshot.enumerateUnresolvedFailures(account)],
      refs: [...snapshot.enumerateObjectRefs(account)].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    };
  } finally { snapshot.close(); store.close(); }
}

async function captureObjectBytes(root: string, refs: readonly ObjectRef[]): Promise<Map<string, Buffer>> {
  const objects = new FileContentAddressedObjectStore(root);
  return new Map(await Promise.all(refs.map(async (ref) => [ref.sha256, Buffer.from(await objects.readBytes(ref))] as const)));
}

async function assertObjectBytes(root: string, expected: ReadonlyMap<string, Buffer>, refs: readonly ObjectRef[]): Promise<void> {
  const objects = new FileContentAddressedObjectStore(root);
  for (const ref of refs) {
    assert.equal(await objects.verify(ref), true);
    assert.deepEqual(Buffer.from(await objects.readBytes(ref)), expected.get(ref.sha256));
  }
}

async function backups(root: string, scope: ReturnType<typeof makeScope>): Promise<readonly BackupRecord[]> {
  const base = path.join(root, "accounts", accountKey(accountPartition(scope)));
  const result: BackupRecord[] = [];
  const pending = [base];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) { pending.push(target); continue; }
      if (!BACKUP_RE.test(entry.name)) continue;
      assert.equal(info.isFile(), true);
      assert.equal(info.uid, process.getuid?.());
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal(info.nlink, 1);
      result.push(Object.freeze({ path: target, name: entry.name }));
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function sameCanonicalBusinessState(actual: Awaited<ReturnType<typeof canonicalSnapshot>>, expected: Awaited<ReturnType<typeof canonicalSnapshot>>): void {
  assert.deepEqual(actual.state, expected.state);
  assert.deepEqual(actual.manifest, expected.manifest);
  assert.deepEqual(actual.task, expected.task);
  assert.deepEqual(actual.failures, expected.failures);
  assert.deepEqual(actual.refs, expected.refs);
}

function recoveryWorker(root: string, actionIndex: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [path.resolve("tests/projection-recovery-worker.ts"), root, String(actionIndex)], { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
}

async function waitForUndo(child: ChildProcessWithoutNullStreams): Promise<ProjectionRecoveryActionPoint> {
  return new Promise<ProjectionRecoveryActionPoint>((resolve, reject) => {
    let output = "";
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic += String(chunk); });
    const timer = setTimeout(() => reject(new Error(`projection recovery worker timeout: ${output}/${diagnostic}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/READY:undo:(\{[^\n]+\})\n/u);
      if (!match) return;
      clearTimeout(timer);
      resolve(JSON.parse(match[1]!) as ProjectionRecoveryActionPoint);
    });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`projection recovery worker exited: ${code}/${signal}: ${diagnostic}`)); });
  });
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill("SIGKILL");
  await once(child, "exit");
}

function backupName(index: number): string { return `.rednote-sync-undo-${index.toString(16).padStart(24, "0")}.bak`; }

async function uncheckedBackupPaths(root: string, scope: ReturnType<typeof makeScope>): Promise<readonly string[]> {
  const base = path.join(root, "accounts", accountKey(accountPartition(scope)));
  const result: string[] = [];
  const pending = [base];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isDirectory()) { pending.push(target); continue; }
      if (BACKUP_RE.test(entry.name)) result.push(target);
    }
  }
  return result.sort();
}

function cliDependenciesForSync(operation: () => Promise<{ readonly exitCode: number; readonly run: unknown }>): CliDependencies {
  const idle = Object.freeze({ exitCode: 0, output: null });
  return Object.freeze({
    async init() { return null; },
    async validateInput() { return null; },
    async sync() { const result = await operation(); return { exitCode: result.exitCode, output: result }; },
    async retryFailures() { return idle; },
    async skip() { return idle; },
    async acknowledge() { return idle; },
    async pause() { return null; },
    async resume() { return null; },
    async repairViews() { return idle; },
    async status() { return null; },
    async verify() { return idle; },
  });
}

test("abandoned-backup cleanup is fixed-layout, two-phase, and rejects unsafe identities without deleting anything", async () => {
  const hazards = ["symlink", "hardlink", "wrong_mode", "manual_directory", "cross_account", "state_inode", "object_inode"] as const;
  for (const hazard of hazards) {
    const { root, scope } = await seedRecoveryRoot(`rednote-backup-${hazard}-`);
    try {
      const partition = accountPartition(scope);
      const key = accountKey(partition);
      const accountRoot = path.join(root, "accounts", key);
      const validBackup = path.join(accountRoot, backupName(900));
      await writeFile(validBackup, "valid abandoned backup", { mode: 0o600 });
      const steadyMarkdown = path.join(accountRoot, "notes", `${noteKey(partition, SECOND_NOTE)}.md`);
      const changingMarkdown = path.join(accountRoot, "notes", `${noteKey(partition, RECOVERY_NOTE)}.md`);
      const expectedSteady = { bytes: await readFile(steadyMarkdown), stat: await stat(steadyMarkdown) };
      const expectedChanging = { bytes: await readFile(changingMarkdown), stat: await stat(changingMarkdown) };
      if (hazard === "symlink") {
        const source = path.join(root, "symlink-source");
        await writeFile(source, "source", { mode: 0o600 });
        await symlink(source, path.join(accountRoot, ".views", backupName(1)));
      } else if (hazard === "hardlink") {
        const source = path.join(root, "hardlink-source");
        await writeFile(source, "source", { mode: 0o600 });
        await link(source, path.join(accountRoot, "logs", backupName(2)));
      } else if (hazard === "wrong_mode") {
        await writeFile(path.join(accountRoot, "data", backupName(3)), "wrong mode", { mode: 0o644 });
      } else if (hazard === "manual_directory") {
        const manual = path.join(accountRoot, "manual");
        await mkdir(manual, { mode: 0o700 });
        await writeFile(path.join(manual, backupName(4)), "manual backup", { mode: 0o600 });
      } else if (hazard === "cross_account") {
        const other = path.join(root, "accounts", accountKey(accountPartition(makeScope("otheracct"))), "notes");
        await mkdir(other, { recursive: true, mode: 0o700 });
        const source = path.join(other, backupName(5));
        await writeFile(source, "other account inode", { mode: 0o600 });
        await link(source, path.join(accountRoot, ".views", backupName(6)));
      } else if (hazard === "state_inode") {
        const source = path.join(root, "state", "audit-sentinel");
        await writeFile(source, "state inode", { mode: 0o600 });
        await link(source, path.join(accountRoot, "logs", backupName(7)));
      } else {
        const snapshot = await canonicalSnapshot(root, scope);
        const object = new FileContentAddressedObjectStore(root).objectPath(snapshot.refs[0]!.sha256);
        await link(object, path.join(accountRoot, "notes", backupName(8)));
      }
      await assert.rejects(repairViews(root, partition, clock), (error: unknown) => error instanceof SafeError && error.code === "SECURITY_BOUNDARY");
      assert.equal(await readFile(validBackup, "utf8"), "valid abandoned backup");
      const afterSteady = { bytes: await readFile(steadyMarkdown), stat: await stat(steadyMarkdown) };
      const afterChanging = { bytes: await readFile(changingMarkdown), stat: await stat(changingMarkdown) };
      for (const [actual, expected] of [[afterSteady, expectedSteady], [afterChanging, expectedChanging]] as const) {
        assert.deepEqual(actual.bytes, expected.bytes);
        assert.equal(actual.stat.ino, expected.stat.ino);
        assert.equal(actual.stat.mode, expected.stat.mode);
        assert.equal(actual.stat.mtimeMs, expected.stat.mtimeMs);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  const { root, scope } = await seedRecoveryRoot("rednote-backup-multinote-");
  try {
    const partition = accountPartition(scope);
    const accountRoot = path.join(root, "accounts", accountKey(partition));
    const validBackup = path.join(accountRoot, "data", backupName(901));
    await writeFile(validBackup, "clean me", { mode: 0o600 });
    const notePaths = [RECOVERY_NOTE, SECOND_NOTE].map((id) => path.join(accountRoot, "notes", `${noteKey(partition, id)}.md`));
    const before = await Promise.all(notePaths.map(async (target) => ({ bytes: await readFile(target), stat: await stat(target) })));
    assert.equal((await repairViews(root, partition, clock)).exitCode, 0);
    await assert.rejects(stat(validBackup), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const after = await Promise.all(notePaths.map(async (target) => ({ bytes: await readFile(target), stat: await stat(target) })));
    for (const [index, expected] of before.entries()) {
      assert.deepEqual(after[index]!.bytes, expected.bytes);
      assert.equal(after[index]!.stat.ino, expected.stat.ino);
      assert.equal(after[index]!.stat.mode, expected.stat.mode);
      assert.equal(after[index]!.stat.mtimeMs, expected.stat.mtimeMs);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-commit settlement maps real ENOENT, unsafe backup, and SafeError failures to path-free CLI exit 9", async () => {
  for (const failure of ["missing", "unsafe_mode", "safe_error"] as const) {
    const { root, scope } = await seedRecoveryRoot(`rednote-settle-real-${failure}-`);
    let injected = false;
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const operation = () => runUpdate(root, scope, { projectionSettlementObserver: async (point) => {
        if (injected || point.phase !== "before_remove_backup") return;
        injected = true;
        if (failure === "safe_error") throw new SafeError("STATE", `sensitive internal path ${root}/${point.relativePath}`);
        const directory = path.dirname(path.join(root, point.relativePath));
        const candidate = (await readdir(directory)).find((name) => BACKUP_RE.test(name));
        assert.ok(candidate);
        if (failure === "missing") await unlink(path.join(directory, candidate));
        else await chmod(path.join(directory, candidate), 0o644);
      } });
      const exitCode = await runCli([
        "sync", "--root", root, "--adapter", "fixture", "--input", "ignored.json",
        "--host", scope.hostId, "--account", scope.accountId, "--target", scope.target,
      ], cliDependenciesForSync(operation), { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
      assert.equal(injected, true);
      assert.equal(exitCode, 9);
      assert.deepEqual(JSON.parse(stdout[0]!), { ok: false, command: "sync", exitCode: 9, error: { category: "DERIVED_VIEW" } });
      assert.equal(stdout.length, 1);
      assert.equal(stderr.length, 1);
      assert.doesNotMatch(`${stdout[0]}\n${stderr[0]}`, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.doesNotMatch(`${stdout[0]}\n${stderr[0]}`, /\.rednote-sync-undo|relativePath|sensitive internal path/u);
      const committed = await canonicalSnapshot(root, scope);
      assert.equal(committed.manifest?.canonicalNote.body, "body v2");
      assert.equal(committed.task?.status, "done");
      assert.equal(committed.failures.length, 0);
      for (const backup of await uncheckedBackupPaths(root, scope)) await chmod(backup, 0o600);
      assert.equal((await repairViews(root, accountPartition(scope), clock)).exitCode, 0);
      assert.deepEqual(await backups(root, scope), []);
      assert.equal((await verifyRoot(root)).exitCode, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("every post-commit backup settlement deletion failure is fail-closed and the next repair cleans only strict remnants", async () => {
  const catalogRoot = await seedRecoveryRoot("rednote-settle-catalog-");
  const catalog: ProjectionSettlementPoint[] = [];
  try {
    const result = await runUpdate(catalogRoot.root, catalogRoot.scope, { projectionSettlementObserver: (point) => {
      assert.equal(Object.isFrozen(point), true);
      if (point.phase === "before_remove_backup") catalog.push(point);
    } });
    assert.equal(result.exitCode, 0);
    assert.ok(catalog.length > 0);
    assert.deepEqual(catalog.map((point) => point.index), catalog.map((_, index) => index));
    assert.equal(catalog.every((point) => point.total === catalog.length), true);
    assert.equal(catalog.some((point) => point.kind === "replaced"), true);
    assert.equal(catalog.some((point) => point.kind === "deleted"), true);
    assert.equal(catalog.some((point) => point.relativePath.includes("/.views/")), true);
  } finally { await rm(catalogRoot.root, { recursive: true, force: true }); }

  for (const injected of catalog) {
    const { root, scope } = await seedRecoveryRoot(`rednote-settle-${injected.index}-`);
    try {
      const before = await canonicalSnapshot(root, scope);
      const oldBytes = await captureObjectBytes(root, before.refs);
      await assert.rejects(
        runUpdate(root, scope, { projectionSettlementObserver: (point) => {
          if (point.phase === "before_remove_backup" && point.index === injected.index) throw new Error("injected backup deletion failure");
        } }),
        (error: unknown) => error instanceof SafeError && error.code === "DERIVED_VIEW" && error.message === "projection backup settlement failed",
      );
      const committed = await canonicalSnapshot(root, scope);
      assert.equal(committed.state?.revision, (before.state?.revision ?? 0) + 1);
      assert.equal(committed.generation?.canonicalGeneration, (before.generation?.canonicalGeneration ?? 0) + 1);
      assert.equal(committed.manifest?.revision, (before.manifest?.revision ?? 0) + 1);
      assert.equal(committed.manifest?.canonicalNote.body, "body v2");
      assert.equal(committed.task?.status, "done");
      assert.equal(committed.failures.length, 0);
      await assertObjectBytes(root, oldBytes, before.refs);
      await assertObjectBytes(root, await captureObjectBytes(root, committed.refs), committed.refs);
      const remnants = await backups(root, scope);
      assert.equal(remnants.length, catalog.length - injected.index);
      assert.equal(remnants.every((entry) => BACKUP_RE.test(entry.name)), true);
      assert.equal((await verifyRoot(root)).exitCode, 0, "settlement remnants are internal and committed receipts remain valid");
      const repair = await repairViews(root, accountPartition(scope), clock);
      assert.equal(repair.exitCode, 0);
      assert.deepEqual(await backups(root, scope), []);
      assert.equal((await verifyRoot(root)).exitCode, 0);
      const repaired = await canonicalSnapshot(root, scope);
      sameCanonicalBusinessState(repaired, committed);
      assert.equal(repaired.generation?.canonicalGeneration, (committed.generation?.canonicalGeneration ?? 0) + 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("real SIGKILL after every undo action leaves old canonical truth and repair removes partial views and strict backups", async () => {
  const catalogRoot = await seedRecoveryRoot("rednote-undo-catalog-");
  const actions: ProjectionRecoveryActionPoint[] = [];
  let requested = false;
  try {
    const result = await runUpdate(catalogRoot.root, catalogRoot.scope, {
      projectionBoundaryObserver: async (point) => {
        if (!requested && point.projectorId === "index" && point.phase === "after_projector") {
          requested = true;
          await requestScopePause(catalogRoot.root, catalogRoot.scope);
        }
      },
      projectionRecoveryObserver: (point) => {
        assert.equal(Object.isFrozen(point), true);
        if (point.phase === "after_restore_action") actions.push(point);
      },
    });
    assert.equal(result.exitCode, 7);
    assert.ok(actions.length > 0);
    assert.deepEqual(actions.map((point) => point.index), actions.map((_, index) => index));
    assert.equal(actions.every((point) => point.total === actions.length), true);
    assert.equal(actions.some((point) => point.kind === "created"), true);
    assert.equal(actions.some((point) => point.kind === "replaced"), true);
    assert.equal(actions.some((point) => point.kind === "deleted"), true);
    assert.equal(actions.some((point) => point.relativePath.includes("/.views/")), true);
  } finally {
    await resumeScope(catalogRoot.root, catalogRoot.scope).catch(() => {});
    await rm(catalogRoot.root, { recursive: true, force: true });
  }

  for (const action of actions) {
    const { root, scope } = await seedRecoveryRoot(`rednote-undo-${action.index}-`);
    try {
      const before = await canonicalSnapshot(root, scope);
      const oldBytes = await captureObjectBytes(root, before.refs);
      const key = accountKey(accountPartition(scope));
      const accountJson = path.join(root, `accounts/${key}/account.json`);
      const unchangedBefore = { bytes: await readFile(accountJson), stat: await stat(accountJson) };
      const child = recoveryWorker(root, action.index);
      const ready = await waitForUndo(child);
      assert.deepEqual({ index: ready.index, total: ready.total, kind: ready.kind, relativePath: ready.relativePath }, { index: action.index, total: action.total, kind: action.kind, relativePath: action.relativePath });
      await kill(child);

      const afterKill = await canonicalSnapshot(root, scope);
      assert.deepEqual(afterKill, before, "SIGKILL after SAVEPOINT rewind cannot commit any attempted canonical mutation");
      await assertObjectBytes(root, oldBytes, before.refs);
      const unchangedAfterKill = { bytes: await readFile(accountJson), stat: await stat(accountJson) };
      assert.deepEqual(unchangedAfterKill.bytes, unchangedBefore.bytes);
      assert.equal(unchangedAfterKill.stat.ino, unchangedBefore.stat.ino);
      assert.equal(unchangedAfterKill.stat.mode, unchangedBefore.stat.mode);
      assert.equal(unchangedAfterKill.stat.mtimeMs, unchangedBefore.stat.mtimeMs);

      const remainingBackupActions = actions.slice(action.index + 1).filter((candidate) => candidate.kind !== "created");
      assert.equal((await backups(root, scope)).length, remainingBackupActions.length);
      for (const created of actions.filter((candidate) => candidate.kind === "created")) {
        const target = path.join(root, created.relativePath);
        if (created.index <= action.index) await assert.rejects(stat(target), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
        else assert.equal((await stat(target)).isFile(), true);
      }

      const preRepair = await verifyRoot(root);
      assert.equal(preRepair.exitCode === 0 || preRepair.exitCode === 9, true);
      const repairedResult = await repairViews(root, accountPartition(scope), clock);
      assert.equal(repairedResult.exitCode, 0);
      await resumeScope(root, scope);
      assert.deepEqual(await backups(root, scope), []);
      assert.equal((await verifyRoot(root)).exitCode, 0);
      const repaired = await canonicalSnapshot(root, scope);
      sameCanonicalBusinessState(repaired, before);
      assert.equal(repaired.generation?.canonicalGeneration, (before.generation?.canonicalGeneration ?? 0) + 1);
      for (const created of actions.filter((candidate) => candidate.kind === "created")) {
        await assert.rejects(stat(path.join(root, created.relativePath)), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", "repair must remove an untracked file created by the killed attempt");
      }
      const unchangedAfterRepair = { bytes: await readFile(accountJson), stat: await stat(accountJson) };
      assert.deepEqual(unchangedAfterRepair.bytes, unchangedBefore.bytes);
      assert.equal(unchangedAfterRepair.stat.ino, unchangedBefore.stat.ino);
      assert.equal(unchangedAfterRepair.stat.mode, unchangedBefore.stat.mode);
      assert.equal(unchangedAfterRepair.stat.mtimeMs, unchangedBefore.stat.mtimeMs);
      const noteMarkdown = path.join(root, `accounts/${key}/notes/${noteKey(accountPartition(scope), RECOVERY_NOTE)}.md`);
      assert.match(await readFile(noteMarkdown, "utf8"), /body v1/u);
    } finally {
      await resumeScope(root, scope).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
});
