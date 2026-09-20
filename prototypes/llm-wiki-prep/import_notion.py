"""Map the existing Notion audit snapshot into a private Wiki preparation bundle.

Only corpus.jsonl and the optional video-index.json are read for content. Other
paths are checked with lstat, never decoded, hashed, downloaded, or executed.
build_bundle is read-only; the CLI writes only into a new output directory.
"""

import argparse
import collections
import hashlib
import json
import math
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ADAPTER = "notion-normalized-to-wiki/0"
SCHEMA = "llm-wiki-prep/0"
POST_ID = re.compile(r"[0-9a-fA-F]{24}\Z")
SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")
URL = re.compile(r"https?://[^\s<>\[\]()\"']+", re.I)
STORAGE = {"local", "missing_local", "remote_reference", "outside_export",
           "unsupported_reference"}
RECORD_STATES = {
    "plan": {"available", "not_attempted", "http_error", "failed"},
    "download": {"downloaded", "not_attempted", "http_error", "failed", "space_stop"},
    "verify": {"verified", "missing", "decode_or_hash_failed", "verification_failed"},
}


class ImportFailure(ValueError):
    """A safe error code and structural position, without private input text."""

    def __init__(self, code, where):
        self.code, self.where = code, where
        super().__init__(f"{code} at {where}")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def require(condition, where, code="E_INPUT_SHAPE"):
    if not condition:
        raise ImportFailure(code, where)


def text_value(value, where, *, empty=True):
    require(isinstance(value, str) and (empty or bool(value.strip())), where)
    return value


def post_id(value, where):
    require(isinstance(value, str) and POST_ID.fullmatch(value) is not None, where)
    return value.lower()


def hash_value(value, where):
    require(isinstance(value, str) and SHA256.fullmatch(value) is not None, where)
    return value.lower()


def clean_url(value, where):
    """Remove access material; do not open the URL or preserve userinfo."""
    text_value(value, where, empty=False)
    try:
        parts = urlsplit(value)
        require(parts.scheme.lower() in ("http", "https") and bool(parts.hostname),
                where, "E_URL")
        host = parts.hostname.lower()
        if ":" in host:
            host = "[" + host + "]"
        port = parts.port
        if port is not None and port != {"http": 80, "https": 443}[parts.scheme.lower()]:
            host += ":" + str(port)
        return urlunsplit((parts.scheme.lower(), host, parts.path, "", ""))
    except ValueError as error:
        if isinstance(error, ImportFailure):
            raise
        raise ImportFailure("E_URL", where) from None


def url_identity(value, where):
    parts = urlsplit(clean_url(value, where))
    return parts.netloc, parts.path


def clean_text(value, where, media_urls=frozenset()):
    value = text_value(value, where)

    def replace(match):
        safe = clean_url(match.group(), where)
        return "" if url_identity(safe, where) in media_urls else safe

    return URL.sub(replace, value)


def string_list(value, where):
    require(isinstance(value, list), where)
    return [clean_text(item, f"{where}[{number}]")
            for number, item in enumerate(value)]


def absolute_path(value, where):
    path = Path(value).expanduser()
    require(".." not in path.parts, where, "E_PATH")
    return path if path.is_absolute() else Path.cwd() / path


def path_status(path, where):
    """Check every existing component before using a supplied filesystem path."""
    current = Path(path.anchor)
    for number, part in enumerate(path.parts[1:]):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        require(not stat.S_ISLNK(info.st_mode), where, "E_SYMLINK")
        if number < len(path.parts) - 2:
            require(stat.S_ISDIR(info.st_mode), where, "E_PATH")
    return current.lstat()


def archive_root(archive):
    root = absolute_path(archive, "archive")
    info = path_status(root, "archive")
    require(info is not None and stat.S_ISDIR(info.st_mode), "archive", "E_ARCHIVE")
    return root


def relative_path(value, where):
    text_value(value, where, empty=False)
    path = Path(value)
    require(not path.is_absolute() and bool(path.parts) and ".." not in path.parts
            and "\x00" not in value and "\\" not in value, where, "E_PATH")
    require(not path.name.endswith((".part", ".tmp")), where, "E_TEMPORARY_PATH")
    return path


def observe_file(root, value, where):
    relative = relative_path(value, where)
    info = path_status(root / relative, where)
    if info is not None:
        require(stat.S_ISREG(info.st_mode), where, "E_PATH")
    return {"path": relative.as_posix(), "exists": info is not None,
            "bytes": info.st_size if info is not None else None}


def observe_original_media(root, value, where):
    """Keep usable source text when an individual media location is rejected."""
    try:
        relative = relative_path(value, where)
        return observe_file(root, (Path("source/export") / relative).as_posix(), where)
    except ImportFailure as error:
        if error.code not in ("E_PATH", "E_SYMLINK", "E_TEMPORARY_PATH"):
            raise
        return {"path": None, "exists": False, "bytes": None,
                "path_rejected": True, "path_error": error.code}


def read_snapshot(root, relative, *, optional=False):
    where = "video_index" if optional else "corpus"
    observation = observe_file(root, relative, where)
    if not observation["exists"]:
        if optional:
            return None, {"state": "absent", "relative_path": relative,
                          "observed_at_utc": utc_now()}
        raise ImportFailure("E_INPUT_MISSING", where)
    descriptor = os.open(root / relative, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), where, "E_PATH")
        raw = stream.read()
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeError:
        raise ImportFailure("E_ENCODING", where) from None
    return content, {"state": "present", "relative_path": relative,
                     "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                     "observed_at_utc": utc_now()}


def parse_json(value, where):
    def pairs(items):
        result = {}
        for key, item in items:
            require(key not in result, where, "E_JSON_DUPLICATE_KEY")
            result[key] = item
        return result

    def reject_constant(_):
        raise ImportFailure("E_JSON", where)

    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=reject_constant)
    except (json.JSONDecodeError, RecursionError):
        raise ImportFailure("E_JSON", where) from None


def selected_record(item, name, where):
    """Copy the documented ledger fields, without arbitrary probe metadata."""
    if name not in item:
        return None
    record = item[name]
    require(isinstance(record, dict), where)
    status_value = record.get("status")
    require(isinstance(status_value, str) and status_value in RECORD_STATES[name], where)
    result = {"status": status_value}
    for key in ("bytes", "http_status", "attempts", "decode_exit_code"):
        if key in record:
            value = record[key]
            require(type(value) is int and (key == "decode_exit_code" or value >= 0), where)
            result[key] = value
    for key in ("content_type", "error_type"):
        if key in record and record[key] is not None:
            result[key] = clean_text(record[key], where)
    if "sha256" in record:
        result["sha256"] = hash_value(record["sha256"], where)
    if "reused" in record:
        require(type(record["reused"]) is bool, where)
        result["reused"] = record["reused"]
    if status_value in ("downloaded", "verified"):
        # Historical/minimal records may omit hashes. Preserve that absence;
        # this adapter only compares recorded lengths, never verifies media.
        require("bytes" in result, where)
    return result


def ledger_items(root, raw, snapshot):
    if raw is None:
        return [], {}
    data = parse_json(raw, "video_index")
    require(isinstance(data, dict) and isinstance(data.get("items"), list), "video_index")
    if "updated_at_unix" in data:
        value = data["updated_at_unix"]
        require(type(value) in (int, float) and math.isfinite(value), "video_index.updated_at_unix")
        snapshot["declared_updated_at_unix"] = value
    items, by_note, identities, keys = [], collections.defaultdict(list), set(), set()
    for number, raw_item in enumerate(data["items"]):
        where = f"video_index.items[{number}]"
        require(isinstance(raw_item, dict), where)
        key = hash_value(raw_item.get("key"), where + ".key")
        safe_url = clean_url(raw_item.get("url"), where + ".url")
        identity = url_identity(safe_url, where + ".url")
        require(key not in keys and identity not in identities, where, "E_DUPLICATE_VIDEO")
        keys.add(key)
        identities.add(identity)
        ids = raw_item.get("note_ids")
        require(isinstance(ids, list) and bool(ids), where + ".note_ids")
        ids = sorted({post_id(value, where + ".note_ids") for value in ids})
        final_path = relative_path(raw_item.get("file"), where + ".file")
        require(final_path.parts[:2] == ("supplemental", "videos")
                and final_path.suffix.lower() == ".mp4", where + ".file", "E_PATH")
        final_file = observe_file(root, final_path.as_posix(), where + ".file")
        source_pages = raw_item.get("source_pages", [])
        require(isinstance(source_pages, list), where + ".source_pages")
        checked_pages = [observe_file(root, path, where + ".source_pages")["path"]
                         for path in source_pages]
        records = {name: selected_record(raw_item, name, where + "." + name)
                   for name in ("plan", "download", "verify")}
        for name in ("download", "verify"):
            expected = (records[name] or {}).get("bytes")
            final_file[f"matches_{name}_bytes"] = (
                final_file["bytes"] == expected if final_file["exists"]
                and expected is not None else None)
        local_status = "pending_or_missing"
        if final_file["exists"]:
            local_status = "present_unverified"
            downloaded = (records["download"] or {}).get("status") == "downloaded"
            if downloaded and final_file["matches_download_bytes"]:
                if final_file["bytes"] > 0:
                    local_status = "download_record_size_matched"
            if (downloaded and final_file["matches_download_bytes"] is False
                    or (records["verify"] or {}).get("status") == "verified"
                    and final_file["matches_verify_bytes"] is False):
                local_status = "record_size_mismatch"
        item = {"key": key, "url": safe_url, "file": final_path.as_posix(),
                "source_pages": checked_pages, "plan_record": records["plan"],
                "download_record": records["download"], "verify_record": records["verify"],
                "final_file": final_file, "local_status": local_status}
        items.append(item)
        for note in ids:
            by_note[note].append(item)
    snapshot["items"] = len(items)
    return items, by_note


def source_context(note, where):
    properties = note.get("source_properties", {})
    require(isinstance(properties, dict), where + ".source_properties")

    def prop(key):
        value = properties.get(key)
        return clean_text(value, where + ".source_properties") if value is not None else None

    return {
        "author": prop("作者"),
        "author_origin": "Notion exported property; author identity not independently verified",
        "source_tags": string_list(note.get("source_tags", []), where + ".source_tags"),
        "source_tags_origin": clean_text(note.get("source_tags_origin",
            "Notion exported property; original author/user/plugin attribution unverified"),
            where + ".source_tags_origin"),
        "source_relations": string_list(note.get("source_relations", []), where + ".source_relations"),
        "source_classification": prop("分类"),
        "raw_dates": {"post_created": prop("帖子创建时间"), "post_modified": prop("帖子修改时间"),
                      "notion_created": prop("创建时间"), "notion_modified": prop("修改时间")},
    }


def convert_source(root, note, by_note, number, counts):
    where = f"corpus.records[{number}]"
    require(isinstance(note, dict), where)
    identity = post_id(note.get("id"), where + ".id")
    title = clean_text(note.get("title"), where + ".title").strip()
    original = relative_path(note.get("source_markdown"), where + ".source_markdown")
    selected_file = observe_file(root, (Path("source/export") / original).as_posix(), where)
    variants = note.get("source_variants", [original.as_posix()])
    require(isinstance(variants, list), where + ".source_variants")
    variants = [observe_file(root, (Path("source/export") / relative_path(path, where)).as_posix(), where)
                for path in variants]
    media = note.get("media")
    require(isinstance(media, list), where + ".media")
    blocks, media_metadata, media_urls, matched_keys = [], [], set(), set()
    ordinals = collections.Counter()
    for media_number, item in enumerate(media):
        position = f"{where}.media[{media_number}]"
        require(isinstance(item, dict), position)
        kind, storage = item.get("kind"), item.get("storage")
        require(isinstance(kind, str) and kind in ("image", "video", "audio", "other"), position)
        require(isinstance(storage, str) and storage in STORAGE, position)
        ordinals[kind] += 1
        metadata = {"kind": kind, "selected_ordinal": ordinals[kind],
                    "selected_media_index": media_number + 1, "original_storage": storage,
                    "label": clean_text(item.get("label", ""), position + ".label")}
        exists = False
        if storage in ("local", "missing_local"):
            metadata["original_local"] = observe_original_media(root, item.get("path"), position + ".path")
            exists = metadata["original_local"]["exists"]
            counts["media_paths_rejected"] += metadata["original_local"].get("path_rejected", False)
            if "bytes" in item:
                require(type(item["bytes"]) is int and item["bytes"] >= 0, position + ".bytes")
                metadata["recorded_export_bytes"] = item["bytes"]
                metadata["matches_export_bytes"] = (metadata["original_local"]["bytes"] == item["bytes"]
                                                      if exists else None)
        if storage == "remote_reference":
            metadata["url"] = clean_url(item.get("url"), position + ".url")
            media_identity = url_identity(metadata["url"], position + ".url")
            media_urls.add(media_identity)
            if kind == "video":
                candidates = [candidate for candidate in by_note.get(identity, [])
                              if url_identity(candidate["url"], position) == media_identity]
                if candidates:
                    supplemental = candidates[0]
                    metadata["supplemental"] = supplemental
                    matched_keys.add(supplemental["key"])
                    exists = supplemental["final_file"]["exists"]
        if kind in ("image", "video"):
            block_id = f"{kind}-{ordinals[kind]}"
            state = "not_processed" if exists else "missing"
            blocks.append({"block_id": block_id,
                           "kind": "image_ocr" if kind == "image" else "video_transcript",
                           "state": state, "text": "", "locator": {kind: ordinals[kind]}})
            metadata["block_id"] = block_id
            counts[f"{kind}_blocks"] += 1
            counts[f"media_{state}"] += 1
        else:
            counts["other_selected_media"] += 1
        media_metadata.append(metadata)
    original_body = text_value(note.get("body_text"), where + ".body_text")
    counts["original_nonempty_body"] += bool(original_body.strip())
    body = clean_text(original_body, where + ".body_text", media_urls)
    body = re.sub(r"\s+", " ", body).strip()
    blocks.insert(0, {"block_id": "body-1", "kind": "body",
                      "state": "available" if body else "missing", "text": body,
                      "locator": {"paragraph": 1, "basis": "normalized_body_text_single_block"}})
    counts["body_available" if body else "body_missing"] += 1
    counts["sources"] += 1
    counts["selected_source_file_missing"] += not selected_file["exists"]
    counts["title_missing"] += not bool(title)
    extra_count = sum(item["key"] not in matched_keys for item in by_note.get(identity, []))
    counts["matched_supplemental_video_associations"] += len(matched_keys)
    counts["unselected_supplemental_video_associations"] += extra_count
    context = source_context(note, where)
    metadata = {
        "adapter": ADAPTER, "archive_root": str(root),
        "normalized_input": "normalized/corpus.jsonl", "selected_source_file": selected_file,
        "source_variants": variants, "media": media_metadata,
        "unselected_supplemental_video_candidates": extra_count,
        "title_missing": not bool(title),
        "search_variant_policy": clean_text(note.get("search_variant_policy",
            "Only the corpus-selected variant is imported; original variants are not merged or understood"), where),
        "source_url": clean_text(note.get("source_url", ""), where + ".source_url"),
    }
    for name in ("source_sha256", "content_sha256"):
        if name in note:
            metadata[name] = hash_value(note[name], where + "." + name)
    page_id = note.get("notion_page_id")
    if page_id is not None:
        require(isinstance(page_id, str) and re.fullmatch(r"[0-9a-fA-F]{32}", page_id), where)
        metadata["notion_page_id"] = page_id.lower()
    exported_status = note.get("source_properties", {}).get("状态")
    if exported_status is not None:
        metadata["notion_record_status"] = clean_text(exported_status, where)
    return {"source_id": "notion-resource:" + identity,
            "title": title or "未提供标题（导入占位）", "published_at": None,
            "availability": "active", "source_context": context,
            "blocks": blocks, "export_metadata": metadata}


def build_bundle(archive: Path):
    """Read one snapshot of each known JSON input and return (bundle, report).

    No source file is written. Only filesystem metadata is consulted for source
    paths and finalized media; temporary download files are never inspected.
    """
    observed_at = utc_now()
    root = archive_root(archive)
    corpus, corpus_snapshot = read_snapshot(root, "normalized/corpus.jsonl")
    video_index, video_snapshot = read_snapshot(root, "supplemental/video-index.json", optional=True)
    videos, by_note = ledger_items(root, video_index, video_snapshot)
    counts = collections.Counter({key: 0 for key in (
        "sources", "original_nonempty_body", "body_available", "body_missing", "image_blocks", "video_blocks",
        "media_missing", "media_not_processed", "other_selected_media", "title_missing",
        "selected_source_file_missing", "matched_supplemental_video_associations",
        "unselected_supplemental_video_associations", "media_paths_rejected")})
    sources, seen = [], set()
    for number, line in enumerate(corpus.splitlines(), 1):
        if not line.strip():
            continue
        note = parse_json(line, f"corpus.line[{number}]")
        source = convert_source(root, note, by_note, number, counts)
        require(source["source_id"] not in seen, f"corpus.line[{number}]", "E_DUPLICATE_SOURCE")
        seen.add(source["source_id"])
        sources.append(source)
    sources.sort(key=lambda source: source["source_id"])
    corpus_snapshot["records"] = len(sources)
    bundle = {"schema_version": SCHEMA, "dataset_kind": "private",
              "description": "Imported source records only; no Wiki pages, OCR, transcription, or model output",
              "sources": sources, "pages": [], "personal": []}
    report = {
        "adapter": ADAPTER, "observed_at_utc": observed_at, "completed_at_utc": utc_now(),
        "snapshots": {"corpus": corpus_snapshot, "video_index": video_snapshot},
        "counts": dict(counts), "wiki_pages": 0, "personal_notes": 0,
        "video_ledger_status_counts": {
            name: dict(collections.Counter((item[name + "_record"] or {}).get("status", "not_recorded")
                                          for item in videos))
            for name in ("plan", "download", "verify")},
        "video_final_file_observation_counts": dict(collections.Counter(item["local_status"] for item in videos)),
        "limitations": [
            "One snapshot of each JSON input; the two files and later lstat observations are not one atomic archive transaction.",
            "Only the corpus-selected body variant is imported; paths to other variants are retained but their content is not read.",
            "body-1 is one normalized text block, not paragraph 1 in the original Markdown; standalone selected-media URLs are separated from body text.",
            "Image/video ordinals follow each kind in the selected export references, not verified original-platform order.",
            "Extra supplemental videos are counted without assigning them invented source ordinals or reading their content.",
            "Published dates remain null; original post and Notion date strings are preserved separately without parsing.",
            "Availability means included in this local source snapshot, not that the platform post is currently accessible.",
            "Media existence and byte counts are observed only; download and verification fields are historical ledger claims, not repeated verification.",
            "No OCR, transcription, visual understanding, media hashing, decoding, model calls, Wiki pages, or Core import occurs.",
            "No running or overall-completion state can be inferred from missing ledger entries or final-file existence.",
        ],
    }
    return bundle, report


def new_output(root, value):
    output = absolute_path(value, "out")
    require(output != root and not output.is_relative_to(root), "out", "E_OUTPUT_IN_ARCHIVE")
    require(path_status(output, "out") is None, "out", "E_OUTPUT_EXISTS")
    return output


def write_new_json(path, value):
    encoded = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(encoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    stage = "input"
    try:
        root = archive_root(args.archive)
        output = new_output(root, args.out)
        bundle, report = build_bundle(root)
        stage = "output"
        previous_umask = os.umask(0o077)
        try:
            output.mkdir(parents=True, mode=0o700, exist_ok=False)
            output.chmod(0o700)
            write_new_json(output / "bundle.json", bundle)
            write_new_json(output / "import-report.json", report)
        finally:
            os.umask(previous_umask)
        result = {"ok": True, "counts": report["counts"], "wiki_pages": 0,
                  "video_index_snapshot": report["snapshots"]["video_index"]["state"]}
    except ImportFailure as error:
        result = {"ok": False, "error": {"code": error.code, "at": error.where}}
    except (OSError, UnicodeError, ValueError, RecursionError):
        result = {"ok": False, "error": {"code": "E_INPUT_IO" if stage == "input" else "E_OUTPUT_IO",
                                          "at": stage}}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
