import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertStaticModulePolicy } from "../scripts/module-import-policy.mjs";
import { validateJsonSchema } from "../scripts/json-schema-contract.mjs";

const buildScript = path.resolve("scripts/build-dist.mjs");

async function withBuildFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "rednote-tsc-test-"));
  try {
    await mkdir(path.join(root, "src"));
    const base = JSON.parse(await readFile("tsconfig.json", "utf8"));
    base.compilerOptions.types = [];
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(base));
    await writeFile(path.join(root, "tsconfig.build.json"), await readFile("tsconfig.build.json"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(root, "src", "value.ts"), "export const value: number = 17;\n");
    await writeFile(path.join(root, "src", "bin.ts"), [
      "#!/usr/bin/env node",
      'import { value } from "./value.ts";',
      'export { value } from "./value.ts";',
      'export const dynamicValue = (await import(/* intentional comment */ "./value.ts")).value;',
      'export const ordinary = "./value.ts";',
      'export const ratio = `${1 / 2}`;',
      'export const seen = /}/.test("}") && value === 17;',
      "",
    ].join("\n"));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function build(root: string, mode: "--write" | "--check") {
  return spawnSync(process.execPath, [buildScript, mode], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

test("standard compiler emits runnable imports and preserves ordinary strings", async () => {
  await withBuildFixture(async (root) => {
    const result = build(root, "--write");
    assert.equal(result.status, 0, result.stderr);
    await writeFile(path.join(root, "runner.mjs"), 'import * as values from "./dist/bin.js"; process.stdout.write(JSON.stringify(values));\n');
    const run = spawnSync(process.execPath, [path.join(root, "runner.mjs")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { value: 17, dynamicValue: 17, ordinary: "./value.ts", ratio: "0.5", seen: true });
    assert.equal(build(root, "--check").status, 0);
    await chmod(path.join(root, "dist", "bin.js"), 0o644);
    assert.notEqual(build(root, "--check").status, 0, "non-executable CLI must fail release checking");
  });
});

test("new modules are discovered and stale dist output is rejected", async () => {
  await withBuildFixture(async (root) => {
    assert.equal(build(root, "--write").status, 0);
    await mkdir(path.join(root, "src", "nested"));
    await writeFile(path.join(root, "src", "nested", "new-module.ts"), "export const added = true;\n");
    assert.notEqual(build(root, "--check").status, 0);
    const result = build(root, "--write");
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(path.join(root, "dist", "nested", "new-module.js"), "utf8"), /added = true/u);
    assert.equal(build(root, "--check").status, 0);
  });
});

test("type errors fail compilation without replacing the previous dist", async () => {
  await withBuildFixture(async (root) => {
    assert.equal(build(root, "--write").status, 0);
    const prior = await readFile(path.join(root, "dist", "value.js"), "utf8");
    await writeFile(path.join(root, "src", "value.ts"), 'export const value: number = "wrong";\n');
    const result = build(root, "--write");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TS2322/u);
    assert.equal(await readFile(path.join(root, "dist", "value.js"), "utf8"), prior);
    assert.equal((await readdir(root)).some((name) => name.startsWith(".dist-build-")), false);
  });
});

test("runtime offline policy parses real imports without rejecting text or ordinary syntax", () => {
  const harmless = 'const text = `import("node:http") ${1 / 2}`; const r = /fetch\\(/;';
  assert.doesNotThrow(() => assertStaticModulePolicy(harmless));
  assert.deepEqual(assertStaticModulePolicy('const value = `${await import(/* comment */ "./value.ts")}`;'), ["./value.ts"]);
  for (const source of ['import "node:http";', 'require("https");', 'import(`node:net`);', 'const value = `${await import("node:tls")}`;']) {
    assert.throws(() => assertStaticModulePolicy(source), /network built-in import is forbidden/u);
  }
  assert.throws(() => assertStaticModulePolicy('import "some-runtime-package";'), /runtime third-party import is forbidden/u);
  assert.throws(() => assertStaticModulePolicy('globalThis.fetch("https://example.invalid");'), /runtime fetch is forbidden/u);
});

test("development schema validation supports standard 2020-12 rules without mutating inputs", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { first: { type: "string" }, second: { type: "integer" }, link: { type: "string", format: "uri" } },
    dependentRequired: { first: ["second"] },
    additionalProperties: false,
  };
  const invalid = { first: "one", link: "not a URI" };
  const prior = structuredClone(invalid);
  const result = validateJsonSchema(schema, invalid);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(invalid, prior);
  assert.equal(validateJsonSchema(schema, { first: "one", second: 2, link: "https://example.invalid" }).valid, true);
  assert.throws(() => validateJsonSchema({ type: "string", minLenght: 3 }, "x"), /unknown keyword/u);
});
