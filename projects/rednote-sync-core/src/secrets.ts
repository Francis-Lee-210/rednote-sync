import { inspect } from "node:util";
import { isPrivateNoteAccess } from "./private-access.ts";
import { SafeError } from "./errors.ts";

const SECRET_FIELD = /(?:cookie|token|secret|authorization|password|web_session|xsec|\ba1\b|license|supabase|api[_-]?key)/i;
const URLISH = /^https?:\/\//i;
const TOKENISH = /(?=[A-Za-z0-9+/_-]{16,}={0,2})(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{16,}={0,2}/;
const TOKENISH_GLOBAL = /(?=[A-Za-z0-9+/_-]{16,}={0,2})(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX64 = /^[0-9a-f]{64}$/;

export class MemorySecretRegistry {
  #values = new Set<string>();
  #maxLength = 0;

  register(value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    this.#values.add(value);
    this.#maxLength = Math.max(this.#maxLength, value.length);
  }

  containsIn(value: string): boolean {
    for (const secret of this.#values) if (value.includes(secret)) return true;
    return false;
  }

  get size(): number { return this.#values.size; }
  get scanWindowSize(): number { return Math.max(256, this.#maxLength + 32); }

  toJSON(): never { throw new SafeError("SECURITY_BOUNDARY", "secret registry cannot be serialized"); }

  [inspect.custom](): string { return `<MemorySecretRegistry size=${this.#values.size}>`; }
}

function assertSafeString(value: string, registry: MemorySecretRegistry, key: string | null): void {
  if (registry.containsIn(value)) throw new SafeError("SECURITY_BOUNDARY", "registered secret blocked");
  if (/REDNOTE[_-]?SECRET[_-]?CANARY/i.test(value)) throw new SafeError("SECURITY_BOUNDARY", "secret canary blocked");
  if (URLISH.test(value)) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new SafeError("SECURITY_BOUNDARY", "unsafe URL blocked"); }
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new SafeError("SECURITY_BOUNDARY", "tokenized URL blocked");
  }
  const hashField = key !== null && /(?:sha256|hash|Key|Id|publicUrl|relativePath|failureId|runId|migrationId)$/i.test(key);
  if (!hashField && TOKENISH.test(value) && !HEX64.test(value)) throw new SafeError("SECURITY_BOUNDARY", "token-like value blocked");
}

export function assertPersistenceSafe(value: unknown, registry: MemorySecretRegistry, seen = new WeakSet<object>(), key: string | null = null): void {
  if (typeof value === "string") { assertSafeString(value, registry, key); return; }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return;
  if (typeof value === "function" || typeof value === "symbol") throw new SafeError("SECURITY_BOUNDARY", "non-persistable value blocked");
  if (isPrivateNoteAccess(value) || value instanceof MemorySecretRegistry) throw new SafeError("SECURITY_BOUNDARY", "private value blocked");
  if (typeof value !== "object") return;
  if (seen.has(value)) throw new SafeError("SECURITY_BOUNDARY", "cyclic value blocked");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertPersistenceSafe(item, registry, seen, key);
  } else {
    for (const [field, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(field)) throw new SafeError("SECURITY_BOUNDARY", "sensitive field blocked");
      assertPersistenceSafe(item, registry, seen, field);
    }
  }
  seen.delete(value);
}

export function assertSerializedPersistenceSafe(bytes: Uint8Array | string, registry: MemorySecretRegistry): void {
  const value = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (registry.containsIn(value)) throw new SafeError("SECURITY_BOUNDARY", "registered secret blocked");
  if (/REDNOTE[_-]?SECRET[_-]?CANARY/i.test(value)) throw new SafeError("SECURITY_BOUNDARY", "secret canary blocked");
  const publicUrls: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    try {
      const url = new URL(match[0]!);
      if (url.search || url.hash || url.username || url.password) throw new SafeError("SECURITY_BOUNDARY", "tokenized URL blocked");
      publicUrls.push(match[0]!);
    } catch (error) { if (error instanceof SafeError) throw error; }
  }
  const trimmed = value.trim();
  let structured: unknown | undefined;
  try { structured = JSON.parse(trimmed); }
  catch {
    const lines = trimmed.split(/\r?\n/u).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => line.startsWith("{") || line.startsWith("["))) {
      try { structured = lines.map((line) => JSON.parse(line) as unknown); } catch { structured = undefined; }
    }
  }
  if (structured !== undefined) { assertPersistenceSafe(structured, registry); return; }
  let tokenScanValue = value;
  for (const publicUrl of publicUrls) tokenScanValue = tokenScanValue.replaceAll(publicUrl, "");
  for (const match of tokenScanValue.matchAll(TOKENISH_GLOBAL)) if (!HEX64.test(match[0]!)) throw new SafeError("SECURITY_BOUNDARY", "token-like value blocked");
}

export function validateSafeReason(value: unknown, registry: MemorySecretRegistry): string {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "reason must be text");
  const normalized = value.normalize("NFC").trim();
  const length = [...normalized].length;
  if (length < 1 || length > 80 || /[\u0000-\u001f\u007f=%&]/u.test(normalized) || /https?:\/\//i.test(normalized) || TOKENISH.test(normalized)) {
    throw new SafeError("INVALID_INPUT", "unsafe reason");
  }
  assertPersistenceSafe(normalized, registry);
  return normalized;
}

export interface SafeLogger { info(event: string, fields?: Readonly<Record<string, unknown>>): void; error(event: string, fields?: Readonly<Record<string, unknown>>): void }

export function createSafeLogger(registry: MemorySecretRegistry, sink: (line: string) => void): SafeLogger {
  function write(level: "info" | "error", event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const record = { level, event, fields };
    assertPersistenceSafe(record, registry);
    sink(JSON.stringify(record));
  }
  return { info(event, fields) { write("info", event, fields); }, error(event, fields) { write("error", event, fields); } };
}
