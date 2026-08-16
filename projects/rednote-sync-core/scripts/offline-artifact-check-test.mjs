import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(sourceRoot, "scripts", "offline-artifact-check.mjs");
const tempParent = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "rednote-artifact-gate-")));
const seed = path.join(tempParent, "seed");
const external = path.join(tempParent, "outside");
const externalFile = path.join(external, "external-canary.txt");
const externalCanary = "EXTERNAL_TARGET_CONTENT_CANARY";
const fixedFiles = [
  "README.md",
  "docs/offline-input-v1.md",
  "schemas/offline-artifacts.json",
  "schemas/offline-input-v1.schema.json",
];

async function copyFixedFile(relative, destinationRoot) {
  const destination = path.join(destinationRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(path.join(sourceRoot, relative), destination);
}

async function createSeed() {
  await mkdir(seed, { recursive: true, mode: 0o700 });
  for (const relative of fixedFiles) await copyFixedFile(relative, seed);
  await mkdir(path.join(seed, "examples"), { recursive: true, mode: 0o700 });
  await cp(path.join(sourceRoot, "examples", "offline-v1"), path.join(seed, "examples", "offline-v1"), {
    recursive: true,
    dereference: false,
  });
  await mkdir(external, { recursive: true, mode: 0o700 });
  await writeFile(externalFile, externalCanary, { mode: 0o600 });
}

async function newMirror(name) {
  const mirror = path.join(tempParent, name);
  await cp(seed, mirror, { recursive: true, dereference: false });
  return await realpath(mirror);
}

async function runGate(cwd) {
  try {
    const result = await execFileAsync(process.execPath, [checker], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, signal: null, killed: false, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
      killed: error.killed ?? false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function assertRejected(result, expected, name) {
  assert.notEqual(result.code, 0, `${name}: gate must exit nonzero`);
  assert.equal(result.signal, null, `${name}: gate must not terminate by signal`);
  assert.equal(result.killed, false, `${name}: gate must reject before timeout`);
  assert.match(result.stderr, expected, `${name}: expected an early gate rejection`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(externalCanary, "u"), `${name}: external canary content was exposed`);
  assert.doesNotMatch(result.stderr, /EACCES|EPERM/u, `${name}: rejection must occur before attempting an unreadable external target`);
}

async function mutateManifest(mirror, mutate) {
  const target = path.join(mirror, "schemas", "offline-artifacts.json");
  const manifest = JSON.parse(await readFile(target, "utf8"));
  mutate(manifest);
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function rejectedManifestPath(name, maliciousPath) {
  const mirror = await newMirror(name);
  await mutateManifest(mirror, (manifest) => { manifest.textArtifacts[0] = maliciousPath; });
  assertRejected(await runGate(mirror), /manifest artifact: path/u, name);
}

async function appendReadmeCase(name, content, expected) {
  const mirror = await newMirror(name);
  const target = path.join(mirror, "README.md");
  await writeFile(target, `${await readFile(target, "utf8")}\n${content}\n`, { mode: 0o600 });
  assertRejected(await runGate(mirror), expected, name);
}

try {
  await createSeed();

  const positive = await runGate(await newMirror("positive"));
  assert.equal(positive.code, 0, `positive mirror failed:\n${positive.stderr}`);
  assert.deepEqual(JSON.parse(positive.stdout), { ok: true, textArtifacts: 3, exampleArtifacts: 6 });

  // Make all external targets unreadable after materializing them. Invalid paths
  // must be rejected syntactically; symlinks must be rejected by lstat.
  await chmod(external, 0o000);
  await assert.rejects(
    readFile(externalFile),
    (error) => error?.code === "EACCES" || error?.code === "EPERM",
    "external canary must actually be unreadable during negative gate cases",
  );
  await rejectedManifestPath("path-parent", "../outside/external-canary.txt");
  await rejectedManifestPath("path-absolute", externalFile);
  await rejectedManifestPath("path-drive", "C:/outside/external-canary.txt");
  await rejectedManifestPath("path-backslash", "docs\\offline-input-v1.md");
  await rejectedManifestPath("path-dot", "docs/./offline-input-v1.md");
  await rejectedManifestPath("path-control", "docs/offline-input-\u0001.md");
  await rejectedManifestPath("path-empty", "");
  await rejectedManifestPath("path-non-nfc", "docs/offline-input-e\u0301.md");

  const manifestLeaf = await newMirror("manifest-leaf-symlink");
  await rm(path.join(manifestLeaf, "schemas", "offline-artifacts.json"));
  await symlink(externalFile, path.join(manifestLeaf, "schemas", "offline-artifacts.json"));
  assertRejected(await runGate(manifestLeaf), /cannot contain symbolic links/u, "manifest-leaf-symlink");

  const manifestAncestor = await newMirror("manifest-ancestor-symlink");
  await rm(path.join(manifestAncestor, "schemas"), { recursive: true });
  await symlink(external, path.join(manifestAncestor, "schemas"));
  assertRejected(await runGate(manifestAncestor), /cannot contain symbolic links/u, "manifest-ancestor-symlink");

  const exampleEntry = await newMirror("example-entry-symlink");
  await rm(path.join(exampleEntry, "examples", "offline-v1"), { recursive: true });
  await symlink(external, path.join(exampleEntry, "examples", "offline-v1"));
  assertRejected(await runGate(exampleEntry), /cannot contain symbolic links/u, "example-entry-symlink");

  const omittedText = await newMirror("manifest-text-omission");
  await mutateManifest(omittedText, (manifest) => { manifest.textArtifacts.splice(1, 1); });
  assertRejected(await runGate(omittedText), /must exactly match the checker-owned set/u, "manifest-text-omission");

  const extraDoc = await newMirror("extra-doc");
  await writeFile(path.join(extraDoc, "docs", "offline-input-extra.md"), externalCanary, { mode: 0o600 });
  assertRejected(await runGate(extraDoc), /offline text discovery must exactly match/u, "extra-doc");

  const extraSchema = await newMirror("extra-schema");
  await writeFile(path.join(extraSchema, "schemas", "offline-input-extra.schema.json"), externalCanary, { mode: 0o600 });
  assertRejected(await runGate(extraSchema), /offline text discovery must exactly match/u, "extra-schema");

  await appendReadmeCase("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.abcdefghijklmno", /JWT-like value is forbidden/u);
  await appendReadmeCase("replace-me", "REPLACE_ME", /placeholder text is forbidden/u);
  await appendReadmeCase("your-api-key", "YOUR_API_KEY", /placeholder text is forbidden/u);
  await appendReadmeCase("credential-prefix", "sk-syntheticcredential123456", /credential-prefix value is forbidden/u);

  process.stdout.write(JSON.stringify({ ok: true, positive: 1, rejected: 18, externalRead: false }) + "\n");
} finally {
  await chmod(external, 0o700).catch(() => {});
  await rm(tempParent, { recursive: true, force: true });
}
