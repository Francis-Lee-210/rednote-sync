import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertStaticModulePolicy } from "./module-import-policy.mjs";
import { assertReleasePackagePolicy } from "./release-package-policy.mjs";

const root = process.cwd();
assertReleasePackagePolicy(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
let checkedFiles = 0;
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.[cm]?[jt]s$/u.test(entry.name)) {
      assert.ok(entry.isFile(), "runtime sources must be regular files");
      assertStaticModulePolicy(await readFile(file, "utf8"), file);
      checkedFiles += 1;
    }
  }
}
await checkDirectory(path.join(root, "src"));
await checkDirectory(path.join(root, "dist"));
process.stdout.write(`${JSON.stringify({ ok: true, checkedFiles })}\n`);
