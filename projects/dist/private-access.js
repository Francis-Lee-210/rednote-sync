import { inspect } from "node:util";
import { SafeError } from "./errors.js";
const PRIVATE_NOTE_ACCESS = Symbol("private-note-access");
const instances = new WeakSet();
const secrets = new WeakMap();
export function createPrivateNoteAccess(secret) {
    if (secret !== null && typeof secret !== "string")
        throw new SafeError("INVALID_INPUT", "invalid private access");
    const target = Object.create(null);
    const instance = new Proxy(target, {});
    Object.defineProperties(target, {
        [PRIVATE_NOTE_ACCESS]: { value: true, enumerable: false, writable: false, configurable: false },
        use: {
            value(consumer) {
                if (!instances.has(instance))
                    throw new SafeError("SECURITY_BOUNDARY", "invalid private access");
                return consumer(secrets.get(instance) ?? null);
            },
            enumerable: false,
            writable: false,
            configurable: false,
        },
        toJSON: {
            value() { throw new SafeError("SECURITY_BOUNDARY", "private access cannot be serialized"); },
            enumerable: false,
            writable: false,
            configurable: false,
        },
        [inspect.custom]: {
            value() { return "<PrivateNoteAccess:rejected>"; },
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
export function isPrivateNoteAccess(value) {
    return value !== null && typeof value === "object" && instances.has(value);
}
export function consumePrivateNoteAccess(access, consumer) {
    if (!isPrivateNoteAccess(access))
        throw new SafeError("SECURITY_BOUNDARY", "invalid private access");
    return access.use(consumer);
}
