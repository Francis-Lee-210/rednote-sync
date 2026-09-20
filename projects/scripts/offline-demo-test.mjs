import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = await realpath(process.cwd());
const cliFile = path.join(projectRoot, "src", "bin.js");
const examples = path.join(projectRoot, "examples", "offline-v1");
const tempParent = await realpath(tmpdir());
const demoRoot = await realpath(await mkdtemp(path.join(tempParent, "rednote-offline-demo-")));
assert.ok(demoRoot.startsWith(`${tempParent}${path.sep}`), "demo root must be an owned mkdtemp child");

const readOnlyPermission = ["--permission", "--allow-fs-read=/"];
const writerPermission = [...readOnlyPermission, `--allow-fs-write=${demoRoot}`];

function runNode(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedStatus, JSON.stringify({ args: args.slice(-4), stdout: result.stdout, stderr: result.stderr }));
  return result;
}

function runCli(args, expectedStatus = 0, readOnly = false) {
  const result = runNode([...(readOnly ? readOnlyPermission : writerPermission), cliFile, ...args], expectedStatus);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, `CLI stdout must be exactly one JSON line: ${result.stdout}`);
  const output = JSON.parse(lines[0]);
  assert.equal(output.exitCode, expectedStatus);
  assert.equal(output.ok, expectedStatus === 0);
  return { output, stderr: result.stderr };
}

async function filesBelow(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

function isStableUserView(relative) {
  return relative === "account.json"
    || relative === "data/index.json"
    || relative === "data/index.csv"
    || /^notes\/[0-9a-f]{64}\.md$/u.test(relative)
    || /^data\/notes\/[0-9a-f]{64}\.json$/u.test(relative)
    || /^assets\/[0-9a-f]{64}\/(?:cover|image|video)-[1-9][0-9]*\.(?:png|jpg|gif|webp|mp4|bin)$/u.test(relative);
}

async function stableSnapshot(accountRoot) {
  const output = [];
  for (const relative of (await filesBelow(accountRoot)).filter(isStableUserView)) {
    const target = path.join(accountRoot, relative);
    const [bytes, info] = await Promise.all([readFile(target), stat(target, { bigint: true })]);
    output.push({ relative, hex: bytes.toString("hex"), mtimeNs: info.mtimeNs.toString() });
  }
  return output;
}

const scopeArgs = (target, account = "synthetic-demo-account") => ["--host", "xhs", "--account", account, "--target", target];
const inputArgs = (name, mode = "fixture") => ["--adapter", mode, "--input", path.join(examples, name)];
const syncArgs = (name, target, mode = "fixture", account = "synthetic-demo-account") => ["sync", "--root", demoRoot, ...inputArgs(name, mode), ...scopeArgs(target, account)];

function assertCompletedSync(result, pages, done) {
  assert.equal(result.pages, pages);
  assert.equal(result.hasMore, false);
  assert.equal(result.run.outcome, "committed");
  assert.equal(result.run.listed, done);
  assert.equal(result.run.done, done);
  assert.equal(result.run.partial, 0);
  assert.equal(result.run.failed, 0);
}

function assertDurableProgress(target, expected, account = "synthetic-demo-account") {
  const status = runCli(["status", "--root", demoRoot, ...scopeArgs(target, account)]).output.result;
  assert.deepEqual(status.scope, { hostId: "xhs", accountId: account, target, boardId: null });
  assert.notEqual(status.state, null);
  assert.equal(status.state.progress.phase, expected.phase);
  assert.equal(status.state.progress.cursor, expected.cursor);
  assert.equal(status.state.progress.reachedEnd, expected.reachedEnd);
  return status;
}

try {
  const permissionProbe = runNode([...readOnlyPermission, "-e", "if (process.permission.has('net') || process.permission.has('fs.write')) process.exit(1)"]);
  assert.equal(permissionProbe.stdout, "");

  const fixtureValidation = runCli(["validate-input", ...inputArgs("no-media-success.json"), "--host", "xhs", "--account", "synthetic-demo-account"], 0, true).output;
  assert.deepEqual(fixtureValidation.result, {
    schemaVersion: 1, mode: "fixture", pageCount: 2, pageItemCount: 2, detailSuccessCount: 2,
    retryItemCount: 0, retrySuccessCount: 0, mediaSlotCount: 0, declaredFailureCount: 0, mediaFailureCount: 0,
  });
  const serializedValidation = JSON.stringify(fixtureValidation);
  for (const forbidden of [examples, "synthetic-demo-account", "synthetic-note-alpha", "This is an offline synthetic note."]) {
    assert.equal(serializedValidation.includes(forbidden), false, "validation summary must not reflect path, ID, or body");
  }
  const importValidation = runCli([
    "validate-input", "--adapter", "import-json", "--input", path.join(examples, "import-json-success.json"),
    "--host", "xhs", "--account", "synthetic-import-account",
  ], 0, true).output;
  assert.equal(importValidation.result.mode, "import-json");
  assert.equal((await filesBelow(demoRoot)).length, 0, "read-only validation must not create root or SQLite content");

  runCli(["init", "--root", demoRoot]);
  const firstSync = runCli([...syncArgs("no-media-success.json", "liked"), "--limit", "1"]).output.result;
  assertCompletedSync(firstSync, 2, 2);
  assertDurableProgress("liked", { phase: "head", cursor: null, reachedEnd: true });
  const accountEntries = await readdir(path.join(demoRoot, "accounts"), { withFileTypes: true });
  assert.equal(accountEntries.length, 1);
  assert.equal(accountEntries[0].isDirectory(), true);
  assert.match(accountEntries[0].name, /^[0-9a-f]{64}$/u);
  const accountRoot = path.join(demoRoot, "accounts", accountEntries[0].name);
  const beforePageReplay = await stableSnapshot(accountRoot);
  assert.equal(beforePageReplay.filter(({ relative }) => /^notes\/[0-9a-f]{64}\.md$/u.test(relative)).length, 2, "the first sync must project both pages");
  for (let replay = 0; replay < 2; replay += 1) {
    const result = runCli([...syncArgs("no-media-success.json", "liked"), "--limit", "1"]).output.result;
    assertCompletedSync(result, 1, 1);
    assertDurableProgress("liked", { phase: "head", cursor: null, reachedEnd: true });
    assert.deepEqual(await stableSnapshot(accountRoot), beforePageReplay, "an immediate replay at the default interval must preserve stable bytes and mtimes");
  }

  assertCompletedSync(runCli(syncArgs("media-success.json", "collected")).output.result, 1, 1);
  assertDurableProgress("collected", { phase: "head", cursor: null, reachedEnd: true });
  const beforeMediaReplay = await stableSnapshot(accountRoot);
  assertCompletedSync(runCli(syncArgs("media-success.json", "collected")).output.result, 1, 1);
  assertDurableProgress("collected", { phase: "head", cursor: null, reachedEnd: true });
  assert.deepEqual(await stableSnapshot(accountRoot), beforeMediaReplay, "media replay must preserve stable bytes and mtimes");

  const failed = runCli(syncArgs("failure.json", "posted"), 5).output.result;
  assert.equal(failed.pages, 1);
  assert.equal(failed.hasMore, false, "a failed detail must not discard the completed list checkpoint");
  assert.equal(failed.run.failed, 1);
  assert.equal(failed.run.safeErrorCategory, "DETAIL");
  assertDurableProgress("posted", { phase: "head", cursor: null, reachedEnd: true });
  const retried = runCli(["retry-failures", "--root", demoRoot, ...inputArgs("retry-success.json"), ...scopeArgs("posted")]).output.result;
  assertCompletedSync(retried, 0, 1);
  assertDurableProgress("posted", { phase: "head", cursor: null, reachedEnd: true });

  assertCompletedSync(runCli(syncArgs("import-json-success.json", "liked", "import-json", "synthetic-import-account")).output.result, 1, 1);
  assertDurableProgress("liked", { phase: "head", cursor: null, reachedEnd: true }, "synthetic-import-account");
  const globalStatus = runCli(["status", "--root", demoRoot]).output.result;
  assert.equal(globalStatus.accounts.length, 2);
  assert.equal(globalStatus.accounts.every((entry) => entry.viewsDirty === false), true);
  const verification = runCli(["verify", "--root", demoRoot]).output.result;
  assert.equal(verification.exitCode, 0);
  assert.equal(verification.accounts, 2);
  assert.deepEqual(verification.warnings, []);

  const projected = await filesBelow(accountRoot);
  const markdown = projected.filter((name) => /^notes\/[0-9a-f]{64}\.md$/u.test(name));
  const noteJson = projected.filter((name) => /^data\/notes\/[0-9a-f]{64}\.json$/u.test(name));
  const media = projected.filter((name) => /^assets\/[0-9a-f]{64}\/image-1\.gif$/u.test(name));
  assert.equal(markdown.length, 4);
  assert.equal(noteJson.length, 4);
  assert.equal(media.length, 1);
  for (const relative of markdown) assert.match(await readFile(path.join(accountRoot, relative), "utf8"), /^---\n/u);
  for (const relative of noteJson) {
    const text = await readFile(path.join(accountRoot, relative), "utf8");
    assert.doesNotThrow(() => JSON.parse(text));
  }
  const index = JSON.parse(await readFile(path.join(accountRoot, "data", "index.json"), "utf8"));
  assert.equal(index.length, 4);
  assert.deepEqual(await readFile(path.join(accountRoot, media[0])), await readFile(path.join(examples, "media", "synthetic.gif")));
  assert.deepEqual(JSON.parse(await readFile(path.join(accountRoot, "data", "failures.json"), "utf8")), []);

  process.stdout.write(JSON.stringify({ ok: true, networkPermission: false, commands: 21, accounts: 2, notes: markdown.length, media: media.length, warnings: 0 }) + "\n");
} finally {
  await rm(demoRoot, { recursive: true, force: true });
}
