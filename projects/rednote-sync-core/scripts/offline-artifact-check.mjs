import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { validateJsonSchema } from "./json-schema-contract.mjs";

const manifestPath = "schemas/offline-artifacts.json";
const trustedTextArtifacts = Object.freeze([
  "README.md",
  "docs/offline-input-v1.md",
  "schemas/offline-input-v1.schema.json",
]);
const exampleRoot = "examples/offline-v1";
const mediaRelative = "examples/offline-v1/media/synthetic.gif";

const forbiddenCredentialPath = /prototypes[\\/](?:test-cookie\.txt|xsec_token\.txt)/iu;
const placeholder = /\b(?:TODO|TBD|PLACEHOLDER|CHANGEME|REPLACE_ME|YOUR_[A-Z0-9_]+)\b|待补(?:充)?|待实现/iu;
const jwtValue = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const credentialPrefixValue = /\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/u;
const credentialAssignment = /\b(?:cookie|token|secret|authorization|password|web_session|xsec|api[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9+/_=-]{8,}/iu;
const urlPattern = /https?:\/\/[^\s"'<>`]+/giu;

function fail(message) {
  throw new Error(message);
}

function assertSafeText(text, relative) {
  assert.doesNotMatch(text, forbiddenCredentialPath, `${relative}: credential fixture path is forbidden`);
  assert.doesNotMatch(text, placeholder, `${relative}: placeholder text is forbidden`);
  assert.doesNotMatch(text, jwtValue, `${relative}: JWT-like value is forbidden`);
  assert.doesNotMatch(text, credentialPrefixValue, `${relative}: credential-prefix value is forbidden`);
  assert.doesNotMatch(text, credentialAssignment, `${relative}: credential assignment is forbidden`);
  for (const match of text.matchAll(urlPattern)) {
    const candidate = match[0].replace(/[),.;:]+$/u, "");
    const url = new URL(candidate);
    assert.equal(url.username, "", `${relative}: URL credentials are forbidden`);
    assert.equal(url.password, "", `${relative}: URL credentials are forbidden`);
    assert.equal(url.search, "", `${relative}: tokenized URL query is forbidden`);
    assert.equal(url.hash, "", `${relative}: tokenized URL fragment is forbidden`);
  }
}

const root = path.resolve(process.cwd());
assert.equal(path.isAbsolute(root), true, "offline artifact root must be absolute");
assert.equal(Number.isInteger(constants.O_NOFOLLOW), true, "POSIX O_NOFOLLOW is required");

async function assertPhysicalRootNoSymlinks(absoluteRoot) {
  const parsed = path.parse(absoluteRoot);
  let current = parsed.root;
  const rootInfo = await lstat(current);
  assert.equal(rootInfo.isSymbolicLink(), false, "offline artifact root chain cannot contain symlinks");
  assert.equal(rootInfo.isDirectory(), true, "offline artifact root chain must contain only directories");
  const segments = absoluteRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, "offline artifact root chain cannot contain symlinks");
    assert.equal(info.isDirectory(), true, "offline artifact root chain must contain only directories");
  }
}

function strictRelativePath(relative, label = "offline artifact") {
  if (typeof relative !== "string") fail(`${label}: path must be a string`);
  if (relative.length === 0) fail(`${label}: path must be non-empty`);
  if (relative.normalize("NFC") !== relative) fail(`${label}: path must be NFC`);
  if (/[\\\u0000-\u001f\u007f]/u.test(relative)) fail(`${label}: path contains a forbidden character`);
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/u.test(relative)) {
    fail(`${label}: path must be repository-relative`);
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label}: path contains a forbidden segment`);
  }
  const absolute = path.join(root, ...segments);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail(`${label}: path escapes repository root`);
  return { absolute, segments };
}

async function checkedArtifactPath(relative, expected = "any") {
  const { absolute, segments } = strictRelativePath(relative);
  let current = root;
  let info = null;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    info = await lstat(current);
    if (info.isSymbolicLink()) fail("offline artifact path cannot contain symbolic links");
    if (index < segments.length - 1 && !info.isDirectory()) fail("offline artifact ancestor must be a directory");
  }
  assert.equal(current, absolute);
  if (expected === "file" && !info.isFile()) fail("offline artifact leaf must be a regular file");
  if (expected === "directory" && !info.isDirectory()) fail("offline artifact leaf must be a directory");
  return { absolute, info };
}

async function readArtifact(relative, encoding = null) {
  const { absolute } = await checkedArtifactPath(relative, "file");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("offline artifact opened leaf must be a regular file");
    return encoding === null ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

async function discoverDirect(directoryRelative, namePattern) {
  const { absolute } = await checkedArtifactPath(directoryRelative, "directory");
  const discovered = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (!namePattern.test(entry.name)) continue;
    const relative = `${directoryRelative}/${entry.name}`;
    strictRelativePath(relative);
    await checkedArtifactPath(relative, "file");
    discovered.push(relative);
  }
  return discovered.sort();
}

async function recursiveFiles(directoryRelative) {
  const { absolute } = await checkedArtifactPath(directoryRelative, "directory");
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = `${directoryRelative}/${entry.name}`;
    strictRelativePath(relative);
    const { info } = await checkedArtifactPath(relative);
    if (info.isDirectory()) files.push(...await recursiveFiles(relative));
    else {
      if (!info.isFile()) fail("offline artifact example leaf must be a regular file");
      files.push(relative);
    }
  }
  return files.sort();
}

await assertPhysicalRootNoSymlinks(root);

// The fixed manifest path and each of its ancestors are checked before the raw
// bytes are opened. Manifest values never decide which files this process reads.
const manifestRaw = await readArtifact(manifestPath, "utf8");
assertSafeText(manifestRaw, manifestPath);
const manifest = JSON.parse(manifestRaw);
assert.equal(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest), true);
assert.deepEqual(Object.keys(manifest).sort(), ["exampleArtifacts", "scanPolicy", "schemaVersion", "textArtifacts"]);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.scanPolicy, "stage-three-c-two-offline-artifacts-v1");
assert.ok(Array.isArray(manifest.textArtifacts) && Array.isArray(manifest.exampleArtifacts));
for (const relative of [...manifest.textArtifacts, ...manifest.exampleArtifacts]) strictRelativePath(relative, "manifest artifact");
assert.deepEqual(manifest.textArtifacts, trustedTextArtifacts, "manifest text artifacts must exactly match the checker-owned set");

const discoveredTextArtifacts = [
  "README.md",
  ...await discoverDirect("docs", /^offline-input.*\.md$/u),
  ...await discoverDirect("schemas", /^offline-input.*\.schema\.json$/u),
].sort();
assert.deepEqual(discoveredTextArtifacts, [...trustedTextArtifacts].sort(), "offline text discovery must exactly match the checker-owned set");
const discoveredArtifactManifests = await discoverDirect("schemas", /^offline-artifacts.*\.json$/u);
assert.deepEqual(discoveredArtifactManifests, [manifestPath], "offline artifact manifest discovery must be exact");

const actualExamples = await recursiveFiles(exampleRoot);
assert.deepEqual(manifest.exampleArtifacts, actualExamples, "offline example allowlist must cover every discovered file exactly");

for (const relative of trustedTextArtifacts) assertSafeText(await readArtifact(relative, "utf8"), relative);

const sensitiveField = /(?:cookie|token|secret|authorization|password|web_session|xsec|\ba1\b|license|supabase|api[_-]?key)/iu;
const explicitCredentialValue = /(?:bearer\s+|sk-[A-Za-z0-9_-]{8,}|(?:cookie|token|secret|password|web_session|xsec|api[_-]?key)\s*[=:])/iu;
const opaqueValue = /^(?=[A-Za-z0-9+/_=-]{20,}$)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/_=-]+$/u;
const identifierFields = new Set(["accountId", "noteId", "boardId", "mediaId"]);
const cursorFields = new Set(["requestCursor", "nextCursor"]);
const allowedOrigins = new Set(["https://www.xiaohongshu.com", "https://www.rednote.com"]);

function inspectExample(value, key = null, pointer = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(value, explicitCredentialValue, `${pointer}: credential-like value is forbidden`);
    assert.doesNotMatch(value, jwtValue, `${pointer}: JWT-like value is forbidden`);
    assert.doesNotMatch(value, credentialPrefixValue, `${pointer}: credential-prefix value is forbidden`);
    assert.equal(opaqueValue.test(value), false, `${pointer}: opaque token-like value is forbidden`);
    if (key !== null && identifierFields.has(key)) assert.match(value, /^synthetic-/u, `${pointer}: ID must be explicitly synthetic`);
    if (key !== null && cursorFields.has(key)) assert.match(value, /^synthetic-/u, `${pointer}: cursor must be explicitly synthetic`);
    if (key === "id" && pointer.endsWith("/author/id")) assert.match(value, /^synthetic-/u, `${pointer}: author ID must be explicitly synthetic`);
    if (key === "publicUrl") {
      const url = new URL(value);
      assert.equal(allowedOrigins.has(url.origin), true, `${pointer}: unexpected public origin`);
      assert.equal(url.username, ""); assert.equal(url.password, ""); assert.equal(url.search, ""); assert.equal(url.hash, "");
      assert.match(url.pathname, /(?:^|\/)synthetic-/u, `${pointer}: public URL must contain a synthetic path ID`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => inspectExample(item, null, `${pointer}/${index}`)); return; }
  if (value === null || typeof value !== "object") return;
  for (const [field, item] of Object.entries(value)) {
    assert.doesNotMatch(field, sensitiveField, `${pointer}/${field}: credential field is forbidden`);
    inspectExample(item, field, `${pointer}/${field}`);
  }
}

const schema = JSON.parse(await readArtifact("schemas/offline-input-v1.schema.json", "utf8"));
for (const relative of actualExamples.filter((item) => item.endsWith(".json"))) {
  const text = await readArtifact(relative, "utf8");
  assertSafeText(text, relative);
  const example = JSON.parse(text);
  inspectExample(example);
  const result = validateJsonSchema(schema, example);
  assert.equal(result.valid, true, `${relative}: explanatory schema mismatch: ${result.errors.join("; ")}`);
}

assert.deepEqual(await readArtifact(mediaRelative), Buffer.from("GIF89a\nSYNTHETIC OFFLINE TEST BYTES\n", "ascii"));
process.stdout.write(JSON.stringify({ ok: true, textArtifacts: trustedTextArtifacts.length, exampleArtifacts: actualExamples.length }) + "\n");
