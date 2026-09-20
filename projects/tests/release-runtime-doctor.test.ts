import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseCliArgs, runCli, type CliDependencies } from "../src/cli.ts";
import { runDoctor } from "../src/doctor.ts";
import { decodeRuntimeSupport, unsupportedRuntimeRecord } from "../src/runtime.js";

test("runtime support decoder is deterministic and does not trust injected version or platform", () => {
  assert.deepEqual(decodeRuntimeSupport({ nodeVersion: "26.7.0", platform: "darwin" }), {
    supported: true, nodeMajor: 26, nodeSupported: true, platformSupported: true, reason: null,
  });
  assert.deepEqual(decodeRuntimeSupport({ nodeVersion: "25.9.0", platform: "darwin" }), {
    supported: false, nodeMajor: 25, nodeSupported: false, platformSupported: true, reason: "UNSUPPORTED_NODE_MAJOR",
  });
  assert.deepEqual(decodeRuntimeSupport({ nodeVersion: "26.0.0", platform: "linux" }), {
    supported: false, nodeMajor: 26, nodeSupported: true, platformSupported: false, reason: "UNSUPPORTED_PLATFORM",
  });
  assert.equal(decodeRuntimeSupport({ nodeVersion: "v26", platform: "darwin" }).reason, "INVALID_NODE_VERSION");
  assert.deepEqual(unsupportedRuntimeRecord(decodeRuntimeSupport({ nodeVersion: "27.0.0", platform: "darwin" })), {
    ok: false, command: null, exitCode: 6, error: { category: "STATE", code: "UNSUPPORTED_NODE_MAJOR" },
  });
});

test("doctor and migrate parsers are exact and rootless doctor accepts no options", () => {
  assert.deepEqual(parseCliArgs(["doctor"]), { command: "doctor" });
  assert.deepEqual(parseCliArgs(["migrate", "--root", "/tmp/rednote-migrate"]), { command: "migrate", root: "/tmp/rednote-migrate" });
  assert.throws(() => parseCliArgs(["doctor", "--root", "/tmp/forbidden"]));
  assert.throws(() => parseCliArgs(["migrate"]));
  assert.throws(() => parseCliArgs(["migrate", "--root", "/tmp/a", "--force", "yes"]));
});

test("rootless doctor performs real local capability probes and aggregates only booleans", async () => {
  const report = await runDoctor();
  assert.equal(report.supported, true);
  assert.deepEqual(Object.values(report.checks), Array(Object.keys(report.checks).length).fill(true));
  assert.deepEqual(Object.keys(report.checks).sort(), [
    "cleanup", "darwin", "directoryFsync", "fileMode0600", "hardlink", "noClobber", "nodeMajor26", "nodeSqlite",
    "oDirectory", "oNofollow", "rootMode0700", "symlinkNofollow", "tempPhysical", "uid",
  ]);
});

test("installed-entry equivalent runs doctor as one safe JSON stdout record", () => {
  const result = spawnSync(process.execPath, [path.resolve("src/bin.js"), "doctor"], { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.deepEqual({ ok: record.ok, command: record.command, exitCode: record.exitCode }, { ok: true, command: "doctor", exitCode: 0 });
  assert.equal(record.result.supported, true);
  assert.equal(Object.values(record.result.checks).every((value) => value === true), true);
});

test("runCli can inject doctor and migrate without touching the filesystem", async () => {
  const calls: string[] = [];
  const dependencies = {
    async doctor() { calls.push("doctor"); return { supported: true }; },
    async migrate(root: string) { calls.push(`migrate:${root.length}`); return { migrated: true }; },
  } as unknown as CliDependencies;
  for (const argv of [["doctor"], ["migrate", "--root", "/tmp/injected"]]) {
    const stdout: string[] = [];
    assert.equal(await runCli(argv, dependencies, { stdout: (line) => stdout.push(line), stderr: () => {} }), 0);
    assert.equal(stdout.length, 1);
  }
  assert.deepEqual(calls, ["doctor", "migrate:13"]);
});
