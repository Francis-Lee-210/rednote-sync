import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolPath = path.join(testDirectory, "extract_notion_background.mjs");
const fixtureSource = path.resolve(
  testDirectory,
  "../targets/rednote2notion/samples/static/background/index.js",
);

function createFixture(t) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "extract-notion-background-test-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryDirectory, "index.js");
  fs.copyFileSync(fixtureSource, sourcePath);
  return { temporaryDirectory, sourcePath, originalSource: fs.readFileSync(sourcePath) };
}

function runTool(...arguments_) {
  return spawnSync(process.execPath, [toolPath, ...arguments_], { encoding: "utf8" });
}

function assertRejected(result, pattern) {
  assert.notEqual(result.status, 0, `tool unexpectedly succeeded: ${result.stdout}`);
  assert.match(result.stderr, pattern);
}

test("indexes the locked sample without modifying it", (t) => {
  const fixture = createFixture(t);
  const indexPath = path.join(fixture.temporaryDirectory, "modules.tsv");
  const dumpPath = path.join(fixture.temporaryDirectory, "modules.txt");
  const result = runTool(fixture.sourcePath, indexPath, dumpPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /indexed \d+ Parcel modules/);
  const index = fs.readFileSync(indexPath, "utf8");
  assert.match(index, /^id\tstart_byte\tend_byte_exclusive\tbytes\tlabels\n/);
  assert.match(index, /~background\/api\/rednote-api/);
  const rows = index.trimEnd().split("\n").slice(1);
  assert.equal(rows.length, 199);
  for (const row of rows) {
    const [, start, end, bytes] = row.split("\t");
    assert.equal(Number(end) - Number(start), Number(bytes));
  }
  assert.equal(Number(rows.at(-1).split("\t")[2]), fixture.originalSource.length);
  const dump = fs.readFileSync(dumpPath, "utf8");
  assert.match(dump, /===== MODULE 98TGD/);
  assert.equal(dump.match(/^===== MODULE /gm)?.length, 199);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects source/output path and inode collisions", (t) => {
  const fixture = createFixture(t);
  const samePath = runTool(fixture.sourcePath, fixture.sourcePath);
  assertRejected(samePath, /Path collision/);

  const hardLinkPath = path.join(fixture.temporaryDirectory, "hard-link.tsv");
  fs.linkSync(fixture.sourcePath, hardLinkPath);
  const hardLink = runTool(fixture.sourcePath, hardLinkPath);
  assertRejected(hardLink, /Path collision/);

  const symlinkPath = path.join(fixture.temporaryDirectory, "source-link.tsv");
  fs.symlinkSync(fixture.sourcePath, symlinkPath);
  const symlink = runTool(fixture.sourcePath, symlinkPath);
  assertRejected(symlink, /Path collision/);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), fixture.originalSource);
});

test("rejects colliding outputs", (t) => {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.temporaryDirectory, "same-output.txt");
  const result = runTool(fixture.sourcePath, outputPath, outputPath);

  assertRejected(result, /Path collision/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("rejects differently-cased nonexistent outputs on a case-insensitive filesystem", (t) => {
  const fixture = createFixture(t);
  const probePath = path.join(fixture.temporaryDirectory, "CaseSensitivityProbe");
  const foldedProbePath = path.join(fixture.temporaryDirectory, "casesensitivityprobe");
  fs.writeFileSync(probePath, "probe", "utf8");
  if (!fs.existsSync(foldedProbePath)) {
    t.skip("temporary directory is on a case-sensitive filesystem");
    return;
  }

  const upperOutput = path.join(fixture.temporaryDirectory, "Modules.tsv");
  const lowerOutput = path.join(fixture.temporaryDirectory, "modules.tsv");
  const result = runTool(fixture.sourcePath, upperOutput, lowerOutput);

  assertRejected(result, /Path collision/);
  assert.equal(fs.existsSync(upperOutput), false);
  assert.equal(fs.existsSync(lowerOutput), false);
});

test("rejects an unsupported hash before creating output", (t) => {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.temporaryDirectory, "modules.tsv");
  fs.appendFileSync(fixture.sourcePath, "\n");
  const result = runTool(fixture.sourcePath, outputPath);

  assertRejected(result, /Unsupported source SHA-256/);
  assert.equal(fs.existsSync(outputPath), false);
});
