import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolPath = path.join(testDirectory, "extract_obsidian_strings.mjs");
const fixtureSource = path.resolve(
  testDirectory,
  "../targets/rednote2obsidian/samples/main.js",
);

function createFixture(t) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "extract-obsidian-strings-test-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryDirectory, "main.js");
  fs.copyFileSync(fixtureSource, sourcePath);
  return { temporaryDirectory, sourcePath, originalSource: fs.readFileSync(sourcePath) };
}

function runTool(...arguments_) {
  return spawnSync(process.execPath, [toolPath, ...arguments_], {
    encoding: "utf8",
  });
}

function assertRejected(result, pattern) {
  assert.notEqual(result.status, 0, `tool unexpectedly succeeded: ${result.stdout}`);
  assert.match(result.stderr, pattern);
}

function isCaseInsensitive(directory) {
  const lowercasePath = path.join(directory, "case-sensitivity-probe-a");
  const uppercasePath = path.join(directory, "CASE-SENSITIVITY-PROBE-A");
  fs.writeFileSync(lowercasePath, "probe\n");
  try {
    return fs.existsSync(uppercasePath);
  } finally {
    fs.unlinkSync(lowercasePath);
  }
}

test("rejects source and output resolving to the same path", (t) => {
  const fixture = createFixture(t);
  const result = runTool(fixture.sourcePath, fixture.sourcePath);

  assertRejected(result, /Path collision/);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects identical strings and deobfuscated output paths", (t) => {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.temporaryDirectory, "same-output.txt");
  const result = runTool(fixture.sourcePath, outputPath, outputPath);

  assertRejected(result, /Path collision/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects differently cased output paths on a case-insensitive filesystem", (t) => {
  const fixture = createFixture(t);
  if (!isCaseInsensitive(fixture.temporaryDirectory)) {
    t.skip("temporary filesystem is case-sensitive");
    return;
  }

  const stringsPath = path.join(fixture.temporaryDirectory, "case-output.tsv");
  const deobfuscatedPath = path.join(fixture.temporaryDirectory, "CASE-OUTPUT.TSV");
  const result = runTool(fixture.sourcePath, stringsPath, deobfuscatedPath);

  assertRejected(result, /Path collision/);
  assert.equal(fs.existsSync(stringsPath), false);
  assert.equal(fs.existsSync(deobfuscatedPath), false);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects existing hard-linked output paths", (t) => {
  const fixture = createFixture(t);
  const stringsPath = path.join(fixture.temporaryDirectory, "strings.tsv");
  const deobfuscatedPath = path.join(fixture.temporaryDirectory, "deobfuscated.js");
  fs.writeFileSync(stringsPath, "preserve-hardlink\n");
  fs.linkSync(stringsPath, deobfuscatedPath);

  const result = runTool(fixture.sourcePath, stringsPath, deobfuscatedPath);

  assertRejected(result, /Path collision/);
  assert.equal(fs.readFileSync(stringsPath, "utf8"), "preserve-hardlink\n");
  assert.equal(fs.readFileSync(deobfuscatedPath, "utf8"), "preserve-hardlink\n");
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects an output hard link to the source", (t) => {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.temporaryDirectory, "source-hardlink.tsv");
  fs.linkSync(fixture.sourcePath, outputPath);

  const result = runTool(fixture.sourcePath, outputPath);

  assertRejected(result, /Path collision/);
  assert.deepEqual(fs.readFileSync(outputPath), fixture.originalSource);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects an output symlink that resolves to the source", (t) => {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.temporaryDirectory, "source-link.tsv");
  fs.symlinkSync(fixture.sourcePath, outputPath);

  const result = runTool(fixture.sourcePath, outputPath);

  assertRejected(result, /Path collision/);
  assert.equal(fs.realpathSync(outputPath), fs.realpathSync(fixture.sourcePath));
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("writes both outputs successfully through same-directory temporary files", (t) => {
  const fixture = createFixture(t);
  const stringsPath = path.join(fixture.temporaryDirectory, "strings.tsv");
  const deobfuscatedPath = path.join(fixture.temporaryDirectory, "deobfuscated.js");

  const result = runTool(fixture.sourcePath, stringsPath, deobfuscatedPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /decoded 1436 strings/);
  assert.match(fs.readFileSync(stringsPath, "utf8"), /^index\tvalue\n0xc4\t/);
  assert.match(fs.readFileSync(deobfuscatedPath, "utf8"), /RednoteAPI=class/);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
  assert.deepEqual(
    fs.readdirSync(fixture.temporaryDirectory).sort(),
    ["deobfuscated.js", "main.js", "strings.tsv"],
  );
});

test("rejects an unsupported source hash before creating outputs", (t) => {
  const fixture = createFixture(t);
  const stringsPath = path.join(fixture.temporaryDirectory, "strings.tsv");
  fs.appendFileSync(fixture.sourcePath, "\n");

  const result = runTool(fixture.sourcePath, stringsPath);

  assertRejected(result, /Unsupported source SHA-256/);
  assert.equal(fs.existsSync(stringsPath), false);
});
