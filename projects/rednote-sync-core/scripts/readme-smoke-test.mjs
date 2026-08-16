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
  process.stdout.write(JSON.stringify({ ok: true, shell: "/bin/zsh", commands: records.length, physicalRoot: true }) + "\n");
} finally {
  await rm(tempParent, { recursive: true, force: true });
}
