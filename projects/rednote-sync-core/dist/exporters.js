import { canonicalJson } from "./canonical.js";
import { publicNoteProjection } from "./merge.js";
import { MemorySecretRegistry, assertPersistenceSafe } from "./secrets.js";
                                       

                           
                                             
                                                
 

export function renderNoteJsonBytes(note      , registry = new MemorySecretRegistry())             {
  const projected = publicNoteProjection(note);
  assertPersistenceSafe(projected, registry);
  return Buffer.from(`${canonicalJson(projected)}\n`, "utf8");
}

export function renderNoteMarkdownBytes(note      , registry = new MemorySecretRegistry())             {
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

export class JsonExporter                     {
           id = "note-json"         ;
           registry                      ;
  constructor(registry = new MemorySecretRegistry()) { this.registry = registry; }
  async *render(note      )                            {
    yield renderNoteJsonBytes(note, this.registry);
  }
}

function yamlString(value               )         { return JSON.stringify(value ?? ""); }

export class MarkdownExporter                     {
           id = "note-markdown"         ;
           registry                      ;
  constructor(registry = new MemorySecretRegistry()) { this.registry = registry; }
  async *render(note      )                            {
    yield renderNoteMarkdownBytes(note, this.registry);
  }
}
