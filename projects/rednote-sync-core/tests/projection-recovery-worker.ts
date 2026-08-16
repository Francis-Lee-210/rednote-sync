import { writeFile } from "node:fs/promises";
import path from "node:path";
import { requestScopePause } from "../src/control.ts";
import { SyncEngine } from "../src/sync-engine.ts";
import { makeScope } from "./helpers.ts";
import { fixtureDetail, openStage3bFixture, stage3bNow } from "./stage3b-fixtures.ts";

const [root, rawIndex] = process.argv.slice(2);
if (!root || !/^(?:0|[1-9][0-9]*)$/u.test(rawIndex ?? "")) process.exit(2);
const targetIndex = Number(rawIndex);
const scope = makeScope("recover3");
await writeFile(path.join(root, "recovery-new-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x21]));
await writeFile(path.join(root, "recovery-new-2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x22]));
const update = fixtureDetail(scope, "recovery-note", {
  body: "body v2",
  revisionAt: "2026-03-02T00:00:00.000Z",
  media: [
    { kind: "image", ordinal: 1, mediaId: "media-v2-1", relativePath: "recovery-new-1.png" },
    { kind: "image", ordinal: 2, mediaId: "media-v2-2", relativePath: "recovery-new-2.png" },
  ],
});
const session = await openStage3bFixture(root, scope, [], [{ scope, noteId: "recovery-note", detail: update }], "fixture", "projection-recovery-worker.json");
let pauseRequested = false;
const hold = (point: { readonly index: number; readonly total: number; readonly kind: string; readonly relativePath: string }) => {
  process.stdout.write(`READY:undo:${JSON.stringify(point)}\n`);
  setInterval(() => {}, 10_000);
};
const result = await new SyncEngine({
  root,
  scope,
  session,
  clock: Object.freeze({ now: () => stage3bNow, sleep: async () => {} }),
  minimumIntervalMs: 0,
  projectionBoundaryObserver: async (point) => {
    if (!pauseRequested && point.projectorId === "index" && point.phase === "after_projector") {
      pauseRequested = true;
      await requestScopePause(root, scope);
    }
  },
  projectionRecoveryObserver: (point) => {
    if (point.phase === "after_restore_action" && point.index === targetIndex) hold(point);
  },
}).retryFailures(new AbortController().signal);
session.close();
process.stderr.write(`worker completed before target action: ${JSON.stringify(result)}\n`);
process.exit(3);
