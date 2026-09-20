import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { FixtureSession, type OfflineInputMode } from "../src/offline-input.ts";
import { getHostAdapter } from "../src/host-adapter.ts";
import { accountPartition, decodeIsoDateTime, decodeNoteId, type PartitionScope } from "../src/types.ts";

export const stage3bNow = decodeIsoDateTime("2026-03-01T00:00:00.000Z");

export function fixtureAccount(scope: PartitionScope): unknown {
  return { schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, displayName: "Synthetic", firstSeenAt: stage3bNow, lastSeenAt: stage3bNow };
}

export function fixtureDetail(scope: PartitionScope, noteId: string, options: { readonly body?: string; readonly media?: readonly unknown[]; readonly revisionAt?: string | null } = {}): unknown {
  return {
    note: {
      schemaVersion: 1, hostId: scope.hostId, accountId: scope.accountId, noteId,
      publicUrl: getHostAdapter(scope.hostId).publicNoteUrl(decodeNoteId(noteId)),
      title: "Synthetic", body: options.body ?? "offline body", noteType: options.media?.length ? "image" : "text",
      author: { id: "author", name: "Author", publicUrl: null },
      publishedAt: stage3bNow, updatedAt: stage3bNow, capturedAt: stage3bNow, tags: ["offline"],
      metrics: { liked: 1, collected: 0, commented: 0, shared: 0 },
      memberships: [{ target: scope.target, boardId: scope.boardId, boardName: scope.target === "collected_album" ? "Synthetic album" : null, observedAt: stage3bNow }],
    },
    revisionAt: options.revisionAt === undefined ? stage3bNow : options.revisionAt,
    claimedPayloadSha256: null,
    mediaSetComplete: true,
    media: options.media ?? [],
  };
}

export function fixturePage(scope: PartitionScope, requestCursor: string | null, items: readonly string[], options: { readonly nextCursor?: string | null; readonly hasMore?: boolean; readonly details?: readonly unknown[]; readonly listFailure?: unknown } = {}): unknown {
  const page: Record<string, unknown> = {
    scope,
    requestCursor,
    nextCursor: options.nextCursor ?? null,
    hasMore: options.hasMore ?? false,
    items: items.map((noteId) => ({ noteId })),
    details: options.details ?? items.map((noteId) => fixtureDetail(scope, noteId)),
  };
  if (options.listFailure !== undefined) page.listFailure = options.listFailure;
  return page;
}

export function fixtureFailure(category: "AUTH_REQUIRED" | "RATE_LIMITED" | "NETWORK" | "PROTOCOL" | "DETAIL" | "MEDIA" | "EXPORT", retryAt: string | null = null): unknown {
  return { category, retryAt };
}

export async function openStage3bFixture(root: string, scope: PartitionScope, pages: readonly unknown[], retryItems: readonly unknown[] = [], mode: OfflineInputMode = "fixture", fileName = "fixture.json", accountOverride?: unknown): Promise<FixtureSession> {
  const target = await writeStage3bEnvelope(root, scope, pages, retryItems, mode, fileName, accountOverride);
  return FixtureSession.open({ inputRoot: await realpath(root), inputFile: fileName, mode, account: accountPartition(scope) });
}

export async function writeStage3bEnvelope(root: string, scope: PartitionScope, pages: readonly unknown[], retryItems: readonly unknown[] = [], mode: OfflineInputMode = "fixture", fileName = "fixture.json", accountOverride?: unknown): Promise<string> {
  const target = path.join(root, fileName);
  await writeFile(target, JSON.stringify({ schemaVersion: 1, mode, account: accountOverride ?? fixtureAccount(scope), pages, retryItems }));
  return realpath(target);
}
