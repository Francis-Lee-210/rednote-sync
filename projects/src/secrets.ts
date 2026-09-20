import { inspect } from "node:util";
import { isPrivateNoteAccess } from "./private-access.ts";
import { SafeError } from "./errors.ts";

const SECRET_FIELD = /^(?:cookies?|token|(?:access|refresh|id|xsec)[_-]?token|secret|authorization|password|web_session|a1|api[_-]?key)$/i;
const CANARY = /REDNOTE[_-]?SECRET[_-]?CANARY/i;
const CANARY_BYTES = ["REDNOTE_SECRET_CANARY", "REDNOTE-SECRET-CANARY", "REDNOTESECRETCANARY"].flatMap((value) => [Buffer.from(value), Buffer.from(value.toLowerCase())]);

export class MemorySecretRegistry {
  #values = new Set<string>();
  #bytes: Buffer[] = [];
  #maxLength = 0;

  register(value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    if (this.#values.has(value)) return;
    this.#values.add(value);
    const bytes = Buffer.from(value);
    this.#bytes.push(bytes);
    this.#maxLength = Math.max(this.#maxLength, bytes.length);
  }

  containsIn(value: string): boolean {
    for (const secret of this.#values) if (value.includes(secret)) return true;
    return false;
  }

  containsInBytes(value: Uint8Array): boolean {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return this.#bytes.some((secret) => bytes.includes(secret));
  }

  get size(): number { return this.#values.size; }
  get scanWindowSize(): number { return Math.max(256, this.#maxLength + 32); }

  toJSON(): never { throw new SafeError("SECURITY_BOUNDARY", "secret registry cannot be serialized"); }

  [inspect.custom](): string { return `<MemorySecretRegistry size=${this.#values.size}>`; }
}

function assertSafeString(value: string, registry: MemorySecretRegistry): void {
  if (registry.containsIn(value)) throw new SafeError("SECURITY_BOUNDARY", "registered secret blocked");
  if (CANARY.test(value)) throw new SafeError("SECURITY_BOUNDARY", "secret canary blocked");
}

export function assertPersistenceSafe(value: unknown, registry: MemorySecretRegistry, seen = new WeakSet<object>()): void {
  if (typeof value === "string") { assertSafeString(value, registry); return; }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return;
  if (typeof value === "function" || typeof value === "symbol") throw new SafeError("SECURITY_BOUNDARY", "non-persistable value blocked");
  if (isPrivateNoteAccess(value) || value instanceof MemorySecretRegistry) throw new SafeError("SECURITY_BOUNDARY", "private value blocked");
  if (typeof value !== "object") return;
  if (seen.has(value)) throw new SafeError("SECURITY_BOUNDARY", "cyclic value blocked");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertPersistenceSafe(item, registry, seen);
  } else {
    for (const [field, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(field)) throw new SafeError("SECURITY_BOUNDARY", "sensitive field blocked");
      assertPersistenceSafe(item, registry, seen);
    }
  }
  seen.delete(value);
}

export function assertSerializedPersistenceSafe(bytes: Uint8Array | string, registry: MemorySecretRegistry): void {
  if (typeof bytes === "string") assertSafeString(bytes, registry);
  else assertKnownSecretBytes(bytes, registry);
}

/** Byte matching for a bounded streaming window; media is never interpreted as text. */
export function assertKnownSecretBytes(value: Uint8Array, registry: MemorySecretRegistry): void {
  if (registry.containsInBytes(value)) throw new SafeError("SECURITY_BOUNDARY", "registered secret blocked");
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (CANARY_BYTES.some((canary) => bytes.includes(canary))) throw new SafeError("SECURITY_BOUNDARY", "secret canary blocked");
}

export function validateSafeReason(value: unknown, registry: MemorySecretRegistry): string {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "reason must be text");
  const normalized = value.normalize("NFC").trim();
  const length = [...normalized].length;
  if (length < 1 || length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
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
