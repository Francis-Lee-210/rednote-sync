import { SafeError } from "./errors.ts";
import { decodeRelativePath } from "./paths.ts";
import { decodeSha256, type AccountKey, type AccountPartition, type RelativePath, type RunRecord, type Sha256 } from "./types.ts";

export type ProjectorId = "notes" | "assets" | "index" | "failures" | "runs";
export const PROJECTOR_ORDER = Object.freeze(["notes", "assets", "index", "failures", "runs"] as const);

export function assertProjectorNamespace(accountKey: AccountKey, projectorId: ProjectorId, relativePath: RelativePath): void {
  const key = decodeSha256(accountKey);
  const relative = decodeRelativePath(relativePath);
  const prefix = `accounts/${key}/`;
  if (!relative.startsWith(prefix)) throw new SafeError("SECURITY_BOUNDARY", "projector path escaped account namespace");
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
  if (!allowed || !allowed.test(local)) throw new SafeError("SECURITY_BOUNDARY", "path is outside projector namespace");
}

export interface DerivedViewReceipt {
  readonly projectorId: ProjectorId;
  readonly accountKey: AccountKey;
  readonly generation: number;
  readonly relativePath: RelativePath;
  readonly sha256: Sha256;
  readonly byteLength: number;
}
export type ProjectionOutcome = { readonly projectorId: ProjectorId; readonly accountKey: AccountKey; readonly generation: number; readonly complete: true; readonly receipts: readonly DerivedViewReceipt[]; readonly safeError: null }
  | { readonly projectorId: ProjectorId; readonly accountKey: AccountKey; readonly generation: number; readonly complete: false; readonly receipts?: readonly DerivedViewReceipt[]; readonly safeError: string };
export interface ProjectionContext { readonly plannedGeneration: number; readonly pendingRun: RunRecord | null }

export interface ProjectorReadView {
  readonly account: AccountPartition;
  manifests(): Iterable<import("./types.ts").NoteManifest>;
  tasks(): Iterable<import("./types.ts").TaskRecord>;
  failures(): Iterable<import("./types.ts").FailureRecord>;
  runs(): Iterable<RunRecord>;
}
