import { canonicalJson } from "./canonical.ts";
import { publicNoteProjection } from "./merge.ts";
import { MemorySecretRegistry, assertPersistenceSafe } from "./secrets.ts";
import type { Note } from "./types.ts";

export interface Exporter {
  readonly id: "note-json" | "note-markdown";
  render(note: Note): AsyncIterable<Uint8Array>;
}

export function renderNoteJsonBytes(note: Note, registry = new MemorySecretRegistry()): Uint8Array {
  const projected = publicNoteProjection(note);
  assertPersistenceSafe(projected, registry);
  return Buffer.from(`${canonicalJson(projected)}\n`, "utf8");
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
  return Buffer.from(lines.join("\n"), "utf8");
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
