import { SafeError } from "./errors.ts";
import type { BoardId, HostId, NoteId } from "./types.ts";

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", `${label} must be text`);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(normalized) || normalized === "." || normalized === "..") throw new SafeError("INVALID_INPUT", `invalid ${label}`);
  return normalized;
}

function decodeAdapterHost(value: unknown): HostId {
  if (value !== "xhs" && value !== "rednote") throw new SafeError("INVALID_INPUT", "invalid host");
  return value;
}

function decodeAdapterNote(value: unknown): NoteId { return safeId(value, "note id") as NoteId; }
function decodeAdapterBoard(value: unknown): BoardId { return safeId(value, "board id") as BoardId; }

export interface HostAdapter {
  readonly hostId: HostId;
  readonly webOrigin: string;
  /** Compatibility alias for the reviewed Stage-3 implementation. */
  readonly origin: string;
  parseNoteId(value: unknown): NoteId;
  parseBoardId(value: unknown): BoardId;
  publicNoteUrl(noteId: NoteId): string;
  sanitizeImportedUrl(value: string, noteId: NoteId): string;
  normalizeAuthorPublicUrl(value: string | null): string | null;
  sanitizeImportedNoteUrl(value: unknown, noteId: NoteId): string;
  sanitizeImportedAuthorUrl(value: unknown): string | null;
}

function parseExactHttps(value: unknown, origin: string): URL {
  if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SafeError("INVALID_INPUT", "invalid public URL"); }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new SafeError("INVALID_INPUT", "public URL origin or components are invalid");
  }
  return parsed;
}

function createHostAdapter(hostIdInput: HostId, webOrigin: string): HostAdapter {
  const hostId = decodeAdapterHost(hostIdInput);
  const publicNoteUrl = (noteIdInput: NoteId): string => {
    const noteId = decodeAdapterNote(noteIdInput);
    return `${webOrigin}/explore/${encodeURIComponent(noteId)}`;
  };
  const sanitizeImportedUrl = (value: string, noteIdInput: NoteId): string => {
    const canonical = publicNoteUrl(noteIdInput);
    const parsed = parseExactHttps(value, webOrigin);
    if (parsed.pathname !== new URL(canonical).pathname) throw new SafeError("INVALID_INPUT", "public note URL does not match note id");
    return canonical;
  };
  const normalizeAuthorPublicUrl = (value: string | null): string | null => {
    if (value === null) return null;
    const parsed = parseExactHttps(value, webOrigin);
    return `${webOrigin}${parsed.pathname}`;
  };
  return Object.freeze({
    hostId,
    webOrigin,
    origin: webOrigin,
    parseNoteId: decodeAdapterNote,
    parseBoardId: decodeAdapterBoard,
    publicNoteUrl,
    sanitizeImportedUrl,
    normalizeAuthorPublicUrl,
    sanitizeImportedNoteUrl(value: unknown, noteIdInput: NoteId): string {
      if (typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
      return sanitizeImportedUrl(value, noteIdInput);
    },
    sanitizeImportedAuthorUrl(value: unknown): string | null {
      if (value !== null && typeof value !== "string") throw new SafeError("INVALID_INPUT", "public URL must be text");
      return normalizeAuthorPublicUrl(value);
    },
  });
}

const HOST_ADAPTERS: Readonly<Record<HostId, HostAdapter>> = Object.freeze({
  xhs: createHostAdapter("xhs", "https://www.xiaohongshu.com"),
  rednote: createHostAdapter("rednote", "https://www.rednote.com"),
});

/** Origins are based only on reviewed static samples; online validity remains a Stage-4 verification item. */
export function getHostAdapter(hostIdInput: HostId): HostAdapter {
  return HOST_ADAPTERS[decodeAdapterHost(hostIdInput)];
}
