import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertReleasePackagePolicy, FORBIDDEN_PACKAGE_PATH } from "./release-package-policy.mjs";
import { parseReleaseTar } from "./release-tar.mjs";

async function expectedPackageFiles(root, declared) {
  const files = new Set(["README.md", "package.json"]);
  async function visit(relative) {
    assert.doesNotMatch(relative, FORBIDDEN_PACKAGE_PATH, "forbidden path entered package");
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      for (const child of await readdir(absolute)) await visit(path.posix.join(relative, child));
    } else {
      assert.ok(info.isFile(), "package artifacts must be regular files");
      files.add(relative);
    }
  }
  for (const relative of declared) await visit(relative.replace(/\/$/u, ""));
  return [...files].sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, options = {}, label = "subprocess") {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
  assert.equal(result.error, undefined, `${label} launch failed`);
  assert.equal(result.signal, null, `${label} was terminated`);
  assert.equal(result.status, 0, `${label} failed`);
  return result;
}

function oneJsonCommand(bin, args, cwd) {
  const commandLabel = typeof args[0] === "string" && /^(?:--version|--help|doctor|validate-input|init|sync|status|verify)$/u.test(args[0]) ? args[0] : "unknown";
  const result = run(bin, args, { cwd, timeout: 30_000 }, `packaged CLI ${commandLabel}`);
  assert.equal(result.stderr, "", "packaged CLI wrote stderr");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "packaged CLI stdout must be one line");
  const record = JSON.parse(lines[0]);
  assert.equal(record.ok, true, "packaged CLI command failed");
  assert.equal(record.exitCode, 0, "packaged CLI returned nonzero");
  return record;
}

async function assertRegular(target) {
  const info = await lstat(target);
  assert.equal(info.isFile() && !info.isSymbolicLink(), true, "packaged artifact must be a regular file");
}

async function main() {
  const projectRoot = await realpath(process.cwd());
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assertReleasePackagePolicy(packageJson);
  run(process.execPath, ["scripts/build-dist.mjs", "--check"], { cwd: projectRoot }, "reproducible dist check");
  run(process.execPath, ["scripts/offline-artifact-check.mjs"], { cwd: projectRoot }, "offline artifact check");
  const expectedFiles = await expectedPackageFiles(projectRoot, packageJson.files);
  const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
  for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const destination = match[1];
    if (destination.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) continue;
    const relative = destination.split("#", 1)[0];
    assert.equal(expectedFiles.includes(relative), true, "README relative link must resolve inside the package");
  }

  const physicalTemp = await realpath(tmpdir());
  const work = await realpath(await mkdtemp(path.join(physicalTemp, "rednote-pack-check-")));
  await chmod(work, 0o700);
  let report;
  try {
    const artifactDirectory = path.join(work, "artifact");
    const reproducibilityDirectory = path.join(work, "artifact-reproducible");
    const cacheDirectory = path.join(work, "npm-cache");
    const installDirectory = path.join(work, "install");
    await Promise.all([mkdir(artifactDirectory, { mode: 0o700 }), mkdir(reproducibilityDirectory, { mode: 0o700 }), mkdir(cacheDirectory, { mode: 0o700 }), mkdir(installDirectory, { mode: 0o700 })]);
    await writeFile(path.join(installDirectory, "package.json"), '{"name":"rednote-pack-consumer","version":"0.0.0","private":true}\n', { mode: 0o600 });

    const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true" };
    const packed = run("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cacheDirectory, "--pack-destination", artifactDirectory, "."], { cwd: projectRoot, env: npmEnvironment }, "npm pack subprocess");
    const packResult = JSON.parse(packed.stdout);
    assert.equal(Array.isArray(packResult) && packResult.length === 1, true, "npm pack result must contain one artifact");
    const tarballName = packResult[0].filename;
    assert.equal(typeof tarballName, "string");
    assert.equal(path.basename(tarballName), tarballName, "npm tarball name must be a basename");
    const tarball = path.join(artifactDirectory, tarballName);
    const tarballBytes = await readFile(tarball);
    const parsedTarball = parseReleaseTar(tarballBytes);
    const inventory = parsedTarball.inventory;
    const packedPackageJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(parsedTarball.packageJsonBytes));
    assertReleasePackagePolicy(packedPackageJson);
    assert.deepEqual(inventory.map((entry) => entry.path), expectedFiles, "tar inventory must exactly match the authorized package files");
    assert.deepEqual(packResult[0].files.map((entry) => entry.path).sort(), expectedFiles, "npm inventory must match parsed tar inventory");
    assert.equal(packResult[0].entryCount, expectedFiles.length);
    const repacked = run("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cacheDirectory, "--pack-destination", reproducibilityDirectory, "."], { cwd: projectRoot, env: npmEnvironment }, "reproducible npm pack subprocess");
    const repackResult = JSON.parse(repacked.stdout);
    assert.equal(Array.isArray(repackResult) && repackResult.length === 1 && repackResult[0].filename === tarballName, true, "reproducible npm pack result mismatch");
    const repackedBytes = await readFile(path.join(reproducibilityDirectory, tarballName));
    assert.deepEqual(repackedBytes, tarballBytes, "two npm pack tarballs must be byte-identical");
    const parsedRepacked = parseReleaseTar(repackedBytes);
    assert.deepEqual(parsedRepacked.inventory, inventory, "two npm pack inventories must be identical");
    assertReleasePackagePolicy(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(parsedRepacked.packageJsonBytes)));

    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--cache", cacheDirectory, tarball], { cwd: installDirectory, env: npmEnvironment }, "npm install subprocess");
    const installedRoot = path.join(installDirectory, "node_modules", "rednote-sync-core");
    const bin = path.join(installDirectory, "node_modules", ".bin", "rednote-sync");
    await access(bin, constants.X_OK);
    const binInfo = await lstat(bin);
    assert.equal(binInfo.isSymbolicLink() || binInfo.isFile(), true, "installed bin must be executable");
    await Promise.all([
      assertRegular(path.join(installedRoot, "README.md")),
      assertRegular(path.join(installedRoot, "docs", "offline-input-v1.md")),
      assertRegular(path.join(installedRoot, "schemas", "offline-input-v1.schema.json")),
      assertRegular(path.join(installedRoot, "examples", "offline-v1", "no-media-success.json")),
    ]);

    const commands = [];
    commands.push(oneJsonCommand(bin, ["--version"], installDirectory));
    commands.push(oneJsonCommand(bin, ["--help"], installDirectory));
    commands.push(oneJsonCommand(bin, ["doctor"], installDirectory));
    const example = path.join(installedRoot, "examples", "offline-v1", "no-media-success.json");
    commands.push(oneJsonCommand(bin, ["validate-input", "--adapter", "fixture", "--input", example, "--host", "xhs", "--account", "synthetic-demo-account"], installDirectory));
    const syncRoot = await realpath(await mkdtemp(path.join(work, "sync-root-")));
    await chmod(syncRoot, 0o700);
    commands.push(oneJsonCommand(bin, ["init", "--root", syncRoot], installDirectory));
    commands.push(oneJsonCommand(bin, ["sync", "--root", syncRoot, "--adapter", "fixture", "--input", example, "--host", "xhs", "--account", "synthetic-demo-account", "--target", "liked", "--limit", "1", "--minimum-interval-ms", "0"], installDirectory));
    commands.push(oneJsonCommand(bin, ["status", "--root", syncRoot, "--host", "xhs", "--account", "synthetic-demo-account", "--target", "liked"], installDirectory));
    commands.push(oneJsonCommand(bin, ["verify", "--root", syncRoot], installDirectory));
    assert.deepEqual(commands.map((record) => record.command), ["version", "help", "doctor", "validate_input", "init", "sync", "status", "verify"]);

    const inventoryBytes = Buffer.from(JSON.stringify(inventory), "utf8");
    report = Object.freeze({
      ok: true,
      package: `${packageJson.name}@${packageJson.version}`,
      published: false,
      packageFiles: inventory.length,
      unpackedBytes: inventory.reduce((total, entry) => total + entry.byteLength, 0),
      tarballBytes: tarballBytes.byteLength,
      tarballSha256: sha256(tarballBytes),
      inventorySha256: sha256(inventoryBytes),
      inventory,
      installedCommands: commands.length,
      reproduciblePacks: 2,
      dependencies: 0,
      temporaryCleanup: true,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  await main();
} catch (error) {
  const reason = error instanceof assert.AssertionError && typeof error.message === "string"
    ? error.message.split("\n", 1)[0].replace(/[^A-Za-z0-9 _-]/gu, "").slice(0, 80)
    : "internal pack gate failure";
  process.stdout.write(`${JSON.stringify({ ok: false, error: "PACK_CHECK_FAILED", reason })}\n`);
  process.stderr.write('{"level":"error","event":"pack_check_failed"}\n');
  process.exitCode = 1;
}
