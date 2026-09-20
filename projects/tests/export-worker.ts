import { exportAccount } from "../src/projectors.ts";
import { decodeAccountId } from "../src/types.ts";
const [root, accountId] = process.argv.slice(2);
process.on("message", () => {});
await exportAccount(root!, { hostId: "xhs", accountId: decodeAccountId(accountId) }, { async onCheckpoint(point) {
  if (point.phase === "after_stable_file") { process.send?.({ ready: true }); await new Promise(() => {}); }
} });
