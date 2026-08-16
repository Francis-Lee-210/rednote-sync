import { createHash, timingSafeEqual } from "node:crypto";

export function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort(utf8Compare)) {
      const item = input[key];
      if (item !== undefined) output[key.normalize("NFC")] = normalize(item);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalBytes(value));
}

export function equalHexConstantTime(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
