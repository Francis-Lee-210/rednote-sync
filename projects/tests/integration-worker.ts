import { bytesIterable } from "../src/object-store.ts";
import { renderNoteJsonBytes, renderNoteMarkdownBytes } from "../src/exporters.ts";
import { indexEntryDigest, mergeCanonicalNote, noteCsvRowDigest } from "../src/merge.ts";
import { createProjectors, projectAccountInOrder } from "../src/projectors.ts";
import { createValidatedNoteRank } from "../src/rank.ts";
import { SqliteStateStore, type CanonicalMutation, type ValidatedMergeCandidateInput } from "../src/state-store.ts";
import { accountPartition, decodeIsoDateTime, decodeNote, decodePartitionScope, type Media, type MediaSlotState, type NoteManifest, type TaskRecord } from "../src/types.ts";

const [root, accountId, phase] = process.argv.slice(2);
if (!root || !accountId || !["object", "canonical", "projection", "finalize", "commit"].includes(phase ?? "")) process.exit(2);

const scope = decodePartitionScope({ hostId: "xhs", accountId, target: "liked", boardId: null });
const account = accountPartition(scope);
const store = await SqliteStateStore.open(root);
const objects = store.objectStore();
const tx = store.beginImmediate({ command: "sync", scope });
const hold = () => { process.stdout.write(`READY:${phase}\n`); setInterval(() => {}, 10_000); };
const now = decodeIsoDateTime("2026-03-02T00:00:00.000Z");
const signal = new AbortController().signal;
const noteId = tx.enumerateAccountManifests(account)[Symbol.iterator]().next().value?.noteId;
if (!noteId) throw new Error("worker manifest missing");
const prior = tx.loadManifest(account, noteId);
const priorTask = tx.loadTask(scope, noteId);
const state = tx.loadState(scope);
if (!prior || !priorTask || !state) throw new Error("worker seed state missing");

const semanticBase = decodeNote({
  ...prior.canonicalNote,
  body: "body v2",
  updatedAt: now,
  capturedAt: now,
  media: [],
  contentHash: "0".repeat(64),
});
const sourceRank = createValidatedNoteRank(semanticBase, now);
const mediaBytes = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]),
];
const mediaSlots: MediaSlotState[] = [];
for (const [index, bytes] of mediaBytes.entries()) {
  const object = await objects.put(bytesIterable(bytes), "image/png", signal);
  const media: Media = Object.freeze({ mediaId: `media-v2-${index + 1}`, kind: "image", ordinal: index + 1, status: "stored", extension: "png", object });
  mediaSlots.push(Object.freeze({ slot: Object.freeze({ kind: "image", ordinal: index + 1 }), sourceRank, media, tombstone: false }));
}
const candidate: ValidatedMergeCandidateInput = Object.freeze({ note: semanticBase, sourceRank, mediaSlots: Object.freeze(mediaSlots), mediaSetComplete: true });
const merged = mergeCanonicalNote(prior, candidate);
const json = await objects.put(bytesIterable(renderNoteJsonBytes(merged.note, objects.registry)), null, signal);
const markdown = await objects.put(bytesIterable(renderNoteMarkdownBytes(merged.note, objects.registry)), null, signal);
const manifest: NoteManifest = Object.freeze({
  schemaVersion: 1,
  revision: prior.revision + 1,
  accountId: merged.note.accountId,
  hostId: merged.note.hostId,
  noteId: merged.note.noteId,
  canonicalNote: merged.note,
  semanticSourceRank: merged.sourceRank,
  membershipNameObservations: merged.membershipNameObservations,
  mediaSlots: merged.mediaSlots,
  artifacts: Object.freeze({ json, markdown }),
  indexEntrySha256: indexEntryDigest(merged.note),
  csvRowSha256: noteCsvRowDigest(merged.note),
});
const existingFailures = [...tx.enumerateUnresolvedFailures(account)].filter((failure) => failure.noteId === noteId);
const resolved = existingFailures.map((failure) => Object.freeze({ ...failure, resolvedAt: now, resolvedReason: "repaired" as const }));
const task: TaskRecord = Object.freeze({ ...priorTask, status: "done", attemptCount: priorTask.attemptCount + 1, failureIds: Object.freeze([]), updatedAt: now });
const nextState = Object.freeze({ ...state, revision: state.revision + 1, progress: state.progress, lastAttemptAt: now, lastSuccessfulAt: now });
const mutation: CanonicalMutation = Object.freeze({
  scope,
  expectedStateRevision: state.revision,
  expectedManifestRevisions: Object.freeze({ [noteId]: prior.revision }),
  nextState,
  candidates: Object.freeze([candidate]),
  manifests: Object.freeze([manifest]),
  tasks: Object.freeze([task]),
  failureOccurrences: Object.freeze([]),
  failureResolutions: Object.freeze(resolved),
  failures: Object.freeze(resolved),
});

if (phase === "object") hold();
else {
  store.putCanonicalMutation(tx, store.prepareCanonicalWritePlan(tx, mutation));
  if (phase === "canonical") hold();
  else {
    const business = store.prepareBusinessResult(tx, { runId: `crash.${phase}`, outcome: "committed", startedAt: now, finishedAt: now, safeErrorCategory: null, listed: 1, done: 1, partial: 0, failed: 0, skipped: 0, primaryNoteIds: [noteId] });
    const batch = await projectAccountInOrder(createProjectors(root, objects), tx, account, tx.accountGeneration(account) + 1, business);
    if (phase === "projection") hold();
    else {
      store.finalizeAccount(tx, batch);
      if (phase === "finalize") hold();
      else {
        store.commit(tx);
        hold();
      }
    }
  }
}
