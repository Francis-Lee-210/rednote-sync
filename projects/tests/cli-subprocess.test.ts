import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { makeScope, tempRoot } from "./helpers.ts";
import { fixtureDetail, fixtureFailure, fixturePage, writeStage3bEnvelope } from "./stage3b-fixtures.ts";

interface CliOutput { readonly ok: boolean; readonly command: string | null; readonly exitCode: number; readonly result?: unknown; readonly error?: unknown }

function cli(args: readonly string[]): { readonly status: number; readonly output: CliOutput; readonly stderr: string } {
  const result = spawnSync(process.execPath, [path.resolve("src/bin.js"), ...args], { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 });
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${result.stdout}`);
  const output = JSON.parse(lines[0]!) as CliOutput;
  assert.equal(output.exitCode, result.status);
  return { status: result.status!, output, stderr: result.stderr };
}

const scopedArgs = (root: string, scope: ReturnType<typeof makeScope>) => ["--root", root, "--host", scope.hostId, "--account", scope.accountId, "--target", scope.target, ...(scope.boardId === null ? [] : ["--board-id", scope.boardId])];

test("real CLI dispatches help/version/init/sync/status/verify with one safe JSON line", async () => {
  assert.equal(cli(["--help"]).status, 0);
  assert.equal((cli(["--version"]).output.result as { readonly version: string }).version, "0.0.0-stage3");
  const root = await tempRoot("rednote-cli-real-");
  const scope = makeScope("cli-real-account");
  assert.equal(cli(["init", "--root", root]).status, 0);
  const input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, ["note"])]);
  const sync = cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]);
  assert.equal(sync.status, 0, JSON.stringify({ output: sync.output, stderr: sync.stderr }));
  assert.equal(sync.stderr, "");
  assert.equal(JSON.stringify(sync.output).includes(input), false);
  assert.equal(cli(["status", ...scopedArgs(root, scope)]).status, 0);
  assert.equal(cli(["verify", "--root", root]).status, 0);
  assert.equal(cli(["repair-views", "--root", root, "--host", scope.hostId, "--account", scope.accountId]).status, 0);
});

test("real CLI pause/resume and media partial/task skip use exit 7/9/0", async () => {
  const root = await tempRoot("rednote-cli-pause-");
  const scope = makeScope("cli-pause-account");
  assert.equal(cli(["init", "--root", root]).status, 0);
  const detail = fixtureDetail(scope, "note", { media: [{ kind: "image", ordinal: 1, mediaId: "media", failure: fixtureFailure("MEDIA") }] });
  const input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, ["note"], { details: [detail] })]);
  assert.equal(cli(["pause", ...scopedArgs(root, scope)]).status, 0);
  assert.equal(cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]).status, 7);
  assert.equal(cli(["resume", ...scopedArgs(root, scope)]).status, 0);
  assert.equal(cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]).status, 9);
  assert.equal(cli(["task", "skip", ...scopedArgs(root, scope), "--note-id", "note", "--reason", "known duplicate"]).status, 0);
  assert.equal(cli(["verify", "--root", root]).status, 0);
});

test("real CLI persists AUTH stop, exact acknowledge, and retry-failures performs no list request", async () => {
  const root = await tempRoot("rednote-cli-stop-");
  const scope = makeScope("cli-stop-account");
  assert.equal(cli(["init", "--root", root]).status, 0);
  let input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, [], { listFailure: fixtureFailure("AUTH_REQUIRED") })], [], "fixture", "auth.json");
  assert.equal(cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]).status, 3);
  assert.equal(cli(["acknowledge-stop", ...scopedArgs(root, scope), "--reason", "PROTOCOL"]).status, 0);
  assert.equal(cli(["acknowledge-stop", ...scopedArgs(root, scope), "--reason", "AUTH_REQUIRED"]).status, 0);
  input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, ["retry-note"], { details: [{ noteId: "retry-note", failure: fixtureFailure("DETAIL") }] })], [], "fixture", "detail.json");
  assert.equal(cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]).status, 5);
  input = await writeStage3bEnvelope(root, scope, [], [{ scope, noteId: "retry-note", detail: fixtureDetail(scope, "retry-note", { body: "repaired" }) }], "fixture", "retry.json");
  assert.equal(cli(["retry-failures", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope), "--limit", "1"]).status, 0);
});

test("real CLI rejects forbidden loop/parallel surfaces without reflecting arguments", async () => {
  const root = await tempRoot("rednote-cli-invalid-");
  const result = cli(["sync", "--root", root, "--adapter", "fixture", "--input", "REDNOTE_SECRET_CANARY", "--host", "xhs", "--account", "account", "--target", "liked", "--all", "yes"]);
  assert.equal(result.status, 2);
  assert.doesNotMatch(JSON.stringify(result.output) + result.stderr, /REDNOTE_SECRET_CANARY/u);
});

test("real CLI maps a detail EXPORT persistence blocker to exit 6", async () => {
  const root = await tempRoot("rednote-cli-export-");
  const scope = makeScope("cli-export-account");
  assert.equal(cli(["init", "--root", root]).status, 0);
  const input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, ["note"], { details: [{ noteId: "note", failure: fixtureFailure("EXPORT") }] })]);
  const result = cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]);
  assert.equal(result.status, 6);
  assert.equal((result.output.result as { readonly run: { readonly safeErrorCategory: string } }).run.safeErrorCategory, "EXPORT");
});

test("real CLI consumes every available page in one command and the next import is immediately usable", async () => {
  const root = await tempRoot("rednote-cli-pages-");
  const scope = makeScope("cli-pages-owner");
  assert.equal(cli(["init", "--root", root]).status, 0);
  const firstIds = Array.from({ length: 12 }, (_, index) => `note-${index}`);
  let input = await writeStage3bEnvelope(root, scope, [
    fixturePage(scope, null, firstIds, { hasMore: true, nextCursor: "page-two" }),
    fixturePage(scope, "page-two", ["note-0", "last-note"]),
  ]);
  const first = cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope), "--limit", "1"]);
  assert.equal(first.status, 0);
  assert.deepEqual({
    pages: (first.output.result as { pages: number }).pages,
    hasMore: (first.output.result as { hasMore: boolean }).hasMore,
    done: (first.output.result as { run: { done: number } }).run.done,
  }, { pages: 2, hasMore: false, done: 13 });
  input = await writeStage3bEnvelope(root, scope, [fixturePage(scope, null, ["next-import"])], [], "fixture", "next.json");
  const second = cli(["sync", "--adapter", "fixture", "--input", input, ...scopedArgs(root, scope)]);
  assert.equal(second.status, 0);
  assert.equal((second.output.result as { run: { done: number } }).run.done, 1);
});
