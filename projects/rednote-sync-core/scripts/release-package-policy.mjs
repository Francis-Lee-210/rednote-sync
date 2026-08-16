import assert from "node:assert/strict";

export const EXPECTED_FILES_ALLOWLIST = Object.freeze([
  "dist/bin.js", "dist/canonical.js", "dist/cli.js", "dist/commands.js", "dist/control.js", "dist/doctor.js", "dist/errors.js", "dist/exporters.js",
  "dist/host-adapter.js", "dist/index.js", "dist/merge.js", "dist/object-store.js", "dist/offline-input.js", "dist/paths.js", "dist/private-access.js",
  "dist/progress.js", "dist/projectors.js", "dist/rank.js", "dist/runtime.js", "dist/secrets.js", "dist/state-store.js", "dist/sync-engine.js", "dist/types.js",
  "dist/verify.js", "dist/view-types.js", "docs/offline-input-v1.md", "examples/offline-v1/failure.json", "examples/offline-v1/import-json-success.json",
  "examples/offline-v1/media-success.json", "examples/offline-v1/media/synthetic.gif", "examples/offline-v1/no-media-success.json",
  "examples/offline-v1/retry-success.json", "schemas/offline-input-v1.schema.json",
]);

export const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  "build:dist": "node --disable-warning=ExperimentalWarning scripts/build-dist.mjs --write",
  "build:check": "node --disable-warning=ExperimentalWarning scripts/build-dist.mjs --check",
  check: "node --disable-warning=ExperimentalWarning scripts/build-dist.mjs --check && node scripts/static-check.mjs && node scripts/offline-artifact-check.mjs && node scripts/offline-artifact-check-test.mjs",
  test: "node --test --test-concurrency=1 tests/*.test.ts",
  "test:release": "node --test --test-concurrency=1 tests/release-*.test.ts",
  "pack:check": "node scripts/pack-check.mjs",
  "test:offline-artifact": "node scripts/offline-artifact-check-test.mjs",
  "test:offline-demo": "node scripts/offline-demo-test.mjs",
  "test:readme-smoke": "node scripts/readme-smoke-test.mjs",
});

export const FORBIDDEN_PACKAGE_PATH = /(?:^|\/)(?:src|tests|scripts|tools|research|prototypes|learning)(?:\/|$)|(?:^|\/)(?:docs\/sync-core\.md|schemas\/offline-artifacts\.json|tsconfig\.json|\.DS_Store)(?:\/|$)/u;

const RELEASE_LIFECYCLE_SCRIPT = /^(?:(?:pre|post)?(?:install|uninstall|pack|prepare|publish|version)|prepublishOnly|dependencies)$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertReleasePackagePolicy(packageJson) {
  assert.equal(isRecord(packageJson), true, "package policy requires one JSON object");
  assert.deepEqual(Object.keys(packageJson).sort(), ["bin", "dependencies", "devDependencies", "engines", "files", "license", "name", "os", "private", "scripts", "type", "version"].sort(), "package top-level fields must remain exact");
  assert.equal(packageJson.name, "rednote-sync-core", "package name policy mismatch");
  assert.equal(packageJson.version, "0.0.0-stage3", "package version policy mismatch");
  assert.equal(packageJson.private, true, "package must remain private");
  assert.equal(packageJson.license, "UNLICENSED", "package must remain explicitly unlicensed");
  assert.equal(packageJson.type, "module", "package module type policy mismatch");
  assert.deepEqual(packageJson.engines, { node: ">=26 <27" }, "package Node engine policy mismatch");
  assert.deepEqual(packageJson.os, ["darwin"], "package operating-system policy mismatch");
  assert.deepEqual(packageJson.bin, { "rednote-sync": "./dist/bin.js" }, "package bin policy mismatch");
  assert.deepEqual(packageJson.dependencies, {}, "runtime dependencies must remain empty");
  assert.deepEqual(packageJson.devDependencies, {}, "development dependencies must remain empty");
  assert.deepEqual(packageJson.files, EXPECTED_FILES_ALLOWLIST, "package files allowlist must remain exact");
  assert.equal(isRecord(packageJson.scripts), true, "package scripts must be an object");
  for (const name of Object.keys(packageJson.scripts)) {
    assert.doesNotMatch(name, RELEASE_LIFECYCLE_SCRIPT, "package lifecycle script is forbidden before pack");
  }
  assert.deepEqual(packageJson.scripts, EXPECTED_PACKAGE_SCRIPTS, "package scripts policy must remain exact");
  return packageJson;
}
