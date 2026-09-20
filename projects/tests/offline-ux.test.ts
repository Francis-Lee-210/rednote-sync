import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FixtureSession, type OfflineInputMode } from "../src/offline-input.ts";
import { validateJsonSchema } from "../scripts/json-schema-contract.mjs";

const projectRoot = path.resolve(".");
const examplesRoot = path.join(projectRoot, "examples", "offline-v1");

function validateCli(file: string, mode: OfflineInputMode, account: string) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "src", "cli.ts"), "validate-input", "--adapter", mode, "--input", file, "--host", "xhs", "--account", account], {
    cwd: projectRoot, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  return { status: result.status, output: JSON.parse(lines[0]!), stderr: result.stderr };
}

test("checked-in offline-input-v1 schema and every synthetic envelope parse", async () => {
  const schema = JSON.parse(await readFile(path.join(projectRoot, "schemas", "offline-input-v1.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.$comment, /runtime decoder is authoritative/u);
  const cases = [
    ["no-media-success.json", "fixture", "synthetic-demo-account"],
    ["media-success.json", "fixture", "synthetic-demo-account"],
    ["failure.json", "fixture", "synthetic-demo-account"],
    ["retry-success.json", "fixture", "synthetic-demo-account"],
    ["import-json-success.json", "import-json", "synthetic-import-account"],
  ] as const;
  for (const [file, mode, accountId] of cases) {
    const example = JSON.parse(await readFile(path.join(examplesRoot, file), "utf8"));
    const schemaResult = validateJsonSchema(schema, example);
    assert.equal(schemaResult.valid, true, `${file}: ${schemaResult.errors.join("; ")}`);
    const session = await FixtureSession.open({ inputRoot: await realpath(examplesRoot), inputFile: file, mode, account: { hostId: "xhs", accountId } as never });
    assert.equal(session.mode, mode);
    assert.equal(Object.isFrozen(session.summary), true);
    session.close();
  }
  assert.deepEqual((await readdir(path.join(examplesRoot, "media"))).sort(), ["synthetic.gif"]);
  assert.match(await readFile(path.join(examplesRoot, "media", "synthetic.gif"), "ascii"), /^GIF89a/u);
});

test("explanatory schema rejects unsafe integers, paths, and extra fields before runtime provenance checks", async () => {
  const schema = JSON.parse(await readFile(path.join(projectRoot, "schemas", "offline-input-v1.schema.json"), "utf8"));
  const noMedia = JSON.parse(await readFile(path.join(examplesRoot, "no-media-success.json"), "utf8"));
  const media = JSON.parse(await readFile(path.join(examplesRoot, "media-success.json"), "utf8"));
  const rejected = (value: unknown, label: string) => assert.equal(validateJsonSchema(schema, value).valid, false, label);

  const extra = structuredClone(noMedia);
  extra.unexpected = true;
  rejected(extra, "additionalProperties");

  const metric = structuredClone(noMedia);
  metric.pages[0].details[0].note.metrics.liked = Number.MAX_SAFE_INTEGER + 1;
  rejected(metric, "metric maximum");

  const ordinal = structuredClone(media);
  ordinal.pages[0].details[0].media[0].ordinal = Number.MAX_SAFE_INTEGER + 1;
  rejected(ordinal, "ordinal maximum");

  for (const invalid of ["/absolute.gif", "C:/absolute.gif", "../escape.gif", "media/../escape.gif", "media//empty.gif", "media/", "media/./dot.gif", "media\\backslash.gif", "media/\u0001control.gif"]) {
    const traversal = structuredClone(media);
    traversal.pages[0].details[0].media[0].relativePath = invalid;
    rejected(traversal, `relativePath ${JSON.stringify(invalid)}`);
  }
});

test("real validate-input is rootless, aggregate-only, and mode/account provenance-bound", async () => {
  const input = path.join(examplesRoot, "no-media-success.json");
  const before = await readdir(examplesRoot);
  const result = validateCli(input, "fixture", "synthetic-demo-account");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.output.result, {
    schemaVersion: 1, mode: "fixture", pageCount: 2, pageItemCount: 2, detailSuccessCount: 2,
    retryItemCount: 0, retrySuccessCount: 0, mediaSlotCount: 0, declaredFailureCount: 0, mediaFailureCount: 0,
  });
  const serialized = JSON.stringify(result.output);
  for (const forbidden of [input, "synthetic-demo-account", "synthetic-note-alpha", "This is an offline synthetic note.", "https://www.xiaohongshu.com"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(await readdir(examplesRoot), before);

  const wrongMode = validateCli(input, "import-json", "synthetic-demo-account");
  assert.equal(wrongMode.status, 2);
  assert.equal(wrongMode.output.error.category, "INVALID_INPUT");
  assert.equal(JSON.stringify(wrongMode.output).includes(input), false);
  const wrongAccount = validateCli(input, "fixture", "different-synthetic-account");
  assert.equal(wrongAccount.status, 2);
  assert.equal(wrongAccount.output.error.category, "INVALID_INPUT");
});
