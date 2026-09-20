import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const mode = process.argv[2];
assert.ok(mode === "--check" || mode === "--write", "build mode must be --check or --write");

async function filesBelow(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesBelow(path.join(directory, entry.name), `${relative}/`));
    else {
      assert.ok(entry.isFile(), "dist entries must be regular files or directories");
      result.push(relative);
    }
  }
  return result.sort();
}

async function checkDist(expected, actual) {
  assert.ok((await lstat(actual)).isDirectory(), "dist must be a regular directory");
  const files = await filesBelow(expected);
  assert.deepEqual(await filesBelow(actual), files, "dist inventory differs from compiler output");
  for (const name of files) {
    assert.deepEqual(await readFile(path.join(actual, name)), await readFile(path.join(expected, name)), `${name} differs from compiler output`);
    if (name === "bin.js") assert.ok((await lstat(path.join(actual, name))).mode & 0o111, "CLI bin must be executable");
  }
  return files.length;
}

// Build beside dist so replacing it uses same-filesystem renames. A failed
// compilation never touches the previous output.
const work = await mkdtemp(path.join(root, ".dist-build-"));
const generated = path.join(work, "dist");
try {
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
    "--project", path.join(root, "tsconfig.build.json"),
    "--outDir", generated, "--pretty", "false",
  ], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error("TypeScript compilation failed");
  }
  await chmod(path.join(generated, "bin.js"), 0o755);
  const destination = path.join(root, "dist");
  if (mode === "--check") {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "check", files: await checkDist(generated, destination) })}\n`);
  } else {
    const previous = path.join(work, "previous");
    let hadPrevious = false;
    try {
      assert.ok((await lstat(destination)).isDirectory(), "existing dist must be a regular directory");
      await rename(destination, previous);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(generated, destination);
    } catch (error) {
      if (hadPrevious) await rename(previous, destination);
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "write", files: (await filesBelow(destination)).length })}\n`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
