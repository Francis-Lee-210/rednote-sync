import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs, runCli, type CliDependencies, type CliRequest } from "../src/cli.ts";
import { SafeError } from "../src/errors.ts";

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  const base: CliDependencies = {
    async doctor() { return { supported: true }; },
    async init() { return { initialized: true }; },
    async migrate() { return { migrated: true }; },
    async validateInput() { return { schemaVersion: 1, mode: "fixture", pageCount: 0 }; },
    async sync() { return { exitCode: 0, output: { runId: "sync-run-1" } }; },
    async retryFailures() { return { exitCode: 0, output: { runId: "retry-run-1" } }; },
    async skip() { return { exitCode: 0, output: { runId: "skip-run-1" } }; },
    async acknowledge() { return { exitCode: 0, output: { runId: "ack-run-1" } }; },
    async pause() { return { paused: true }; },
    async resume() { return { paused: false }; },
    async repairViews() { return { exitCode: 0, output: { runId: "repair-run-1" } }; },
    async status() { return { accounts: [] }; },
    async verify() { return { exitCode: 0, output: { accounts: 0, warnings: [] } }; },
  };
  return Object.freeze({ ...base, ...overrides });
}

const ordinary = ["--root", "/tmp/rednote-cli", "--host", "xhs", "--account", "synthetic-account", "--target", "liked"];
const album = ["--root", "/tmp/rednote-cli", "--host", "rednote", "--account", "synthetic-account", "--target", "collected_album", "--board-id", "synthetic-board"];

test("CLI parser accepts every exact command surface and applies the limit default", () => {
  assert.deepEqual(parseCliArgs(["doctor"]), { command: "doctor" });
  assert.deepEqual(parseCliArgs(["init", "--root", "/tmp/rednote-cli"]), { command: "init", root: "/tmp/rednote-cli" });
  assert.deepEqual(parseCliArgs(["migrate", "--root", "/tmp/rednote-cli"]), { command: "migrate", root: "/tmp/rednote-cli" });
  assert.deepEqual(parseCliArgs(["validate-input", "--adapter", "fixture", "--input", "fixtures/page.json", "--host", "xhs", "--account", "synthetic-account"]), {
    command: "validate_input", adapter: "fixture", input: "fixtures/page.json", account: { hostId: "xhs", accountId: "synthetic-account" },
  });
  assert.deepEqual(parseCliArgs(["sync", "--adapter", "fixture", "--input", "fixtures/page.json", ...ordinary]), {
    command: "sync",
    root: "/tmp/rednote-cli",
    adapter: "fixture",
    input: "fixtures/page.json",
    scope: { hostId: "xhs", accountId: "synthetic-account", target: "liked", boardId: null },
    limit: 5,
  });
  assert.deepEqual(parseCliArgs(["retry-failures", ...album, "--adapter", "import-json", "--input", "/tmp/input/retry.json", "--limit", "10"]), {
    command: "retry_failures",
    root: "/tmp/rednote-cli",
    adapter: "import-json",
    input: "/tmp/input/retry.json",
    scope: { hostId: "rednote", accountId: "synthetic-account", target: "collected_album", boardId: "synthetic-board" },
    limit: 10,
  });
  assert.equal((parseCliArgs(["sync", "--adapter", "fixture", "--input", "fixtures/page.json", ...ordinary, "--minimum-interval-ms", "0"]) as Extract<CliRequest, { command: "sync" }>).minimumIntervalMs, 0);
  assert.deepEqual(parseCliArgs(["task", "skip", ...ordinary, "--note-id", "synthetic-note", "--reason", "duplicate note"]), {
    command: "skip",
    root: "/tmp/rednote-cli",
    scope: { hostId: "xhs", accountId: "synthetic-account", target: "liked", boardId: null },
    noteId: "synthetic-note",
    reason: "duplicate note",
  });
  assert.equal(parseCliArgs(["acknowledge-stop", ...ordinary, "--reason", "AUTH_REQUIRED"]).command, "ack");
  assert.equal(parseCliArgs(["pause", ...album]).command, "pause");
  assert.equal(parseCliArgs(["resume", ...ordinary]).command, "resume");
  assert.deepEqual(parseCliArgs(["repair-views", "--root", "/tmp/rednote-cli", "--host", "xhs", "--account", "synthetic-account"]), {
    command: "repair_views",
    root: "/tmp/rednote-cli",
    account: { hostId: "xhs", accountId: "synthetic-account" },
  });
  assert.deepEqual(parseCliArgs(["status", "--root", "/tmp/rednote-cli"]), { command: "status", root: "/tmp/rednote-cli" });
  assert.equal((parseCliArgs(["status", ...album]) as Extract<CliRequest, { command: "status" }>).scope?.boardId, "synthetic-board");
  assert.deepEqual(parseCliArgs(["verify", "--root", "/tmp/rednote-cli"]), { command: "verify", root: "/tmp/rednote-cli" });
  assert.deepEqual(parseCliArgs(["--help"]), { command: "help" });
  assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
});

test("CLI rejects duplicate, extra, flag-equals, missing, positional, all, and invalid limit forms", () => {
  const invalid = [
    ["init", "--root", "/tmp/a", "--root", "/tmp/b"],
    ["init", "--root=/tmp/a"],
    ["init", "--root"],
    ["verify", "--root", "/tmp/a", "surplus"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--all", "yes"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--limit", "0"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--limit", "11"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--limit", "01"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--minimum-interval-ms", "86400001"],
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--minimum-interval-ms", "-1"],
    ["retry-failures", "--adapter", "fixture", "--input", "page.json", ...ordinary, "--minimum-interval-ms", "0"],
    ["validate-input", "--adapter", "fixture", "--input", "page.json", "--host", "xhs", "--account", "synthetic-account", "--root", "/tmp/forbidden"],
    ["sync", "--adapter", "browser", "--input", "page.json", ...ordinary],
    ["task", "remove", ...ordinary],
    ["--help", "extra"],
    [],
  ];
  for (const argv of invalid) assert.throws(() => parseCliArgs(argv), (error: unknown) => error instanceof SafeError && error.code === "INVALID_INPUT", argv.join(" "));
});

test("album scopes require board, ordinary scopes forbid board, and status scope cannot be partial", () => {
  assert.throws(() => parseCliArgs(["pause", ...ordinary, "--board-id", "forbidden"]), SafeError);
  assert.throws(() => parseCliArgs(["pause", "--root", "/tmp/rednote-cli", "--host", "xhs", "--account", "synthetic-account", "--target", "collected_album"]), SafeError);
  assert.throws(() => parseCliArgs(["status", "--root", "/tmp/rednote-cli", "--host", "xhs"]), SafeError);
  assert.throws(() => parseCliArgs(["repair-views", "--root", "/tmp/rednote-cli", "--host", "xhs", "--account", "synthetic-account", "--board-id", "extra"]), SafeError);
});

test("skip reason uses the 1..80 Unicode safe-text contract", () => {
  assert.equal((parseCliArgs(["task", "skip", ...ordinary, "--note-id", "note", "--reason", ` ${"界".repeat(80)} `]) as Extract<CliRequest, { command: "skip" }>).reason, "界".repeat(80));
  for (const reason of ["", "界".repeat(81), "https://fixture.invalid/n", "token=value", "has&join", "has%escape", "abc1234567890123456"]) {
    assert.throws(() => parseCliArgs(["task", "skip", ...ordinary, "--note-id", "note", "--reason", reason]), SafeError);
  }
});

test("runCli dispatches one command and writes exactly one safe JSON stdout line", async () => {
  const calls: CliRequest[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["sync", "--adapter", "fixture", "--input", "page.json", ...ordinary],
    dependencies({ async sync(request) { calls.push(request); return { exitCode: 9, output: { runId: "sync-run-9", outcome: "committed_with_warnings" } }; } }),
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );
  assert.equal(exitCode, 9);
  assert.equal(calls.length, 1);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]!), { ok: false, command: "sync", exitCode: 9, result: { runId: "sync-run-9", outcome: "committed_with_warnings" } });
  assert.equal(stdout[0]!.includes("page.json"), false, "CLI input path is not reflected to output");
});

test("help and version are self-contained JSON commands", async () => {
  for (const argv of [["--help"], ["--version"]]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(argv, dependencies({
      async init() { throw new Error("dependency must not run"); },
    }), { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    assert.equal(exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 0);
    assert.equal(JSON.parse(stdout[0]!).ok, true);
  }
});

test("safe failures map to exit 0..9 contract without reflecting arguments or secrets", async () => {
  const cases: Array<{ readonly error: unknown; readonly exitCode: number }> = [
    { error: new SafeError("INVALID_INPUT", "invalid request"), exitCode: 2 },
    { error: { category: "AUTH_REQUIRED" }, exitCode: 3 },
    { error: { category: "RATE_LIMITED" }, exitCode: 4 },
    { error: { category: "DETAIL" }, exitCode: 5 },
    { error: new SafeError("STATE", "state unavailable"), exitCode: 6 },
    { error: { category: "PAUSED" }, exitCode: 7 },
    { error: new SafeError("BUSY", "writer busy"), exitCode: 8 },
    { error: new SafeError("DERIVED_VIEW", "view stale"), exitCode: 9 },
    { error: new Error("raw-internal-canary-12345"), exitCode: 1 },
  ];
  for (const entry of cases) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["verify", "--root", "/tmp/rednote-cli"], dependencies({ async verify() { throw entry.error; } }), { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    assert.equal(exitCode, entry.exitCode);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.equal(JSON.parse(stdout[0]!).exitCode, entry.exitCode);
    assert.equal(`${stdout[0]}${stderr[0]}`.includes("raw-internal-canary-12345"), false);
    assert.equal(`${stdout[0]}${stderr[0]}`.includes("/tmp/rednote-cli"), false);
  }
});

test("unsafe dependency output is converted to a scanner-safe persistence failure", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(["status", "--root", "/tmp/rednote-cli"], dependencies({ async status() { return { note: "REDNOTE_SECRET_CANARY" }; } }), { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
  assert.equal(exitCode, 6);
  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 1);
  assert.doesNotMatch(`${stdout[0]}${stderr[0]}`, /REDNOTE_SECRET_CANARY/u);
  assert.equal(JSON.parse(stdout[0]!).error.category, "STATE");
});
