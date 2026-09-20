import { canonicalJson } from "./canonical.ts";
import { publicNoteProjection } from "./merge.ts";
import { MemorySecretRegistry, assertKnownSecretBytes, assertPersistenceSafe } from "./secrets.ts";
import type { Note } from "./types.ts";

export interface Exporter {
  readonly id: "note-json" | "note-markdown";
  render(note: Note): AsyncIterable<Uint8Array>;
}

export function renderNoteJsonBytes(note: Note, registry = new MemorySecretRegistry()): Uint8Array {
  const projected = publicNoteProjection(note);
  assertPersistenceSafe(projected, registry);
  const bytes = Buffer.from(`${canonicalJson(projected)}\n`, "utf8");
  assertKnownSecretBytes(bytes, registry);
  return bytes;
}

export function renderNoteMarkdownBytes(note: Note, registry = new MemorySecretRegistry()): Uint8Array {
  const projected = publicNoteProjection(note);
  assertPersistenceSafe(projected, registry);
  const lines = [
    "---",
    `note_id: ${yamlString(note.noteId)}`,
    `source: ${yamlString(note.publicUrl)}`,
    `title: ${yamlString(note.title)}`,
    `content_hash: ${yamlString(note.contentHash)}`,
    `tags: [${note.tags.map(yamlString).join(", ")}]`,
    "---",
    "",
    note.body,
    "",
  ];
  const bytes = Buffer.from(lines.join("\n"), "utf8");
  assertKnownSecretBytes(bytes, registry);
  return bytes;
}

export class JsonExporter implements Exporter {
  readonly id = "note-json" as const;
  readonly registry: MemorySecretRegistry;
  constructor(registry = new MemorySecretRegistry()) { this.registry = registry; }
  async *render(note: Note): AsyncIterable<Uint8Array> {
    yield renderNoteJsonBytes(note, this.registry);
  }
}

function yamlString(value: string | null): string { return JSON.stringify(value ?? ""); }

export class MarkdownExporter implements Exporter {
  readonly id = "note-markdown" as const;
  readonly registry: MemorySecretRegistry;
  constructor(registry = new MemorySecretRegistry()) { this.registry = registry; }
  async *render(note: Note): AsyncIterable<Uint8Array> {
    yield renderNoteMarkdownBytes(note, this.registry);
  }
}
