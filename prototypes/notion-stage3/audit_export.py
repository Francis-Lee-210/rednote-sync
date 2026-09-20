#!/usr/bin/env python3
"""Offline Notion-export audit and transparent retrieval baseline; experiment only."""
import argparse
import collections
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


URL = re.compile(r"https?://[^\s<>\[\]()\"']+")
LINK_START = re.compile(r"(!?)\[([^\]\n]*)\]\(")
ID = re.compile(r"^[0-9a-f]{24}$", re.I)
IMAGES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".svg"}
VIDEOS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
AUDIO = {".mp3", ".m4a", ".wav", ".ogg", ".aac"}


def scrub_url(url):
    """Do not propagate access query parameters from source URLs to derived files."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def scrub_text(text):
    return URL.sub(lambda m: scrub_url(m.group()), text)


def links(text):
    """Notion inline links, including balanced parentheses and angle destinations.

    Standalone exported media may have literal, unbalanced filename punctuation;
    on those lines the final parenthesis delimits the complete destination.
    """
    consumed = 0
    for match in LINK_START.finditer(text):
        if match.start() < consumed:
            continue
        start = match.end()
        line_start = text.rfind("\n", 0, match.start()) + 1
        line_end = text.find("\n", start)
        line_end = len(text) if line_end < 0 else line_end
        line = text[line_start:line_end].rstrip()
        if match.group(1) and not text[line_start:match.start()].strip() and line.endswith(")") and not LINK_START.search(text, start, line_end):
            end = line_start + len(line)
        else:
            depth, angle, escaped, end = 1, False, False, None
            for at in range(start, line_end):
                char = text[at]
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == "<" and at == start:
                    angle = True
                elif char == ">" and angle:
                    angle = False
                elif not angle and char == "(":
                    depth += 1
                elif not angle and char == ")":
                    depth -= 1
                    if depth == 0:
                        end = at + 1
                        break
            if end is None:
                continue
        consumed = end
        yield match.start(), end, match.group(1), match.group(2), text[start:end - 1]


def plain(text):
    chunks, at = [], 0
    for start, end, _, label, _ in links(text):
        chunks.extend((text[at:start], label))
        at = end
    chunks.append(text[at:])
    return re.sub(r"[\s]+", " ", "".join(chunks)).strip()


def split_page(text):
    lines = text.splitlines()
    title = lines[0].removeprefix("# ").strip() if lines else ""
    at = 1
    while at < len(lines) and not lines[at].strip():
        at += 1
    props = {}
    while at < len(lines):
        m = re.match(r"^([^:\n]{1,60}):\s*(.*)$", lines[at])
        if not m:
            break
        props[m.group(1).strip()] = m.group(2).strip()
        at += 1
    return title, props, "\n".join(lines[at:]).strip()


def kind_for(path):
    value = str(path)
    # A local filename can contain a literal '#'; it is not a URL fragment.
    ext = Path(urlsplit(value).path if value.startswith(("http://", "https://")) else value).suffix.lower()
    return "image" if ext in IMAGES else "video" if ext in VIDEOS else "audio" if ext in AUDIO else "other"


def media_refs(markdown, page, source):
    media = []
    for _, _, is_image, label, raw in links(markdown):
        label = scrub_text(label)
        raw = raw.strip().strip("<>")
        parsed = urlsplit(raw)
        kind = kind_for(raw)
        if kind == "other" and not is_image:
            continue
        if parsed.scheme in ("http", "https"):
            media.append({"kind": "image" if is_image else kind, "storage": "remote_reference", "url": scrub_url(raw), "label": label})
            continue
        if parsed.scheme:
            media.append({"kind": kind, "storage": "unsupported_reference", "label": label})
            continue
        literal = (page.parent / unquote(raw)).resolve()
        resolved = literal if literal.is_relative_to(source) and literal.is_file() else (page.parent / unquote(parsed.path)).resolve()
        if not resolved.is_relative_to(source):
            media.append({"kind": kind, "storage": "outside_export", "label": label})
            continue
        exists = resolved.is_file() and not resolved.is_symlink()
        item = {"kind": "image" if is_image else kind, "storage": "local" if exists else "missing_local", "path": str(resolved.relative_to(source)), "label": label}
        if exists:
            item["bytes"] = resolved.stat().st_size
        media.append(item)
    return media


def norm(text):
    return unicodedata.normalize("NFKC", text).casefold()


def retrieve(corpus, plan):
    """Frozen baseline: exact substring match for fixed terms, without tuning on results."""
    results = []
    for query in plan["queries"]:
        terms = [norm(t) for t in query["terms"]]
        modes = {}
        for mode in ("title", "title_body"):
            hits = []
            for note in corpus:
                fields = {"title": note["title"]}
                if mode == "title_body":
                    fields["body"] = note["body_text"]
                matched = {t: [field for field, text in fields.items() if t in norm(text)] for t in terms}
                matched = {t: fs for t, fs in matched.items() if fs}
                if not matched:
                    continue
                # Every matched term counts once; title presence is only a tie breaker.
                score = len(matched) * 10 + sum("title" in fs for fs in matched.values())
                body = note["body_text"]
                positions = [norm(body).find(t) for t in matched if t in norm(body)]
                start = max(0, min(positions) - 45) if positions else 0
                hits.append({"id": note["id"], "title": note["title"], "score": score, "matched_terms": matched, "all_terms_matched": len(matched) == len(terms), "snippet": body[start:start + 230]})
            hits.sort(key=lambda hit: (-hit["score"], hit["id"]))
            modes[mode] = {"hit_count": len(hits), "all_terms_count": sum(hit["all_terms_matched"] for hit in hits), "top5": hits[:5]}
        results.append({"query_id": query["id"], "task": query["task"], "terms": query["terms"], "split": query["split"], "modes": modes})
    return {"method": "exact-substring-v1", "ranking": "10 per distinct matched term + 1 per matched term in title; stable ID tie break", "scope": "Title and body; source tags, OCR and semantic embeddings are excluded.", "queries": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--queries", type=Path)
    args = parser.parse_args()
    source = args.export_dir.resolve(strict=True)
    out = args.out.resolve()
    if out == source or out.is_relative_to(source):
        parser.error("Output must be outside the original export directory")
    if any(path.is_symlink() for path in source.rglob("*")):
        parser.error("Export contains symbolic links")
    files = sorted(path for path in source.rglob("*") if path.is_file())
    inventory = [{"path": str(path.relative_to(source)), "bytes": path.stat().st_size, "sha256": sha256(path), "kind": kind_for(path)} for path in files]
    candidates = []
    other_markdown = []
    for page in (p for p in files if p.suffix.lower() == ".md"):
        raw = page.read_text(encoding="utf-8-sig")
        title, props, body = split_page(raw)
        note_id = props.get("resourceId", props.get("resourceid", "")).strip()
        if not ID.fullmatch(note_id):
            other_markdown.append(str(page.relative_to(source)))
            continue
        page_id = re.search(r"([0-9a-f]{32})(?:_\d+)?$", page.stem, re.I)
        media = media_refs(body, page, source)
        sanitized = scrub_text(body)
        text = plain(sanitized)
        origin_url = next((value for key, value in props.items() if key.casefold() == "url"), "")
        source_tags = props.get("标签", "")
        # Source relation names are preserved as source data, never called human truth.
        tags = [scrub_text(label) for _, _, _, label, _ in links(source_tags)]
        if not tags and source_tags:
            tags = [scrub_text(tag.strip()) for tag in source_tags.split(",") if tag.strip()]
        candidates.append({"id": note_id.lower(), "notion_page_id": page_id.group(1) if page_id else None, "source_markdown": str(page.relative_to(source)), "source_sha256": sha256(page), "title": scrub_text(title), "source_properties": {key: scrub_text(value) for key, value in props.items()}, "source_url": scrub_text(origin_url), "source_tags": tags, "source_tags_origin": "Notion exported relation/property; original author/user/plugin attribution unverified", "body_markdown": sanitized, "body_text": text, "body_chars": len(text), "content_sha256": hashlib.sha256((title + "\n" + sanitized).encode()).hexdigest(), "media": media, "media_processing": "No OCR, transcription, or visual interpretation performed by this audit"})
    groups = collections.defaultdict(list)
    for note in candidates:
        groups[note["id"]].append(note)
    corpus = []
    duplicates = []
    for note_id, group in sorted(groups.items()):
        chosen = max(group, key=lambda note: (note["body_chars"], len(note["media"]), note["source_markdown"]))
        chosen["source_variants"] = [note["source_markdown"] for note in group]
        chosen["source_relations"] = sorted({note["source_properties"].get("类型", "unknown") for note in group})
        chosen["search_variant_policy"] = "Only the selected variant is indexed; original variants remain available in the archive"
        corpus.append(chosen)
        if len(group) > 1:
            duplicates.append({"id": note_id, "variant_count": len(group), "content_variants": len({note["content_sha256"] for note in group}), "selected": chosen["source_markdown"], "selection": "Largest body, then media count; original variants preserved"})
    counts = collections.Counter((media["kind"], media["storage"]) for note in corpus for media in note["media"])
    summary = {"export_file_count": len(files), "export_bytes": sum(item["bytes"] for item in inventory), "file_extensions": dict(collections.Counter(p.suffix.lower() for p in files)), "post_markdown_count": len(candidates), "unique_posts": len(corpus), "duplicate_post_ids": len(duplicates), "nonpost_markdown_count": len(other_markdown), "posts_with_body": sum(n["body_chars"] > 0 for n in corpus), "posts_with_at_least_300_body_chars": sum(n["body_chars"] >= 300 for n in corpus), "posts_with_source_tags": sum(bool(n["source_tags"]) for n in corpus), "source_types": dict(collections.Counter(relation for n in corpus for relation in n["source_relations"])), "posts_with_multiple_source_relations": sum(len(n["source_relations"]) > 1 for n in corpus), "selected_variant_source_types": dict(collections.Counter(n["source_properties"].get("类型", "unknown") for n in corpus)), "source_statuses": dict(collections.Counter(n["source_properties"].get("状态", "unknown") for n in corpus)), "media_references": {f"{kind}:{storage}": count for (kind, storage), count in sorted(counts.items())}, "posts_with_local_images": sum(any(m["kind"] == "image" and m["storage"] == "local" for m in n["media"]) for n in corpus), "posts_with_local_video": sum(any(m["kind"] == "video" and m["storage"] == "local" for m in n["media"]) for n in corpus), "posts_with_remote_media": sum(any(m["storage"] == "remote_reference" for m in n["media"]) for n in corpus), "posts_with_missing_local_media": sum(any(m["storage"] == "missing_local" for m in n["media"]) for n in corpus), "scope": "Notion archive export only; no claim of complete Xiaohongshu collection or media coverage against original platform", "source_integrity": "Per-file SHA256 inventory; source files are never rewritten", "derived_url_policy": "All URL query strings/fragments removed from derived content; original archive remains private"}
    write_json(out / "inventory.json", inventory)
    write_json(out / "audit.json", summary)
    write_json(out / "duplicates.json", duplicates)
    write_json(out / "other-markdown.json", other_markdown)
    corpus_file = out / "corpus.jsonl"
    corpus_file.write_text("".join(json.dumps(note, ensure_ascii=False) + "\n" for note in corpus), encoding="utf-8")
    corpus_file.chmod(0o600)
    if args.queries:
        plan = json.loads(args.queries.read_text(encoding="utf-8"))
        write_json(out.parent / "experiments" / "search-results.json", retrieve(corpus, plan))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
