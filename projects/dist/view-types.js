import { SafeError } from "./errors.js";
import { decodeRelativePath } from "./paths.js";
import { decodeSha256 } from "./types.js";
export const PROJECTOR_ORDER = Object.freeze(["notes", "assets", "index", "failures", "runs"]);
export function assertProjectorNamespace(accountKey, projectorId, relativePath) {
    const key = decodeSha256(accountKey);
    const relative = decodeRelativePath(relativePath);
    const prefix = `accounts/${key}/`;
    if (!relative.startsWith(prefix))
        throw new SafeError("SECURITY_BOUNDARY", "projector path escaped account namespace");
    const local = relative.slice(prefix.length);
    const digest = "[0-9a-f]{64}";
    const allowed = projectorId === "notes"
        ? new RegExp(`^(?:notes/${digest}\\.md|data/notes/${digest}\\.json)$`)
        : projectorId === "assets"
            ? new RegExp(`^assets/${digest}/(?:cover|image|video)-[1-9][0-9]*\\.(?:png|jpg|gif|webp|mp4|bin)$`)
            : projectorId === "index"
                ? /^(?:account\.json|data\/index\.(?:json|csv))$/
                : projectorId === "failures"
                    ? /^data\/failures\.json$/
                    : projectorId === "runs"
                        ? /^logs\/export-runs\.jsonl$/
                        : null;
    if (!allowed || !allowed.test(local))
        throw new SafeError("SECURITY_BOUNDARY", "path is outside projector namespace");
}
