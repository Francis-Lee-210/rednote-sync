import assert from "node:assert/strict";

export const FORBIDDEN_PACKAGE_PATH = /(?:^|\/)(?:src|tests|scripts|tools|research|prototypes|learning|node_modules|profiles|captures|\.local|\.git)(?:\/|$)|(?:^|\/)(?:docs\/sync-core\.md|schemas\/offline-artifacts\.json|tsconfig(?:\.[^/]+)?\.json|\.DS_Store|\.env(?:\.[^/]+)?)(?:\/|$)|\.(?:har|jsonl|tgz)$/u;
const LIFECYCLE_SCRIPT = /^(?:(?:pre|post)?(?:install|uninstall|pack|prepare|publish|version)|prepublishOnly|dependencies)$/u;

export function assertReleasePackagePolicy(pkg) {
  assert.equal(pkg.name, "rednote-sync-core");
  assert.equal(pkg.private, true, "package must remain private");
  assert.equal(pkg.license, "UNLICENSED");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.engines, { node: ">=26 <27" });
  assert.deepEqual(pkg.os, ["darwin"]);
  assert.deepEqual(pkg.bin, { "rednote-sync": "./dist/bin.js" });
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, "runtime dependencies must remain empty");
  for (const version of Object.values(pkg.devDependencies ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u, "development dependencies must use fixed versions");
  }
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "package needs an artifact allowlist");
  for (const relative of pkg.files) {
    assert.equal(typeof relative, "string");
    assert.ok(!relative.startsWith("/") && !relative.split("/").includes(".."), "package paths must stay inside the package");
    assert.doesNotMatch(relative, FORBIDDEN_PACKAGE_PATH, "forbidden package path");
  }
  for (const name of Object.keys(pkg.scripts ?? {})) {
    assert.doesNotMatch(name, LIFECYCLE_SCRIPT, "package lifecycle script is forbidden before pack");
  }
  return pkg;
}
