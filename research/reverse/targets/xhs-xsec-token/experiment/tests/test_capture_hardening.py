from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from capture_visit import (  # noqa: E402
    DETAIL_STATE_PROBE,
    Recorder,
    access_material_for_note,
    allowed_note_url,
    drain_access_responses,
    is_capture_payload_response,
    sanitize_browser_event,
    sanitize_record_headers,
    search_document_verdict,
    load_public_sample,
)
import capture_visit  # noqa: E402
from common import ConfigError  # noqa: E402


class CaptureHardeningTests(unittest.TestCase):
    def test_recorder_enforces_size_limit_before_writing_overflow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.jsonl"
            recorder = Recorder(path, max_bytes=1, max_events=1)
            try:
                with self.assertRaisesRegex(ConfigError, "safety limit"):
                    recorder.emit("synthetic", {})
            finally:
                recorder.close()
            self.assertEqual(path.read_text(encoding="utf-8"), "")

    def test_notes_file_is_local_unique_and_fully_validated(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            capture_visit, "CONFIG_DIR", Path(directory)
        ):
            notes = Path(directory) / "notes.yaml"
            notes.write_text(
                "notes:\n"
                "  - note_id: note123\n"
                "    type: public\n"
                "    search_queries: [query]\n"
                "    enabled: true\n"
                "  - note_id: note123\n"
                "    type: public\n"
                "    search_queries: [other]\n"
                "    enabled: false\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ConfigError, "duplicate note_id"):
                load_public_sample(notes, "note123")
            outside = Path(directory).parent / "outside-notes.yaml"
            with self.assertRaisesRegex(ConfigError, "config directory"):
                load_public_sample(outside, "note123")

    def test_detail_probe_only_accepts_detail_specific_state(self) -> None:
        self.assertIn("notedetailmap", DETAIL_STATE_PROBE.lower())
        self.assertNotIn("node.desc", DETAIL_STATE_PROBE)

    def test_detail_url_is_exact_canonical_https_route(self) -> None:
        target = "note123"
        self.assertTrue(
            allowed_note_url(
                "https://www.xiaohongshu.com/explore/note123?xsec_token=token",
                target,
            )
        )
        rejected = (
            "http://www.xiaohongshu.com/explore/note123",
            "https://www.xiaohongshu.com:8443/explore/note123",
            "https://xiaohongshu.com/explore/note123",
            "https://www.xiaohongshu.com/user/note123",
            "https://www.xiaohongshu.com/explore/note123/extra",
            "https://www.xiaohongshu.com/explore/note1234",
        )
        for value in rejected:
            with self.subTest(value=value):
                self.assertFalse(allowed_note_url(value, target))

    def test_header_urls_are_sanitized_without_losing_access_material(self) -> None:
        headers = sanitize_record_headers(
            {
                "Referer": (
                    "https://www.xiaohongshu.com/explore/note123?keyword=private"
                    "&xsec_token=token&xsec_source=pc_search"
                ),
                "Location": "https://www.xiaohongshu.com/explore/note123?extra=secret",
                "Cookie": "credential",
            },
            note_id="note123",
        )
        rendered = repr(headers)
        self.assertNotIn("private", rendered)
        self.assertNotIn("secret", rendered)
        self.assertNotIn("credential", rendered)
        self.assertIn("xsec_token=token", headers["Referer"])
        self.assertIn("xsec_source=pc_search", headers["Referer"])

    def test_target_fragments_require_exact_structural_association(self) -> None:
        target = "note123"
        payload = {
            "items": [
                {
                    "note_id": target,
                    "id": "author-secret",
                    "xsec_token": "target-token",
                    "xsec_source": "pc_search",
                    "url": (
                        "https://www.xiaohongshu.com/explore/note123"
                        "?keyword=private&xsec_token=target-token"
                    ),
                },
                {
                    "noteId": target,
                    "xsecToken": "relative-token",
                    "url": "/explore/note123?keyword=hidden&xsec_source=pc_search",
                },
                {
                    "description": f"mentions {target}",
                    "xsec_token": "wrong-token",
                },
                {"note_id": "other", "xsec_token": "other-token"},
            ]
        }

        fragments = access_material_for_note(payload, target)
        rendered = repr(fragments)
        self.assertEqual(len(fragments), 2)
        self.assertIn("target-token", rendered)
        self.assertNotIn("author-secret", rendered)
        self.assertNotIn("private", rendered)
        self.assertNotIn("wrong-token", rendered)
        self.assertNotIn("other-token", rendered)
        self.assertNotIn("hidden", rendered)

    def test_unreadable_allowlisted_payload_is_classified(self) -> None:
        class Recorder:
            def __init__(self) -> None:
                self.events = []

            def emit(self, kind, payload) -> None:
                self.events.append((kind, payload))

        class Response:
            url = "https://www.xiaohongshu.com/api/sns/web/v1/search/notes"

            def json(self):
                raise ValueError("synthetic unreadable body")

        recorder = Recorder()
        consumed = drain_access_responses(recorder, [Response()], 0, "note123")
        self.assertEqual(consumed, 1)
        self.assertEqual(
            recorder.events[0][0],
            "network.target_access_material.unreadable",
        )

    def test_only_allowlisted_search_payload_responses_are_candidates(self) -> None:
        def response(url: str, method: str = "POST", content_type: str = "application/json"):
            return SimpleNamespace(
                url=url,
                headers={"content-type": content_type},
                request=SimpleNamespace(method=method, resource_type="fetch"),
            )

        self.assertTrue(
            is_capture_payload_response(
                response("https://www.xiaohongshu.com/api/sns/web/v1/search/notes")
            )
        )
        self.assertFalse(
            is_capture_payload_response(
                response("https://www.xiaohongshu.com/api/sns/web/v1/user/me")
            )
        )
        self.assertFalse(
            is_capture_payload_response(
                response("https://evil.example/api/sns/web/v1/search/notes")
            )
        )

    def test_search_document_requires_2xx(self) -> None:
        self.assertIsNone(search_document_verdict(200))
        self.assertEqual(search_document_verdict(None), "SEARCH_NO_DOCUMENT_RESPONSE")
        self.assertEqual(search_document_verdict(500), "SEARCH_HTTP_ERROR")

    def test_browser_event_rejects_untrusted_kind_and_payload(self) -> None:
        self.assertIsNone(sanitize_browser_event("steal.cookies", {"cookie": "secret"}))
        self.assertIsNone(sanitize_browser_event("fetch", {"url": "data:text/plain,secret"}))
        event = sanitize_browser_event(
            "xhr.open",
            {
                "url": "/api/sns/web/v1/search/notes?keyword=private&xsec_token=token",
                "method": "POST",
                "extra": "must-not-survive",
            },
            note_id="note123",
        )
        self.assertEqual(
            event,
            {
                "url": "/api/sns/web/v1/search/notes?keyword=%3Credacted%3E&xsec_token=%3Credacted%3E",
                "method": "POST",
            },
        )


if __name__ == "__main__":
    unittest.main()
