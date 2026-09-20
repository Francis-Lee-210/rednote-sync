import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = await realpath(process.cwd());
const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
const match = /<!-- offline-demo-smoke:start -->\n```bash\n([\s\S]*?)\n```\n<!-- offline-demo-smoke:end -->/u.exec(readme);
assert.ok(match, "README must contain one marked bash smoke block");
assert.equal(readme.match(/<!-- offline-demo-smoke:start -->/gu)?.length, 1);
assert.equal(readme.match(/<!-- offline-demo-smoke:end -->/gu)?.length, 1);
const shellSource = match[1];
assert.match(shellSource, /DEMO_PARENT="\$\(cd "\$\{TMPDIR:-\/tmp\}" && pwd -P\)"/u);
assert.match(shellSource, /DEMO_ROOT="\$\(cd "\$DEMO_ROOT" && pwd -P\)"/u);

const tempParent = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "rednote-readme-smoke-")));
try {
  const result = spawnSync("/bin/zsh", ["-eu", "-o", "pipefail", "-c", shellSource], {
    cwd: projectRoot,
    env: { ...process.env, TMPDIR: tempParent },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.stderr, "");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 7, "verbatim README smoke must run seven real CLI commands");
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.command), ["validate_input", "init", "sync", "sync", "sync", "status", "verify"]);
  assert.equal(records.every((record) => record.ok === true && record.exitCode === 0), true);
  assert.equal(records[0].result.pageCount, 2);
  const syncResults = records.slice(2, 5).map((record) => record.result);
  assert.equal(syncResults[0].pages, 2, "the first README sync must process both pages despite --limit 1");
  assert.equal(syncResults[0].run.done, 2);
  for (const [index, result] of syncResults.entries()) {
    assert.equal(result.hasMore, false);
    assert.equal(result.run.outcome, "committed", "immediate replays must run rather than return not_due");
    assert.equal(result.run.listed, result.run.done);
    assert.equal(result.run.partial, 0);
    assert.equal(result.run.failed, 0);
    if (index > 0) {
      assert.equal(result.pages, 1, "a replay stops at the known head frontier");
      assert.equal(result.run.done, 1);
    }
  }
  const progress = records[5].result.state.progress;
  assert.equal(progress.phase, "head");
  assert.equal(progress.cursor, null);
  assert.equal(progress.reachedEnd, true);
  assert.equal(records.at(-1).result.accounts, 1);
  assert.equal(records.at(-1).result.warnings.length, 0);

  const entries = await readdir(tempParent, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isDirectory(), true);
  const demoRoot = path.join(tempParent, entries[0].name);
  assert.equal(await realpath(demoRoot), demoRoot, "README root must be a physical canonical absolute path");
  const rootInfo = await lstat(demoRoot);
  assert.equal(rootInfo.mode & 0o777, 0o700);
  const stateInfo = await lstat(path.join(demoRoot, "state", "rednote-sync.sqlite"));
  assert.equal(stateInfo.isFile(), true);
  const accountEntries = await readdir(path.join(demoRoot, "accounts"), { withFileTypes: true });
  assert.equal(accountEntries.length, 1);
  assert.equal(accountEntries[0].isDirectory(), true);
  assert.match(accountEntries[0].name, /^[0-9a-f]{64}$/u);
  const accountRoot = path.join(demoRoot, "accounts", accountEntries[0].name);
  const index = JSON.parse(await readFile(path.join(accountRoot, "data", "index.json"), "utf8"));
  assert.deepEqual(index.map((note) => note.noteId).sort(), ["synthetic-note-alpha", "synthetic-note-beta"], "replays must leave exactly the two imported notes");
  assert.equal((await readdir(path.join(accountRoot, "notes"))).filter((name) => /^[0-9a-f]{64}\.md$/u.test(name)).length, 2);
  assert.equal((await readdir(path.join(accountRoot, "data", "notes"))).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name)).length, 2);
  process.stdout.write(JSON.stringify({ ok: true, shell: "/bin/zsh", commands: records.length, physicalRoot: true }) + "\n");
} finally {
  await rm(tempParent, { recursive: true, force: true });
}
