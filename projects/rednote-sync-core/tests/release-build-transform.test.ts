import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertStaticModulePolicy } from "../scripts/module-import-policy.mjs";
import { collectModuleSpecifiers, rewriteRelativeTypeScriptSpecifiers } from "../scripts/typescript-specifier-transform.mjs";

test("dist transform rewrites only actual relative TypeScript module specifiers", () => {
  const source = [
    'const ordinary = "./same.ts";',
    'const sameText = "./static.ts";',
    'const template = `import("./template.ts") ${"./inside.ts"}`;',
    '// import "./line-comment.ts";',
    '/* export * from "./block-comment.ts"; */',
    'const matcher = /import\\("\\.\\/regex\\.ts"\\)/u;',
    'const receiver = { import: () => "./method.ts" };',
    'receiver.import("./method-argument.ts");',
    'import staticDefault, {',
    '  named as renamed,',
    '} from',
    '  "./static.ts";',
    'import "./same.ts";',
    'const dynamic = import(',
    '  "../dynamic.ts"',
    ');',
    'export { value } from "./named.ts";',
    'export * from',
    '  "../star.ts";',
    '',
  ].join("\n");

  const rewritten = rewriteRelativeTypeScriptSpecifiers(source);
  assert.match(rewritten, /const ordinary = "\.\/same\.ts";/u);
  assert.match(rewritten, /const sameText = "\.\/static\.ts";/u);
  assert.match(rewritten, /`import\("\.\/template\.ts"\) \$\{"\.\/inside\.ts"\}`/u);
  assert.match(rewritten, /\/\/ import "\.\/line-comment\.ts";/u);
  assert.match(rewritten, /\/\* export \* from "\.\/block-comment\.ts"; \*\//u);
  assert.match(rewritten, /receiver\.import\("\.\/method-argument\.ts"\)/u);
  assert.match(rewritten, /from\s+"\.\/static\.js";/u);
  assert.match(rewritten, /import "\.\/same\.js";/u);
  assert.match(rewritten, /import\(\s+"\.\.\/dynamic\.js"\s+\)/u);
  assert.match(rewritten, /export \{ value \} from "\.\/named\.js";/u);
  assert.match(rewritten, /export \* from\s+"\.\.\/star\.js";/u);

  assert.deepEqual(collectModuleSpecifiers(rewritten).map(({ kind, specifier }) => ({ kind, specifier })), [
    { kind: "static_import", specifier: "./static.js" },
    { kind: "side_effect_import", specifier: "./same.js" },
    { kind: "dynamic_import", specifier: "../dynamic.js" },
    { kind: "export_from", specifier: "./named.js" },
    { kind: "export_from", specifier: "../star.js" },
  ]);
});

test("template quasis remain byte-stable while nested expressions are recursively scanned", () => {
  const source = [
    'const value = `outer \\`tick\\` ${await import("./outer.ts")} ${`inner import("./hidden.ts") ${await import("../nested.ts")}`} ${(() => {',
    '  const object = { close: "}", expression: "}/" };',
    '  /* } import("./comment.ts") */',
    '  return object.close === "}" ? import("./brace.ts") : object;',
    '})()}`;',
    '',
  ].join("\n");
  const rewritten = rewriteRelativeTypeScriptSpecifiers(source);
  assert.match(rewritten, /outer \\`tick\\`/u);
  assert.match(rewritten, /await import\("\.\/outer\.js"\)/u);
  assert.match(rewritten, /inner import\("\.\/hidden\.ts"\)/u);
  assert.match(rewritten, /await import\("\.\.\/nested\.js"\)/u);
  assert.match(rewritten, /\/\* \} import\("\.\/comment\.ts"\) \*\//u);
  assert.match(rewritten, /import\("\.\/brace\.js"\)/u);
  assert.deepEqual(collectModuleSpecifiers(rewritten).map(({ specifier }) => specifier), ["./outer.js", "../nested.js", "./brace.js"]);
});

test("template expression slash syntax fails closed before a brace can hide imports", () => {
  const networkBypass = 'const value = `${(() => { if (true) /}/.test("}"); })() || import("node:http")}`;';
  const relativeBypass = 'const value = `${(() => { if (true) /}/.test("}"); })() || import("./x.ts")}`;';
  assert.doesNotThrow(() => new Function(networkBypass));
  assert.doesNotThrow(() => new Function(relativeBypass));
  assert.throws(() => assertStaticModulePolicy(networkBypass), /template expression slash syntax is unsupported/u);
  assert.throws(() => rewriteRelativeTypeScriptSpecifiers(relativeBypass), /template expression slash syntax is unsupported/u);
  assert.throws(() => collectModuleSpecifiers('const value = `${1 / 2}`;'), /template expression slash syntax is unsupported/u);

  const safe = [
    'const value = `outer ${(() => {',
    '  const text = "}/";',
    '  /* } / import("node:http") */',
    '  // } / import("third-party")',
    '  return import("./visible.ts");',
    '})()}`;',
  ].join("\n");
  const rewritten = rewriteRelativeTypeScriptSpecifiers(safe);
  assert.match(rewritten, /const text = "\}\//u);
  assert.match(rewritten, /\/\* \} \/ import\("node:http"\) \*\//u);
  assert.match(rewritten, /\/\/ \} \/ import\("third-party"\)/u);
  assert.match(rewritten, /return import\("\.\/visible\.js"\)/u);
});

test("template expression imports remain subject to the static offline policy", () => {
  assert.deepEqual(collectModuleSpecifiers('const value = `outer ${await import("node:http")}`;').map(({ specifier }) => specifier), ["node:http"]);
  assert.throws(() => assertStaticModulePolicy('const value = `outer ${await import("node:http")}`;'), /network built-in import is forbidden/u);
  assert.throws(() => assertStaticModulePolicy('const value = `outer ${await import("third-party")}`;'), /third-party import is forbidden/u);
  assert.doesNotThrow(() => assertStaticModulePolicy('const value = `inner import("node:http")`;'));
});

test("dynamic imports fail closed unless they contain one plain quoted string", () => {
  for (const source of [
    'import("./x.ts" + "");',
    'import(`./x.ts`);',
    'import(flag ? "./x.ts" : "./y.ts");',
    'import(variable);',
    'import(/* comment */ "./x.ts");',
    'import("./x.ts" /* comment */);',
    'import("./x.ts", { with: { type: "json" } });',
    'import(("./x.ts"));',
  ]) {
    assert.throws(() => rewriteRelativeTypeScriptSpecifiers(source), /dynamic import/u, source);
  }
});

test("template recursion is bounded and unterminated structures fail closed", () => {
  assert.throws(() => collectModuleSpecifiers('const value = `unterminated;'), /unterminated template literal/u);
  assert.throws(() => collectModuleSpecifiers('const value = `unterminated ${ { close: "}" }'), /unterminated template expression/u);
  let nested = '"leaf"';
  for (let index = 0; index < 70; index += 1) nested = `\`${"${"}${nested}}\``;
  assert.throws(() => collectModuleSpecifiers(`const value = ${nested};`), /template nesting exceeds/u);
});

test("dist transform rejects escaped module specifiers instead of guessing", () => {
  assert.throws(() => rewriteRelativeTypeScriptSpecifiers('import "./escaped\\x2ets";\n'), /module specifier escapes are unsupported/u);
  assert.doesNotThrow(() => rewriteRelativeTypeScriptSpecifiers('const ordinary = "./escaped\\x2ets";\n'));
});

test("rewritten static, side-effect, export-from, and dynamic imports execute", async () => {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, "rednote-transform-test-")));
  await chmod(root, 0o700);
  const marker = `release_transform_${process.pid}_${Date.now()}`;
  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    await writeFile(path.join(root, "static.js"), 'export const staticValue = 17;\n', { mode: 0o600 });
    await writeFile(path.join(root, "side-effect.js"), `globalThis[${JSON.stringify(marker)}] = true;\n`, { mode: 0o600 });
    await writeFile(path.join(root, "exported.js"), 'export const exportedValue = 23;\n', { mode: 0o600 });
    await writeFile(path.join(root, "dynamic.js"), 'export const dynamicValue = 29;\n', { mode: 0o600 });
    const source = [
      'import { staticValue } from "./static.ts";',
      'import "./side-effect.ts";',
      'export { exportedValue } from "./exported.ts";',
      'export const dynamicNamespace = await import("./dynamic.ts");',
      'export { staticValue };',
      '',
    ].join("\n");
    await writeFile(path.join(root, "main.js"), rewriteRelativeTypeScriptSpecifiers(source), { mode: 0o600 });
    await writeFile(path.join(root, "runner.js"), [
      'import * as loaded from "./main.js";',
      `process.stdout.write(JSON.stringify({ staticValue: loaded.staticValue, exportedValue: loaded.exportedValue, dynamicValue: loaded.dynamicNamespace.dynamicValue, sideEffect: globalThis[${JSON.stringify(marker)}] }) + "\\n");`,
      '',
    ].join("\n"), { mode: 0o600 });
    const result = spawnSync(process.execPath, [path.join(root, "runner.js")], { cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { staticValue: 17, exportedValue: 23, dynamicValue: 29, sideEffect: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
