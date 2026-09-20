"""Exercise the current Notion-audit adapter with temporary synthetic files."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from check_wiki import lint, plan_updates, source_digest
from import_notion import build_bundle


ROOT = Path(__file__).resolve().parent


class NotionAdapterChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="rednote-notion-adapter-")
        self.addCleanup(self.tmp.cleanup)
        self.archive = Path(self.tmp.name).resolve() / "archive"
        (self.archive / "normalized").mkdir(parents=True)
        (self.archive / "source/export/entries").mkdir(parents=True)
        (self.archive / "supplemental/videos").mkdir(parents=True)
        (self.archive / "source/export/entries/post.md").write_text("合成原始帖子", encoding="utf-8")
        (self.archive / "source/export/entries/image.jpg").write_bytes(b"synthetic-image")
        self.row = {
            "id": "a" * 24, "notion_page_id": "b" * 32,
            "source_markdown": "entries/post.md", "source_sha256": "0" * 64,
            "title": "合成帖子", "source_properties": {
                "作者": "合成作者", "帖子创建时间": "未知",
                "创建时间": "2026年1月9日 22:40", "类型": "收藏", "状态": "处理中"},
            "source_url": "https://example.invalid/post?mock_token=PRIVATE_FIXTURE",
            "source_tags": ["合成标签"], "source_tags_origin": "synthetic attribution unverified",
            "body_markdown": "合成正文。", "body_text": "合成正文。", "body_chars": 5,
            "content_sha256": "1" * 64,
            "source_variants": ["entries/post.md"], "source_relations": ["点赞", "收藏"],
            "search_variant_policy": "Synthetic selected variant only",
            "media_processing": "Synthetic audit; no OCR",
            "media": [
                {"kind": "image", "storage": "local", "path": "entries/image.jpg",
                 "label": "合成图", "bytes": len(b"synthetic-image")},
                {"kind": "video", "storage": "remote_reference", "label": "合成视频",
                 "url": "http://example.invalid/video.mp4?mock_token=PRIVATE_FIXTURE"}],
        }
        self.item = {
            "key": "c" * 64, "url": "https://example.invalid/video.mp4",
            "note_ids": [self.row["id"]], "source_pages": ["source/export/entries/post.md"],
            "file": "supplemental/videos/video.mp4",
            "plan": {"status": "available", "bytes": 5},
        }
        self.save_inputs()

    def save_inputs(self):
        (self.archive / "normalized/corpus.jsonl").write_text(json.dumps(self.row, ensure_ascii=False) + "\n", encoding="utf-8")
        (self.archive / "supplemental/video-index.json").write_text(json.dumps({"items": [self.item]}), encoding="utf-8")

    def media_block(self, bundle, kind):
        return next(block for block in bundle["sources"][0]["blocks"] if block["kind"] == kind)

    def test_pending_video_keeps_body_and_does_not_invent_transcript(self):
        bundle, _ = build_bundle(self.archive)
        self.assertEqual(lint(bundle), [])
        self.assertEqual(self.media_block(bundle, "body")["state"], "available")
        video = self.media_block(bundle, "video_transcript")
        self.assertEqual(video["state"], "missing")
        self.assertEqual(video["text"], "")
        self.assertNotIn("duration_ms", video["locator"])
        self.assertEqual(bundle["pages"], [])
        self.assertIsNone(bundle["sources"][0]["published_at"])

    def test_original_media_presence_does_not_imply_ocr(self):
        bundle, _ = build_bundle(self.archive)
        block = self.media_block(bundle, "image_ocr")
        self.assertEqual(block["state"], "not_processed")
        self.assertEqual(block["text"], "")

    def test_partial_download_is_not_consumed(self):
        (self.archive / "supplemental/videos/video.mp4.part").write_bytes(b"incomplete")
        self.item["download"] = {"status": "downloaded", "bytes": 10}
        self.save_inputs()
        bundle, _ = build_bundle(self.archive)
        self.assertEqual(self.media_block(bundle, "video_transcript")["state"], "missing")

    def test_recorded_download_becomes_unprocessed_media_not_evidence(self):
        (self.archive / "supplemental/videos/video.mp4").write_bytes(b"video")
        self.item["download"] = {"status": "downloaded", "bytes": 5}
        self.item["verify"] = {"status": "verified", "bytes": 5}
        self.save_inputs()
        bundle, _ = build_bundle(self.archive)
        self.assertEqual(lint(bundle), [])
        video = self.media_block(bundle, "video_transcript")
        self.assertEqual(video["state"], "not_processed")
        self.assertEqual(video["text"], "")

    def test_completed_video_marks_the_source_for_incremental_review(self):
        before, _ = build_bundle(self.archive)
        (self.archive / "supplemental/videos/video.mp4").write_bytes(b"video")
        self.item["download"] = {"status": "downloaded", "bytes": 5}
        self.save_inputs()
        after, _ = build_bundle(self.archive)
        plan = plan_updates(before, after)
        self.assertEqual(plan["changed_sources"], [before["sources"][0]["source_id"]])
        self.assertFalse(plan["personal_changed"])

    def test_media_url_alone_is_not_readable_body(self):
        self.row["body_text"] = self.row["media"][1]["url"]
        self.save_inputs()
        bundle, report = build_bundle(self.archive)
        self.assertEqual(self.media_block(bundle, "body")["state"], "missing")
        self.assertEqual(report["counts"]["original_nonempty_body"], 1)
        self.assertEqual(report["counts"]["body_available"], 0)

    def test_unselected_variant_video_is_not_assigned_a_guessed_ordinal(self):
        extra = dict(self.item, key="d" * 64, url="https://example.invalid/another.mp4",
                     file="supplemental/videos/another.mp4")
        (self.archive / "supplemental/video-index.json").write_text(
            json.dumps({"items": [self.item, extra]}), encoding="utf-8")
        bundle, report = build_bundle(self.archive)
        videos = [b for b in bundle["sources"][0]["blocks"] if b["kind"] == "video_transcript"]
        self.assertEqual(len(videos), 1)
        self.assertEqual(report["counts"]["unselected_supplemental_video_associations"], 1)

    def test_input_and_personal_source_files_are_not_rewritten(self):
        before = {p.relative_to(self.archive): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.archive.rglob("*") if p.is_file()}
        build_bundle(self.archive)
        after = {p.relative_to(self.archive): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in self.archive.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_same_content_under_new_export_layout_keeps_knowledge_identity(self):
        before, _ = build_bundle(self.archive)
        (self.archive / "source/export/new-layout").mkdir()
        (self.archive / "source/export/entries/post.md").rename(self.archive / "source/export/new-layout/renamed.md")
        (self.archive / "source/export/entries/image.jpg").rename(self.archive / "source/export/new-layout/picture.jpg")
        self.row["source_markdown"] = "new-layout/renamed.md"
        self.row["source_variants"] = ["new-layout/renamed.md"]
        self.row["media"][0]["path"] = "new-layout/picture.jpg"
        self.item["source_pages"] = ["source/export/new-layout/renamed.md"]
        self.save_inputs()
        after, _ = build_bundle(self.archive)
        self.assertEqual(before["sources"][0]["source_id"], after["sources"][0]["source_id"])
        self.assertEqual(source_digest(before["sources"][0]), source_digest(after["sources"][0]))

    def test_url_access_material_is_not_propagated(self):
        bundle, report = build_bundle(self.archive)
        self.assertNotIn("PRIVATE_FIXTURE", json.dumps([bundle, report]))

    def test_broken_ledger_is_reported_instead_of_treated_as_empty(self):
        (self.archive / "supplemental/video-index.json").write_text('{"items": [')
        with self.assertRaises(ValueError):
            build_bundle(self.archive)

    def test_outside_media_path_cannot_supply_content(self):
        outside = Path(self.tmp.name) / "outside.jpg"
        outside.write_bytes(b"outside-synthetic-content")
        self.row["media"][0]["path"] = str(outside)
        self.save_inputs()
        bundle, _ = build_bundle(self.archive)
        self.assertEqual(self.media_block(bundle, "image_ocr")["state"], "missing")

    def test_cli_keeps_existing_snapshot_unchanged(self):
        out = Path(self.tmp.name).resolve() / "snapshot"
        command = [sys.executable, str(ROOT / "import_notion.py"), "--archive", str(self.archive), "--out", str(out)]
        first = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(first.returncode, 0, first.stderr)
        original = (out / "bundle.json").read_bytes()
        second = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((out / "bundle.json").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
