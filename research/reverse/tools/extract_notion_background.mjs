#!/usr/bin/env node

/**
 * Offline/static indexer for the bundled Rednote2Notion background worker.
 *
 * The input is treated as UTF-8 text only. This tool never imports, requires,
 * evaluates, parses as an executable module, or otherwise runs bundle code.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SUPPORTED_SOURCE_SHA256 =
  "31aac68e5e6a473eb2ba7962a112cad7cdd87d809fb92bda3df1d0b136d6ecf7";

function usage() {
  console.error(
    "Usage: node research/reverse/tools/extract_notion_background.mjs " +
      "<static/background/index.js> <module-index.tsv> [modules.txt]",
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

  return path.join(fs.realpathSync(existingAncestor), ...missingSegments);
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

function conservativeCaseFoldIdentity(canonicalPath) {
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  return canonicalPath.normalize("NFC").toLowerCase();
}

function assertNoPathCollisions(paths) {
  const inspected = paths.map(({ label, targetPath }) => {
    const canonicalPath = canonicalizePath(targetPath);
    return {
      label,
      resolvedPath: path.resolve(targetPath),
      canonicalPath,
      caseFoldIdentity: conservativeCaseFoldIdentity(canonicalPath),
      inode: existingInode(targetPath),
    };
  });

  for (let leftIndex = 0; leftIndex < inspected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inspected.length; rightIndex += 1) {
      const left = inspected[leftIndex];
      const right = inspected[rightIndex];
      if (
        left.resolvedPath === right.resolvedPath ||
        left.canonicalPath === right.canonicalPath ||
        (left.caseFoldIdentity !== null &&
          left.caseFoldIdentity === right.caseFoldIdentity) ||
        (left.inode !== null && left.inode === right.inode)
      ) {
        throw new Error(`Path collision: ${left.label} and ${right.label}`);
      }
    }
  }
}

function stageAtomicWrite(targetPath, data) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
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

function findParcelModules(source) {
  const starts = [];
  const marker = /(?:^|[{,])["']?([A-Za-z0-9]+)["']?:\[function\(/g;
  for (const match of source.matchAll(marker)) {
    const prefixLength = match[0].startsWith("{") || match[0].startsWith(",") ? 1 : 0;
    starts.push({ id: match[1], sourceStart: match.index + prefixLength });
  }
  if (starts.length === 0) throw new Error("No Parcel module records found");

  const labelsById = new Map();
  const dependency = /["']([^"'\r\n]+)["']\s*:\s*["']([A-Za-z0-9]+)["']/g;
  for (const match of source.matchAll(dependency)) {
    const labels = labelsById.get(match[2]) || new Set();
    labels.add(match[1]);
    labelsById.set(match[2], labels);
  }

  return starts.map((record, index) => {
    const sourceEnd = index + 1 < starts.length ? starts[index + 1].sourceStart : source.length;
    const start = Buffer.byteLength(source.slice(0, record.sourceStart), "utf8");
    const end = start + Buffer.byteLength(source.slice(record.sourceStart, sourceEnd), "utf8");
    return {
      ...record,
      sourceEnd,
      start,
      end,
      labels: [...(labelsById.get(record.id) || [])].sort(),
    };
  });
}

if (process.argv.length < 4 || process.argv.length > 5) usage();

const [sourcePath, indexPath, modulesPath] = process.argv
  .slice(2)
  .map((argument) => path.resolve(argument));
const pathSet = [
  { label: "source", targetPath: sourcePath },
  { label: "module index", targetPath: indexPath },
];
if (modulesPath) pathSet.push({ label: "module dump", targetPath: modulesPath });
assertNoPathCollisions(pathSet);

const source = fs.readFileSync(sourcePath, "utf8");
const actualHash = createHash("sha256").update(source).digest("hex");
if (actualHash !== SUPPORTED_SOURCE_SHA256) {
  throw new Error(
    `Unsupported source SHA-256: ${actualHash}; expected ${SUPPORTED_SOURCE_SHA256}`,
  );
}

const modules = findParcelModules(source);
const index = [
  "id\tstart_byte\tend_byte_exclusive\tbytes\tlabels",
  ...modules.map(
    (module) =>
      `${module.id}\t${module.start}\t${module.end}\t${module.end - module.start}` +
      `\t${module.labels.join(",")}`,
  ),
].join("\n") + "\n";

const outputs = [{ targetPath: indexPath, data: index }];
if (modulesPath) {
  const moduleDump = modules
    .map(
      (module) =>
        `\n===== MODULE ${module.id} | ${module.labels.join(",")} =====\n` +
        source.slice(module.sourceStart, module.sourceEnd),
    )
    .join("");
  outputs.push({ targetPath: modulesPath, data: moduleDump });
}
commitAtomicWrites(outputs);

console.log(`indexed ${modules.length} Parcel modules from locked background sample`);
