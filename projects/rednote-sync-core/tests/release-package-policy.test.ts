import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReleasePackagePolicy } from "../scripts/release-package-policy.mjs";
import { parseReleaseTar } from "../scripts/release-tar.mjs";

async function sourcePackage(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as Record<string, unknown>;
}

test("release package policy is exact for scripts as well as package metadata", async () => {
  const baseline = await sourcePackage();
  assert.equal(assertReleasePackagePolicy(baseline), baseline);
  const changedValue = structuredClone(baseline) as { scripts: Record<string, string> };
  changedValue.scripts.check = "node scripts/static-check.mjs";
  assert.throws(() => assertReleasePackagePolicy(changedValue), /package scripts policy must remain exact/u);
  const addedKey = structuredClone(baseline) as { scripts: Record<string, string> };
  addedKey.scripts.arbitrary = "node arbitrary.mjs";
  assert.throws(() => assertReleasePackagePolicy(addedKey), /package scripts policy must remain exact/u);
});

for (const lifecycle of ["postinstall", "prepare", "prepack"] as const) {
  test(`static and pack gates reject ${lifecycle} before npm can execute it`, async () => {
    const physicalParent = await realpath(tmpdir());
    const fixtureRoot = await realpath(await mkdtemp(path.join(physicalParent, `rednote-${lifecycle}-canary-`)));
    await chmod(fixtureRoot, 0o700);
    const sentinel = path.join(fixtureRoot, "LIFECYCLE_EXECUTED");
    try {
      const fixturePackage = await sourcePackage() as { scripts: Record<string, string> };
      fixturePackage.scripts[lifecycle] = "node lifecycle-canary.mjs";
      await writeFile(path.join(fixtureRoot, "package.json"), `${JSON.stringify(fixturePackage)}\n`, { mode: 0o600 });
      await writeFile(path.join(fixtureRoot, "lifecycle-canary.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./LIFECYCLE_EXECUTED", import.meta.url), "unsafe\\n");\n', { mode: 0o600 });
      const staticResult = spawnSync(process.execPath, [path.resolve("scripts/static-check.mjs")], { cwd: fixtureRoot, encoding: "utf8", timeout: 20_000 });
      assert.equal(staticResult.error, undefined);
      assert.equal(staticResult.signal, null);
      assert.equal(staticResult.status, 1);
      assert.match(staticResult.stderr, /package lifecycle script is forbidden before pack/u);
      await assert.rejects(access(sentinel, constants.F_OK), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      const result = spawnSync(process.execPath, [path.resolve("scripts/pack-check.mjs")], { cwd: fixtureRoot, encoding: "utf8", timeout: 20_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
      assert.equal(result.stdout.trimEnd().split("\n").length, 1);
      const record = JSON.parse(result.stdout);
      assert.deepEqual({ ok: record.ok, error: record.error }, { ok: false, error: "PACK_CHECK_FAILED" });
      assert.match(record.reason, /package lifecycle script is forbidden before pack/u);
      await assert.rejects(access(sentinel, constants.F_OK), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
}

function tarWithEmptyEntry(archivePath: string, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(archivePath, 0, 100, "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000000\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

test("tar gate checks forbidden paths on files and directories before entry type", () => {
  for (const forbidden of [
    "package/src/canary.ts",
    "package/tests/canary.txt",
    "package/scripts/canary.mjs",
    "package/tools/canary.mjs",
    "package/research/canary.txt",
    "package/prototypes/canary.txt",
    "package/learning/canary.html",
    "package/docs/sync-core.md",
    "package/schemas/offline-artifacts.json",
    "package/tsconfig.json",
    "package/.DS_Store",
  ]) {
    assert.throws(() => parseReleaseTar(tarWithEmptyEntry(forbidden, "0")), /forbidden path entered package/u);
  }
  for (const forbiddenDirectory of ["package/src/", "package/tests/", "package/scripts/", "package/tools/", "package/research/", "package/prototypes/", "package/learning/"]) {
    assert.throws(() => parseReleaseTar(tarWithEmptyEntry(forbiddenDirectory, "5")), /forbidden path entered package/u);
  }
  assert.throws(() => parseReleaseTar(tarWithEmptyEntry("package/docs/", "5")), /tar directories, symlinks, and special entries are forbidden/u);
});
