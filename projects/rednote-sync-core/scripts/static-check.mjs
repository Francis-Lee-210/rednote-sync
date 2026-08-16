import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertStaticModulePolicy } from "./module-import-policy.mjs";
import { assertReleasePackagePolicy, FORBIDDEN_PACKAGE_PATH } from "./release-package-policy.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assertReleasePackagePolicy(packageJson);
const sourceDirectory = path.join(root, "src");
const testDirectory = path.join(root, "tests");
const sourceFiles = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".ts")).sort();
const sourceJavaScriptFiles = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".js")).sort();
const distDirectory = path.join(root, "dist");
const distFiles = (await readdir(distDirectory)).filter((name) => name.endsWith(".js")).sort();
const testFiles = (await readdir(testDirectory)).filter((name) => name.endsWith(".ts")).sort();
const scriptFiles = (await readdir(path.join(root, "scripts"))).filter((name) => name.endsWith(".mjs")).sort();
assert.ok(sourceFiles.length >= 22, "all stage-3 source files must be included");
assert.deepEqual(sourceJavaScriptFiles, ["bin.js", "runtime.js"], "only the runtime-gated JavaScript entry modules are allowed");
assert.ok(testFiles.length > 0, "at least one explicit node:test file is required");
for (const relative of packageJson.files) {
  assert.equal(typeof relative, "string");
  assert.doesNotMatch(relative, FORBIDDEN_PACKAGE_PATH, "forbidden package path");
  assert.doesNotMatch(relative, /[*?{}[\]]/u, "package files allowlist cannot contain globs");
}

for (const file of [
  ...sourceFiles.map((name) => path.join(sourceDirectory, name)),
  ...sourceJavaScriptFiles.map((name) => path.join(sourceDirectory, name)),
  ...distFiles.map((name) => path.join(distDirectory, name)),
  ...testFiles.map((name) => path.join(testDirectory, name)),
  ...scriptFiles.map((name) => path.join(root, "scripts", name)),
]) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${path.relative(root, file)} failed node --check:\n${result.stderr}`);
}

const forbiddenRuntime = /\b(?:enum|namespace)\s+[A-Za-z_$]|constructor\([^)]*\b(?:public|private|protected|readonly)\s+/;
const forbiddenCredentials = /prototypes\/(?:test-cookie\.txt|xsec_token\.txt)/;
const scannedFiles = [
  ...sourceFiles.map((name) => path.join(sourceDirectory, name)),
  ...sourceJavaScriptFiles.map((name) => path.join(sourceDirectory, name)),
  ...distFiles.map((name) => path.join(distDirectory, name)),
  ...testFiles.map((name) => path.join(testDirectory, name)),
  ...scriptFiles.filter((name) => name !== "static-check.mjs").map((name) => path.join(root, "scripts", name)),
];
for (const file of scannedFiles) {
  const text = await readFile(file, "utf8");
  assertStaticModulePolicy(text, file);
  assert.doesNotMatch(text, /\bfetch\s*\(/, `${file}: fetch is forbidden`);
  assert.doesNotMatch(text, forbiddenCredentials, `${file}: credential fixture path is forbidden`);
}
for (const file of sourceFiles) {
  const text = await readFile(path.join(sourceDirectory, file), "utf8");
  assert.doesNotMatch(text, forbiddenRuntime, `${file}: non-erasable TypeScript syntax is forbidden`);
  assert.doesNotMatch(text, /\bpath\.(?:join|resolve)\([^\n]*(?:noteId|accountId|boardId)/, `${file}: raw identifiers cannot form disk paths`);
  assert.doesNotMatch(text, /decodeServerCursor\([^\n]*noteId/, `${file}: note identifiers cannot become response cursors`);
  if (file !== "types.ts") assert.doesNotMatch(text, /\bas\s+ServerCursor\b/, `${file}: response cursor casts are forbidden outside the decoder`);
}
const cliSource = await readFile(path.join(sourceDirectory, "cli.ts"), "utf8");
assert.match(cliSource, /CLI_VERSION\s*=\s*"0\.0\.0-stage3"/, "CLI and package versions must match");
const binSource = await readFile(path.join(sourceDirectory, "bin.js"), "utf8");
assert.match(binSource, /^#!\/usr\/bin\/env node\n/, "CLI bin needs a portable node shebang");
assert.match(binSource, /currentRuntimeSupport\(\)/u, "CLI bin must gate the runtime before loading TypeScript modules");
assert.match(binSource, /await import\("\.\/cli\.ts"\)/u, "CLI bin must dynamically load the real CLI after the gate");
process.stdout.write(JSON.stringify({ ok: true, sourceFiles: sourceFiles.length + sourceJavaScriptFiles.length, testFiles: testFiles.length, scriptFiles: scriptFiles.length }) + "\n");
