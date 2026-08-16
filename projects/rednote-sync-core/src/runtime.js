export const SUPPORTED_NODE_MAJOR = 26;
export const SUPPORTED_PLATFORM = "darwin";

export function decodeRuntimeSupport(input) {
  const nodeVersion = input?.nodeVersion;
  const platform = input?.platform;
  const match = typeof nodeVersion === "string" ? /^(0|[1-9][0-9]*)\./u.exec(nodeVersion) : null;
  const nodeMajor = match === null ? null : Number(match[1]);
  if (nodeMajor === null || !Number.isSafeInteger(nodeMajor)) {
    return Object.freeze({ supported: false, nodeMajor: null, nodeSupported: false, platformSupported: platform === SUPPORTED_PLATFORM, reason: "INVALID_NODE_VERSION" });
  }
  if (nodeMajor !== SUPPORTED_NODE_MAJOR) {
    return Object.freeze({ supported: false, nodeMajor, nodeSupported: false, platformSupported: platform === SUPPORTED_PLATFORM, reason: "UNSUPPORTED_NODE_MAJOR" });
  }
  if (platform !== SUPPORTED_PLATFORM) {
    return Object.freeze({ supported: false, nodeMajor, nodeSupported: true, platformSupported: false, reason: "UNSUPPORTED_PLATFORM" });
  }
  return Object.freeze({ supported: true, nodeMajor, nodeSupported: true, platformSupported: true, reason: null });
}

export function currentRuntimeSupport() {
  return decodeRuntimeSupport({ nodeVersion: process.versions.node, platform: process.platform });
}

export function unsupportedRuntimeRecord(support) {
  return Object.freeze({
    ok: false,
    command: null,
    exitCode: 6,
    error: Object.freeze({ category: "STATE", code: support.reason ?? "UNSUPPORTED_RUNTIME" }),
  });
}
