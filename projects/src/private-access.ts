import { inspect } from "node:util";
import { SafeError } from "./errors.ts";

const PRIVATE_NOTE_ACCESS: unique symbol = Symbol("private-note-access");
const instances = new WeakSet<object>();
const secrets = new WeakMap<object, string | null>();

export interface PrivateNoteAccess {
  readonly [PRIVATE_NOTE_ACCESS]: true;
  use<T>(consumer: (secret: string | null) => T): T;
  toJSON(): never;
}

export function createPrivateNoteAccess(secret: string | null): PrivateNoteAccess {
  if (secret !== null && typeof secret !== "string") throw new SafeError("INVALID_INPUT", "invalid private access");
  const target = Object.create(null) as PrivateNoteAccess & Record<PropertyKey, unknown>;
  const instance = new Proxy(target, {}) as PrivateNoteAccess & Record<PropertyKey, unknown>;
  Object.defineProperties(target, {
    [PRIVATE_NOTE_ACCESS]: { value: true, enumerable: false, writable: false, configurable: false },
    use: {
      value<T>(consumer: (value: string | null) => T): T {
        if (!instances.has(instance)) throw new SafeError("SECURITY_BOUNDARY", "invalid private access");
        return consumer(secrets.get(instance) ?? null);
      },
      enumerable: false,
      writable: false,
      configurable: false,
    },
    toJSON: {
      value(): never { throw new SafeError("SECURITY_BOUNDARY", "private access cannot be serialized"); },
      enumerable: false,
      writable: false,
      configurable: false,
    },
    [inspect.custom]: {
      value(): string { return "<PrivateNoteAccess:rejected>"; },
      enumerable: false,
      writable: false,
      configurable: false,
    },
  });
  secrets.set(instance, secret);
  instances.add(instance);
  Object.freeze(target);
  return instance;
}

export function isPrivateNoteAccess(value: unknown): value is PrivateNoteAccess {
  return value !== null && typeof value === "object" && instances.has(value);
}

export function consumePrivateNoteAccess<T>(access: PrivateNoteAccess, consumer: (secret: string | null) => T): T {
  if (!isPrivateNoteAccess(access)) throw new SafeError("SECURITY_BOUNDARY", "invalid private access");
  return access.use(consumer);
}
