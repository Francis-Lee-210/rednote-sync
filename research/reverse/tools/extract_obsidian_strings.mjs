#!/usr/bin/env node

/**
 * Offline/static helper for the bundled RedNote Sync Obsidian client.
 *
 * Safety boundary: this script treats main.js as text. It never imports,
 * requires, evals, or executes any code from the plugin bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SUPPORTED_SOURCE_SHA256 = "5ce6a362f4cbd0542caecb1e37ab0c1c20f27b9164890da1c80f8a682cb194b7";

function usage() {
  console.error(
    "Usage: node research/reverse/tools/extract_obsidian_strings.mjs <main.js> <strings.tsv> [deobfuscated.js]",
  );
  process.exit(2);
}

function canonicalizePath(targetPath) {
  const absolutePath = path.resolve(targetPath);
  let existingAncestor = absolutePath;
  const missingSegments = [];

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = fs.realpathSync(existingAncestor);
  return path.join(canonicalAncestor, ...missingSegments);
}

function canonicalIdentity(targetPath) {
  const canonicalPath = canonicalizePath(targetPath);
  if (process.platform === "darwin" || process.platform === "win32") {
    return canonicalPath.normalize("NFC").toLowerCase();
  }
  return canonicalPath;
}

function existingInode(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

function assertNoPathCollisions(paths) {
  const inspected = paths.map(({ label, targetPath }) => ({
    label,
    targetPath,
    resolvedPath: path.resolve(targetPath),
    canonicalPath: canonicalIdentity(targetPath),
    inode: existingInode(targetPath),
  }));

  for (let leftIndex = 0; leftIndex < inspected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inspected.length; rightIndex += 1) {
      const left = inspected[leftIndex];
      const right = inspected[rightIndex];
      const sameResolvedPath = left.resolvedPath === right.resolvedPath;
      const sameCanonicalPath = left.canonicalPath === right.canonicalPath;
      const sameInode = left.inode !== null && left.inode === right.inode;
      if (sameResolvedPath || sameCanonicalPath || sameInode) {
        throw new Error(
          `Path collision: ${left.label} (${left.resolvedPath}) and ` +
            `${right.label} (${right.resolvedPath}) refer to the same target`,
        );
      }
    }
  }
}

function stageAtomicWrite(targetPath, data) {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${basename}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, data, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return { targetPath, temporaryPath };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (!cleanupError || cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function commitAtomicWrites(outputs) {
  const staged = [];
  try {
    for (const output of outputs) staged.push(stageAtomicWrite(output.targetPath, output.data));
    for (const entry of staged) fs.renameSync(entry.temporaryPath, entry.targetPath);
  } finally {
    for (const entry of staged) {
      try {
        fs.unlinkSync(entry.temporaryPath);
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
  }
}

function readStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') {
    throw new Error(`Expected string literal at byte ${start}`);
  }
  let value = "";
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor++];
    if (char === quote) return { value, end: cursor };
    if (char !== "\\") {
      value += char;
      continue;
    }

    if (cursor >= source.length) throw new Error("Unterminated escape sequence");
    const escaped = source[cursor++];
    const simple = {
      "'": "'",
      '"': '"',
      "\\": "\\",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped];
    } else if (escaped === "x") {
      const hex = source.slice(cursor, cursor + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("Invalid \\x escape");
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      cursor += 2;
    } else if (escaped === "u") {
      if (source[cursor] === "{") {
        const endBrace = source.indexOf("}", cursor + 1);
        if (endBrace === -1) throw new Error("Invalid \\u{} escape");
        const hex = source.slice(cursor + 1, endBrace);
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("Invalid \\u{} escape");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor = endBrace + 1;
      } else {
        const hex = source.slice(cursor, cursor + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid \\u escape");
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor += 4;
      }
    } else if (escaped === "\n") {
      // JavaScript line continuation.
    } else if (escaped === "\r") {
      if (source[cursor] === "\n") cursor += 1;
    } else {
      // JavaScript permits identity escapes in non-strict string literals.
      value += escaped;
    }
  }
  throw new Error("Unterminated string literal");
}

function extractEncodedArray(source) {
  const marker = "function _0xa56a(){const ";
  const functionStart = source.indexOf(marker);
  if (functionStart === -1) throw new Error("String-table function not found");
  const arrayStart = source.indexOf("[", functionStart + marker.length);
  if (arrayStart === -1) throw new Error("String-table array not found");

  const values = [];
  let cursor = arrayStart + 1;
  while (cursor < source.length) {
    while (/\s|,/.test(source[cursor])) cursor += 1;
    if (source[cursor] === "]") return values;
    const parsed = readStringLiteral(source, cursor);
    values.push(parsed.value);
    cursor = parsed.end;
  }
  throw new Error("Unterminated string-table array");
}

function decodeBase64Utf8(encoded) {
  // The bundle uses a non-standard alphabet: lowercase precedes uppercase.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const char of encoded) {
    const value = alphabet.indexOf(char);
    if (value < 0 || value === 64) break;
    bitBuffer = bitBuffer * 64 + value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >> bitCount) & 0xff);
      bitBuffer &= (1 << bitCount) - 1;
    }
  }
  const percentEncoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  return decodeURIComponent(percentEncoded);
}

function jsParseInt(value) {
  const match = String(value).trimStart().match(/^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)/);
  if (!match) return Number.NaN;
  return Number.parseInt(match[0], 0);
}

function rotateTable(encoded) {
  const table = [...encoded];
  const offset = 0xc4;
  const target = 790822;
  const decodedAt = (index) => decodeBase64Utf8(table[index - offset]);
  let closest = { rotations: -1, delta: Number.POSITIVE_INFINITY, checksum: Number.NaN };
  for (let rotations = 0; rotations < table.length * 2; rotations += 1) {
    const checksum =
      jsParseInt(decodedAt(0x158)) / 1 +
      (jsParseInt(decodedAt(0x10a)) / 2) * (-jsParseInt(decodedAt(0x5ea)) / 3) +
      jsParseInt(decodedAt(0x26a)) / 4 -
      jsParseInt(decodedAt(0x422)) / 5 +
      (jsParseInt(decodedAt(0x52c)) / 6) * (-jsParseInt(decodedAt(0x4ea)) / 7) -
      (jsParseInt(decodedAt(0x604)) / 8) * (-jsParseInt(decodedAt(0x4af)) / 9) +
      (jsParseInt(decodedAt(0x254)) / 10) * (-jsParseInt(decodedAt(0x2c1)) / 11);
    if (Number.isFinite(checksum) && Math.abs(checksum - target) < closest.delta) {
      closest = { rotations, delta: Math.abs(checksum - target), checksum };
    }
    if (checksum === target) return { table, offset, rotations };
    table.push(table.shift());
  }
  throw new Error(
    `Unable to reproduce the bundle's string-table rotation ` +
      `(entries=${encoded.length}; numericEntries=${encoded
        .map(decodeBase64Utf8)
        .filter((value) => Number.isFinite(jsParseInt(value))).length}; ` +
      `closest=${JSON.stringify(closest)})`,
  );
}

function replaceNumericObjectMembers(source) {
  const constants = new Map();
  const objectPattern = /(?:const|let|var|,)\s*(_0x[0-9a-f]+)\s*=\s*\{([^{}]*)\}/g;
  for (const objectMatch of source.matchAll(objectPattern)) {
    const objectName = objectMatch[1];
    const body = objectMatch[2];
    const propertyPattern = /(_0x[0-9a-f]+)\s*:\s*(0x[0-9a-f]+|\d+)/g;
    for (const propertyMatch of body.matchAll(propertyPattern)) {
      constants.set(`${objectName}.${propertyMatch[1]}`, propertyMatch[2]);
    }
  }

  let output = source;
  for (const [name, value] of constants) {
    output = output.replaceAll(name, value);
  }
  return { output, constants: constants.size };
}

function replaceDirectDecoderCalls(source, decoded, offset) {
  const aliases = new Set(["_0x5555", "_0x1fb0c9", "_0x409414"]);
  const aliasPattern = /\b(_0x[0-9a-f]+)\s*=\s*_0x5555\b/g;
  for (const match of source.matchAll(aliasPattern)) aliases.add(match[1]);

  let replacements = 0;
  let output = source;
  for (const alias of aliases) {
    const callPattern = new RegExp(`\\b${alias}\\((0x[0-9a-f]+|\\d+)\\)`, "g");
    output = output.replace(callPattern, (whole, rawIndex) => {
      const index = Number.parseInt(rawIndex, 0) - offset;
      if (index < 0 || index >= decoded.length) return whole;
      replacements += 1;
      return JSON.stringify(decoded[index]);
    });
  }
  return { output, aliases: aliases.size, replacements };
}

const [, , sourceArg, stringsArg, deobfuscatedArg] = process.argv;
if (!sourceArg || !stringsArg) usage();

const sourcePath = path.resolve(sourceArg);
const stringsPath = path.resolve(stringsArg);
const deobfuscatedPath = deobfuscatedArg ? path.resolve(deobfuscatedArg) : null;
const pathRoles = [
  { label: "source", targetPath: sourcePath },
  { label: "strings output", targetPath: stringsPath },
];
if (deobfuscatedPath) {
  pathRoles.push({ label: "deobfuscated output", targetPath: deobfuscatedPath });
}
assertNoPathCollisions(pathRoles);

const sourceBuffer = fs.readFileSync(sourcePath);
const sourceHash = createHash("sha256").update(sourceBuffer).digest("hex");
if (sourceHash !== SUPPORTED_SOURCE_SHA256) {
  throw new Error(
    `Unsupported source SHA-256: ${sourceHash}; expected ${SUPPORTED_SOURCE_SHA256}`,
  );
}
const source = sourceBuffer.toString("utf8");
const encoded = extractEncodedArray(source);
const { table, offset, rotations } = rotateTable(encoded);
const decoded = table.map(decodeBase64Utf8);

const tsv = ["index\tvalue"];
for (let index = 0; index < decoded.length; index += 1) {
  tsv.push(`0x${(index + offset).toString(16)}\t${JSON.stringify(decoded[index])}`);
}
const outputs = [{ targetPath: stringsPath, data: `${tsv.join("\n")}\n` }];

let deobfuscationSummary = "";
if (deobfuscatedPath) {
  const constantsPass = replaceNumericObjectMembers(source);
  const decoderPass = replaceDirectDecoderCalls(constantsPass.output, decoded, offset);
  outputs.push({ targetPath: deobfuscatedPath, data: decoderPass.output });
  deobfuscationSummary =
    `; numeric members=${constantsPass.constants}; decoder aliases=${decoderPass.aliases}` +
    `; direct calls replaced=${decoderPass.replacements}`;
}
commitAtomicWrites(outputs);

console.log(
  `decoded ${decoded.length} strings; rotations=${rotations}; offset=0x${offset.toString(16)}${deobfuscationSummary}`,
);
