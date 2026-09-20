"""Local sample allowlist and private capture writer shared by both transports."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from common import CONFIG_DIR, SAFE_ID, ConfigError, load_yaml_file, utc_now

MAX_CAPTURE_BYTES = 8 * 1024 * 1024
MAX_CAPTURE_EVENTS = 10_000


class Recorder:
    def __init__(
        self,
        output: Path,
        *,
        max_bytes: int = MAX_CAPTURE_BYTES,
        max_events: int = MAX_CAPTURE_EVENTS,
    ):
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._fh = os.fdopen(descriptor, "w", encoding="utf-8")
        self._max_bytes = max_bytes
        self._max_events = max_events
        self._bytes = 0
        self._events = 0

    def emit(self, kind: str, payload: dict[str, Any]) -> None:
        record = {"ts": utc_now(), "kind": kind, "payload": payload}
        rendered = json.dumps(record, ensure_ascii=False) + "\n"
        encoded_size = len(rendered.encode("utf-8"))
        if self._events >= self._max_events or self._bytes + encoded_size > self._max_bytes:
            raise ConfigError("capture size/event safety limit reached")
        self._fh.write(rendered)
        self._fh.flush()
        self._bytes += encoded_size
        self._events += 1

    def close(self) -> None:
        self._fh.close()


def load_public_sample(
    path: Path, note_id: str, *, config_dir: Path = CONFIG_DIR
) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.parent != config_dir.resolve():
        raise ConfigError("notes file must be directly below the experiment config directory")
    raw = load_yaml_file(resolved)
    unknown_root = set(raw) - {"notes"}
    if unknown_root:
        raise ConfigError(f"unsupported notes-file fields: {sorted(unknown_root)}")
    notes = raw.get("notes")
    if not isinstance(notes, list):
        raise ConfigError("notes file must contain a notes list")
    selected = None
    seen_ids: set[str] = set()
    for note in notes:
        if not isinstance(note, dict):
            raise ConfigError("every note entry must be a mapping")
        unknown_fields = set(note) - {"note_id", "type", "search_queries", "enabled"}
        if unknown_fields:
            raise ConfigError(f"unsupported note fields: {sorted(unknown_fields)}")
        entry_id = note.get("note_id")
        if not isinstance(entry_id, str) or not SAFE_ID.fullmatch(entry_id):
            raise ConfigError("every note_id must use the supported safe-id format")
        if entry_id in seen_ids:
            raise ConfigError(f"duplicate note_id in notes file: {entry_id}")
        seen_ids.add(entry_id)
        if note.get("type") != "public" or not isinstance(note.get("enabled"), bool):
            raise ConfigError("every note must declare type=public and a boolean enabled flag")
        queries = note.get("search_queries")
        if (
            not isinstance(queries, list)
            or not queries
            or len(queries) > 3
            or not all(isinstance(value, str) and value.strip() for value in queries)
        ):
            raise ConfigError("every note needs between one and three search queries")
        if any(
            len(value.strip()) > 200
            or any(ord(char) < 0x20 and char not in "\t" for char in value)
            for value in queries
        ):
            raise ConfigError("search queries must be at most 200 characters without controls")
        if entry_id == note_id:
            selected = note
    if selected is not None:
        if selected.get("enabled") is not True:
            raise ConfigError("selected note must be enabled")
        return selected
    raise ConfigError("note_id is not present in the approved notes file")
