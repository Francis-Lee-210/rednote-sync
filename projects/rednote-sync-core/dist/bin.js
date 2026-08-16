#!/usr/bin/env node
import { currentRuntimeSupport, unsupportedRuntimeRecord } from "./runtime.js";

const support = currentRuntimeSupport();
if (!support.supported) {
  process.stdout.write(`${JSON.stringify(unsupportedRuntimeRecord(support))}\n`);
  process.stderr.write('{"level":"error","event":"unsupported_runtime"}\n');
  process.exitCode = 6;
} else {
  try {
    const { main } = await import("./cli.js");
    await main();
  } catch {
    process.stdout.write('{"ok":false,"command":null,"exitCode":1,"error":{"category":"INTERNAL"}}\n');
    process.stderr.write('{"level":"error","event":"cli_start_failed"}\n');
    process.exitCode = 1;
  }
}
