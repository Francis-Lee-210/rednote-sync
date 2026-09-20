"""Read-only checks for the experimental LLM Wiki preparation bundle.

This module neither invokes a model nor creates/updates a wiki. Source strings
are data; paths and URLs inside them are never opened or executed.
"""

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path


SCHEMA = "llm-wiki-prep/0"


def digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def source_digest(source):
    """Fixture fingerprint, independent of the Core contentHash contract."""
    content = {key: source.get(key) for key in
               ("source_id", "title", "published_at", "blocks")}
    if "source_context" in source:
        content["source_context"] = source["source_context"]
    return digest(content)


def lint(bundle):
    errors = []

    def fail(code, where):
        errors.append({"code": code, "at": where})

    def index(items, field, where):
        result = {}
        if not isinstance(items, list):
            fail("E_SHAPE", where)
            return result
        for number, item in enumerate(items):
            location = f"{where}[{number}]"
            if not isinstance(item, dict):
                fail("E_SHAPE", location)
                continue
            key = item.get(field)
            if not isinstance(key, str) or not key.strip():
                fail("E_ID", location)
                continue
            if key in result:
                fail("E_DUPLICATE_ID", location)
            result[key] = item
        return result

    if not isinstance(bundle, dict):
        return [{"code": "E_SHAPE", "at": "bundle"}]
    if bundle.get("schema_version") != SCHEMA:
        fail("E_SCHEMA", "schema_version")
    if bundle.get("dataset_kind") not in ("synthetic", "private"):
        fail("E_DATASET_KIND", "dataset_kind")
    sources = index(bundle.get("sources"), "source_id", "sources")
    pages = index(bundle.get("pages"), "page_id", "pages")
    personal = index(bundle.get("personal"), "note_id", "personal")
    for number, note in enumerate(personal.values()):
        if not isinstance(note.get("text"), str) or not note["text"].strip():
            fail("E_PERSONAL_TEXT", f"personal[{number}]")
    blocks_by_source = {}

    for source_number, source in enumerate(sources.values()):
        where = f"sources[{source_number}]"
        if not isinstance(source.get("title"), str) or not source["title"].strip():
            fail("E_TITLE", where)
        if source.get("availability") not in ("active", "withdrawn"):
            fail("E_SOURCE_STATE", where)
        if "source_context" in source and not isinstance(source["source_context"], dict):
            fail("E_SHAPE", where + ".source_context")
        published = source.get("published_at")
        try:
            if published is not None:
                date.fromisoformat(published)
        except (TypeError, ValueError):
            fail("E_DATE", where)
        blocks = index(source.get("blocks"), "block_id", where + ".blocks")
        blocks_by_source[source["source_id"]] = blocks
        for block_number, block in enumerate(blocks.values()):
            position = f"{where}.blocks[{block_number}]"
            kind, state = block.get("kind"), block.get("state")
            if kind not in ("body", "image_ocr", "video_transcript"):
                fail("E_BLOCK_KIND", position)
            text = block.get("text")
            if state not in ("available", "not_processed", "missing"):
                fail("E_BLOCK_STATE", position)
            if not isinstance(text, str) or (state == "available" and not text.strip()):
                fail("E_BLOCK_TEXT", position)
            elif state != "available" and text:
                fail("E_BLOCK_TEXT", position)
            locator = block.get("locator")
            if not isinstance(locator, dict):
                fail("E_LOCATOR", position)
                continue
            positive = lambda value: type(value) is int and value > 0
            if kind == "body" and not positive(locator.get("paragraph")):
                fail("E_LOCATOR", position)
            if kind == "image_ocr" and not positive(locator.get("image")):
                fail("E_LOCATOR", position)
            if kind == "video_transcript":
                if not positive(locator.get("video")):
                    fail("E_LOCATOR", position)
                timing_keys = ("start_ms", "end_ms", "duration_ms")
                if state == "available" or any(key in locator for key in timing_keys):
                    start, end, duration = (locator.get(key) for key in timing_keys)
                    if (any(type(v) is not int for v in (start, end, duration))
                            or not 0 <= start < end <= duration):
                        fail("E_LOCATOR", position)

    for page_number, page in enumerate(pages.values()):
        where = f"pages[{page_number}]"
        if not isinstance(page.get("title"), str) or not page["title"].strip():
            fail("E_TITLE", where)
        if page.get("status") not in ("draft", "reviewed"):
            fail("E_REVIEW_STATE", where)
        links = page.get("links")
        if not isinstance(links, list):
            fail("E_SHAPE", where + ".links")
        else:
            for link in links:
                if not isinstance(link, str) or link not in pages:
                    fail("E_BROKEN_LINK", where + ".links")
        claims = page.get("claims")
        if not isinstance(claims, list):
            fail("E_SHAPE", where + ".claims")
            continue
        for number, claim in enumerate(claims):
            position = f"{where}.claims[{number}]"
            if not isinstance(claim, dict):
                fail("E_SHAPE", position)
                continue
            if claim.get("kind") not in ("source_claim", "synthesis"):
                fail("E_CLAIM_KIND", position)
            if not isinstance(claim.get("text"), str) or not claim["text"].strip():
                fail("E_CLAIM_TEXT", position)
            evidence = claim.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                fail("E_NO_EVIDENCE", position)
                continue
            for ref_number, ref in enumerate(evidence):
                ref_at = f"{position}.evidence[{ref_number}]"
                if not isinstance(ref, dict):
                    fail("E_SHAPE", ref_at)
                    continue
                source_id, block_id = ref.get("source_id"), ref.get("block_id")
                if not isinstance(source_id, str) or source_id not in sources:
                    fail("E_SOURCE_MISSING", ref_at)
                    continue
                source = sources[source_id]
                if source.get("availability") != "active":
                    fail("E_SOURCE_WITHDRAWN", ref_at)
                if ref.get("source_digest") != source_digest(source):
                    fail("E_STALE_EVIDENCE", ref_at)
                blocks = blocks_by_source[source_id]
                if not isinstance(block_id, str) or block_id not in blocks:
                    fail("E_BLOCK_MISSING", ref_at)
                    continue
                block = blocks[block_id]
                if block.get("state") != "available":
                    fail("E_UNAVAILABLE_EVIDENCE", ref_at)
                quote, text = ref.get("quote"), block.get("text")
                if (not isinstance(quote, str) or not quote.strip()
                        or not isinstance(text, str) or quote not in text):
                    fail("E_QUOTE_NOT_FOUND", ref_at)
    return errors


def plan_updates(before, after):
    """List declared citation dependencies to review; never applies changes.

    Inputs are bundles with structurally valid source/page lists. Missing items
    in a candidate are reported as absent, not assumed deleted or withdrawn.
    """
    old = {source["source_id"]: source for source in before["sources"]}
    new = {source["source_id"]: source for source in after["sources"]}
    added, absent = new.keys() - old.keys(), old.keys() - new.keys()
    changed = {key for key in old.keys() & new.keys()
               if source_digest(old[key]) != source_digest(new[key])
               or old[key]["availability"] != new[key]["availability"]}
    affected = set()
    for page in before["pages"] + after["pages"]:
        dependencies = {ref["source_id"] for claim in page["claims"]
                        for ref in claim["evidence"]
                        if isinstance(ref.get("source_id"), str)}
        if dependencies & (added | absent | changed):
            affected.add(page["page_id"])
    return {
        "new_sources": sorted(added),
        "changed_sources": sorted(changed),
        "absent_from_candidate": sorted(absent),
        "withdrawn_sources": sorted(key for key in new
                                    if new[key]["availability"] == "withdrawn"),
        "pages_to_review": sorted(affected),
        "personal_changed": before["personal"] != after["personal"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("lint", help="check a candidate JSON bundle")
    check.add_argument("bundle", type=Path)
    plan = commands.add_parser("plan", help="compare two bundles, without writing")
    plan.add_argument("before", type=Path)
    plan.add_argument("after", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "lint":
            errors = lint(json.loads(args.bundle.read_text(encoding="utf-8")))
            result = {"ok": not errors, "errors": errors}
        else:
            before = json.loads(args.before.read_text(encoding="utf-8"))
            after = json.loads(args.after.read_text(encoding="utf-8"))
            errors = lint(before) + lint(after)
            # Evidence failures are expected for a stale update candidate.
            plannable = {"E_STALE_EVIDENCE", "E_SOURCE_WITHDRAWN", "E_SOURCE_MISSING",
                         "E_BLOCK_MISSING", "E_UNAVAILABLE_EVIDENCE",
                         "E_QUOTE_NOT_FOUND", "E_BROKEN_LINK"}
            if any(error["code"] not in plannable for error in errors):
                result = {"ok": False, "errors": errors}
            else:
                changes = plan_updates(before, after)
                if changes["personal_changed"]:
                    errors.append({"code": "E_PERSONAL_CHANGED", "at": "personal"})
                result = {"ok": not errors, "plan": changes, "errors": errors}
    except (OSError, UnicodeError, json.JSONDecodeError):
        result = {"ok": False, "errors": [{"code": "E_INPUT", "at": "input"}]}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
