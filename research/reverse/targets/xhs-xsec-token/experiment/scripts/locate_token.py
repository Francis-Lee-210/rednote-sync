#!/usr/bin/env python3
"""Locate structured xsec access material in a private experiment capture."""
from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import parse_qsl, quote, urlsplit

from common import DATA_DIR, ConfigError


TOKEN_KEYS = {"xsec_token", "xsecToken"}
SOURCE_KEYS = {"xsec_source", "xsecSource"}
URL_VALUE_KEYS = {"request_url", "final_url", "url", "href", "location"}


@dataclass(frozen=True)
class Finding:
    line_no: int
    kind: str
    path: str
    value: str


def open_private_capture(value: str | os.PathLike[str]) -> tuple[Path, TextIO]:
    """Open a regular, owner-only, non-symlink file below data/captures."""
    capture_root = (DATA_DIR / "captures").resolve()
    candidate = Path(value).expanduser()
    if candidate.is_symlink():
        raise ConfigError("capture must not be a symbolic link")
    resolved = candidate.resolve()
    if capture_root not in resolved.parents:
        raise ConfigError("capture must be below the experiment data/captures directory")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(candidate, flags)
    except FileNotFoundError as exc:
        raise ConfigError("capture file does not exist") from exc
    except OSError as exc:
        raise ConfigError("capture file could not be opened safely") from exc

    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigError("capture must be a regular file")
        if metadata.st_uid != os.getuid():
            raise ConfigError("capture must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ConfigError("capture must be owner-only (chmod 600)")
        return resolved, os.fdopen(descriptor, "r", encoding="utf-8")
    except Exception:
        os.close(descriptor)
        raise


def _string_value(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def _query_findings(
    value: str,
    *,
    line_no: int,
    kind: str,
    path: str,
) -> tuple[list[Finding], list[Finding]]:
    tokens: list[Finding] = []
    sources: list[Finding] = []
    try:
        query = parse_qsl(urlsplit(value).query, keep_blank_values=True)
    except ValueError:
        return tokens, sources
    for key, item in query:
        finding = Finding(line_no, kind, f"{path}.query.{key}", item)
        if key in TOKEN_KEYS and item:
            tokens.append(finding)
        elif key in SOURCE_KEYS and item:
            sources.append(finding)
    return tokens, sources


def structured_findings(
    payload: dict[str, Any],
    *,
    line_no: int,
    kind: str,
) -> tuple[list[Finding], list[Finding]]:
    """Find exact fields and query parameters without scanning serialized text."""
    tokens: list[Finding] = []
    sources: list[Finding] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                child_path = f"{path}.{key}"
                text = _string_value(value)
                if key in TOKEN_KEYS and text is not None:
                    tokens.append(Finding(line_no, kind, child_path, text))
                elif key in SOURCE_KEYS and text is not None:
                    sources.append(Finding(line_no, kind, child_path, text))
                elif key.lower() in URL_VALUE_KEYS and text is not None:
                    query_tokens, query_sources = _query_findings(
                        text,
                        line_no=line_no,
                        kind=kind,
                        path=child_path,
                    )
                    tokens.extend(query_tokens)
                    sources.extend(query_sources)
                if isinstance(value, (dict, list)):
                    walk(value, child_path)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(payload, "payload")
    return tokens, sources


def token_prefix(value: str, visible: int = 10) -> str:
    """Expose a prefix only; never reveal a complete short token or any suffix."""
    if len(value) <= visible:
        return "<redacted>"
    return quote(value[:visible], safe="-._~") + "..."


def safe_label(value: str, limit: int = 80) -> str:
    """Make untrusted capture metadata inert and bounded for terminal output."""
    prefix = value[:limit]
    rendered = quote(prefix, safe="-._~[]")
    return rendered + ("..." if len(value) > limit else "")


def load_findings(fh: TextIO) -> tuple[list[Finding], list[Finding]]:
    tokens: list[Finding] = []
    sources: list[Finding] = []
    saw_record = False
    for line_no, line in enumerate(fh, 1):
        if not line.strip():
            raise ConfigError(f"capture JSONL contains a blank record at line {line_no}")
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"capture JSONL is malformed at line {line_no}") from exc
        if not isinstance(record, dict):
            raise ConfigError(f"capture record must be an object at line {line_no}")
        kind = record.get("kind")
        if not isinstance(kind, str) or not kind:
            raise ConfigError(f"capture record has an invalid kind at line {line_no}")
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise ConfigError(f"capture record has an invalid payload at line {line_no}")
        saw_record = True
        record_tokens, record_sources = structured_findings(
            payload,
            line_no=line_no,
            kind=kind,
        )
        tokens.extend(record_tokens)
        sources.extend(record_sources)
    if not saw_record:
        raise ConfigError("capture JSONL is empty")
    return tokens, sources


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True, help="private capture JSONL file")
    args = parser.parse_args()

    try:
        capture, fh = open_private_capture(args.capture)
        with fh:
            tokens, sources = load_findings(fh)
    except (ConfigError, OSError, UnicodeError) as exc:
        print(f"capture rejected: {exc}", file=sys.stderr)
        return 2

    if not tokens or not sources:
        missing = "token and source" if not tokens and not sources else (
            "token" if not tokens else "source"
        )
        print(f"xsec access material incomplete: missing {missing}")
        return 1

    first_token = tokens[0]
    first_source = sources[0]
    print(
        f"first token: line={first_token.line_no} kind={safe_label(first_token.kind)} "
        f"path={safe_label(first_token.path)}"
    )
    print(f"token_prefix={token_prefix(first_token.value)}")
    print(
        f"first source: line={first_source.line_no} kind={safe_label(first_source.kind)} "
        f"path={safe_label(first_source.path)}"
    )
    print(f"xsec_source={safe_label(first_source.value)}")
    print(f"total token findings: {len(tokens)}")
    print(f"total source findings: {len(sources)}")
    print(f"capture: {capture}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
