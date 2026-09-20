import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { FORBIDDEN_PACKAGE_PATH } from "./release-package-policy.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cString(buffer) {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero === -1 ? buffer.length : zero).toString("utf8");
}

function tarOctal(buffer, label) {
  const text = cString(buffer).trim();
  assert.match(text, /^[0-7]+$/u, `${label} must be octal`);
  const value = Number.parseInt(text, 8);
  assert.equal(Number.isSafeInteger(value) && value >= 0, true, `${label} must be safe`);
  return value;
}

export function parseReleaseTar(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const files = [];
  const seen = new Set();
  let packageJsonBytes = null;
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.equal(tar.subarray(offset).every((byte) => byte === 0), true, "tar trailer must be zero-filled");
      break;
    }
    const storedChecksum = tarOctal(header.subarray(148, 156), "tar checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(checksumHeader.reduce((sum, byte) => sum + byte, 0), storedChecksum, "tar header checksum mismatch");
    const name = cString(header.subarray(0, 100));
    const prefix = cString(header.subarray(345, 500));
    const archivePath = prefix === "" ? name : `${prefix}/${name}`;
    assert.match(archivePath, /^package\/[A-Za-z0-9._\/-]+$/u, "tar path must remain under package/");
    assert.equal(archivePath.includes("//") || archivePath.includes("/../") || archivePath.includes("/./") || archivePath.includes("\\"), false, "tar path is not normalized");
    const relative = archivePath.slice("package/".length);
    assert.doesNotMatch(relative, FORBIDDEN_PACKAGE_PATH, "forbidden path entered package");
    assert.equal(seen.has(archivePath), false, "tar entries must be unique");
    seen.add(archivePath);
    const size = tarOctal(header.subarray(124, 136), "tar size");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    assert.equal(type, "0", "tar directories, symlinks, and special entries are forbidden");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    assert.equal(contentEnd <= tar.byteLength, true, "tar entry exceeds archive");
    const bytes = tar.subarray(contentStart, contentEnd);
    files.push(Object.freeze({ path: relative, byteLength: size, sha256: sha256(bytes) }));
    if (relative === "package.json") {
      assert.equal(packageJsonBytes, null, "tar package.json must be unique");
      packageJsonBytes = Buffer.from(bytes);
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  assert.equal(offset < tar.byteLength, true, "tar trailer missing");
  assert.notEqual(packageJsonBytes, null, "tar package.json is required");
  return Object.freeze({
    inventory: Object.freeze(files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))),
    packageJsonBytes,
  });
}
