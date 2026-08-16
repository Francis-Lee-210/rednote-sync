import assert from "node:assert/strict";
import { collectModuleSpecifiers } from "./typescript-specifier-transform.mjs";

const FORBIDDEN_NETWORK_MODULE = /^node:(?:http|https|http2|net|tls|dns|dgram)$/u;

export function assertStaticModulePolicy(source, label = "source") {
  const specifiers = collectModuleSpecifiers(source);
  for (const { specifier } of specifiers) {
    assert.doesNotMatch(specifier, FORBIDDEN_NETWORK_MODULE, `${label}: network built-in import is forbidden`);
    assert.equal(specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"), true, `${label}: third-party import is forbidden`);
  }
  return specifiers;
}
