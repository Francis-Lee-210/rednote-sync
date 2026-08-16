import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { rewriteRelativeTypeScriptSpecifiers } from "./typescript-specifier-transform.mjs";

const SOURCE_FILES = Object.freeze([
  "bin.js", "canonical.ts", "cli.ts", "commands.ts", "control.ts", "doctor.ts", "errors.ts", "exporters.ts", "host-adapter.ts", "index.ts",
  "merge.ts", "object-store.ts", "offline-input.ts", "paths.ts", "private-access.ts", "progress.ts", "projectors.ts", "rank.ts", "runtime.js",
  "secrets.ts", "state-store.ts", "sync-engine.ts", "types.ts", "verify.ts", "view-types.ts",
]);

function outputName(source) {
  return source.endsWith(".ts") ? `${source.slice(0, -3)}.js` : source;
}

async function readNoFollow(target) {
  const before = await lstat(target);
  assert.equal(before.isFile() && !before.isSymbolicLink(), true, "build source must be a regular file");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    assert.equal(after.dev === before.dev && after.ino === before.ino, true, "build source identity changed");
    return handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function transform(source, name) {
  const stripped = name.endsWith(".ts") ? stripTypeScriptTypes(source, { mode: "strip", sourceMap: false }) : source;
  return rewriteRelativeTypeScriptSpecifiers(stripped);
}

async function generate(sourceRoot, destination) {
  await mkdir(destination, { mode: 0o700 });
  for (const name of SOURCE_FILES) {
    const bytes = transform(await readNoFollow(path.join(sourceRoot, name)), name);
    const output = path.join(destination, outputName(name));
    const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, name === "bin.js" ? 0o755 : 0o644);
    try {
      await handle.writeFile(bytes, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(output, name === "bin.js" ? 0o755 : 0o644);
  }
}

async function compareDist(expected, actual) {
  const expectedNames = SOURCE_FILES.map(outputName).sort();
  const actualInfo = await lstat(actual);
  assert.equal(actualInfo.isDirectory() && !actualInfo.isSymbolicLink(), true, "dist must be a regular directory");
  assert.deepEqual((await readdir(actual)).sort(), expectedNames, "dist inventory must be exact");
  for (const name of expectedNames) {
    const [wanted, current] = await Promise.all([readNoFollow(path.join(expected, name)), readNoFollow(path.join(actual, name))]);
    assert.equal(current, wanted, `${name} must match the reproducible Node strip output`);
    const mode = (await lstat(path.join(actual, name))).mode & 0o777;
    assert.equal(mode, name === "bin.js" ? 0o755 : 0o644, `${name} mode mismatch`);
  }
  return expectedNames.length;
}

async function main() {
  const root = await realpath(process.cwd());
  const sourceRoot = path.join(root, "src");
  assert.deepEqual((await readdir(sourceRoot)).filter((name) => /\.(?:ts|js)$/u.test(name)).sort(), [...SOURCE_FILES].sort(), "source build inventory must be exact");
  const mode = process.argv[2];
  assert.equal(mode === "--check" || mode === "--write", true, "build mode must be --check or --write");
  const temporary = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "rednote-dist-build-")));
  const generated = path.join(temporary, "dist");
  try {
    await generate(sourceRoot, generated);
    if (mode === "--check") {
      const files = await compareDist(generated, path.join(root, "dist"));
      process.stdout.write(`${JSON.stringify({ ok: true, mode: "check", files })}\n`);
      return;
    }
    const destination = path.join(root, "dist");
    const prior = path.join(root, ".dist-prior-stage3c3");
    await lstat(prior).then(() => assert.fail("stale dist backup exists"), (error) => assert.equal(error.code, "ENOENT"));
    let hadPrior = false;
    try {
      const info = await lstat(destination);
      assert.equal(info.isDirectory() && !info.isSymbolicLink(), true, "existing dist must be a regular directory");
      await rename(destination, prior);
      hadPrior = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(generated, destination);
      const files = await compareDist(destination, destination);
      if (hadPrior) await rm(prior, { recursive: true, force: false });
      process.stdout.write(`${JSON.stringify({ ok: true, mode: "write", files })}\n`);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (hadPrior) await rename(prior, destination);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
