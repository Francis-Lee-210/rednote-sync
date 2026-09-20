from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import locate_token  # noqa: E402


class LocatorHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_dir = Path(self.temporary.name) / "data"
        self.capture_dir = self.data_dir / "captures"
        self.capture_dir.mkdir(parents=True)

    def write_capture(self, name: str, lines: list[object]) -> Path:
        path = self.capture_dir / name
        path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")
        path.chmod(0o600)
        return path

    def run_main(self, path: Path) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(locate_token, "DATA_DIR", self.data_dir), patch.object(
            sys, "argv", ["locate_token.py", "--capture", str(path)]
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            result = locate_token.main()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_rejects_capture_outside_private_capture_directory(self) -> None:
        outside = Path(self.temporary.name) / "outside.jsonl"
        outside.write_text("{}\n", encoding="utf-8")
        outside.chmod(0o600)
        result, _stdout, stderr = self.run_main(outside)
        self.assertEqual(result, 2)
        self.assertIn("must be below", stderr)

    def test_rejects_symlink_and_group_readable_file(self) -> None:
        target = self.write_capture("target.jsonl", [{"kind": "x", "payload": {}}])
        link = self.capture_dir / "link.jsonl"
        link.symlink_to(target)
        result, _stdout, stderr = self.run_main(link)
        self.assertEqual(result, 2)
        self.assertIn("symbolic link", stderr)

        target.chmod(0o640)
        result, _stdout, stderr = self.run_main(target)
        self.assertEqual(result, 2)
        self.assertIn("owner-only", stderr)

    def test_rejects_malformed_jsonl_record_and_payload(self) -> None:
        malformed = self.capture_dir / "malformed.jsonl"
        malformed.write_text('{"kind":"x","payload":{}}\nnot-json\n', encoding="utf-8")
        malformed.chmod(0o600)
        result, _stdout, stderr = self.run_main(malformed)
        self.assertEqual(result, 2)
        self.assertIn("line 2", stderr)

        for name, record, message in (
            ("record.jsonl", [], "record must be an object"),
            ("payload.jsonl", {"kind": "x", "payload": []}, "invalid payload"),
        ):
            with self.subTest(name=name):
                path = self.write_capture(name, [record])
                result, _stdout, stderr = self.run_main(path)
                self.assertEqual(result, 2)
                self.assertIn(message, stderr)

    def test_structural_camel_case_fields_succeed_without_token_suffix(self) -> None:
        token = "prefix1234MIDDLEsensitive-suffix"
        path = self.write_capture(
            "camel.jsonl",
            [
                {
                    "kind": "network.target_access_material",
                    "payload": {
                        "fragments": [{"xsecToken": token, "xsecSource": "pc_search"}]
                    },
                }
            ],
        )
        result, stdout, stderr = self.run_main(path)
        self.assertEqual(result, 0)
        self.assertEqual(stderr, "")
        self.assertIn("token_prefix=prefix1234...", stdout)
        self.assertIn("xsec_source=pc_search", stdout)
        self.assertNotIn("sensitive-suffix", stdout)
        self.assertNotIn(token, stdout)

    def test_url_query_fields_and_sanitized_location_are_parsed_structurally(self) -> None:
        path = self.write_capture(
            "location.jsonl",
            [
                {
                    "kind": "network.response",
                    "payload": {
                        "headers": {
                            "location": "https://www.xiaohongshu.com/explore/n?"
                            "xsec_token=abcdefghijklmno&xsec_source=pc_search"
                        }
                    },
                }
            ],
        )
        result, stdout, _stderr = self.run_main(path)
        self.assertEqual(result, 0)
        self.assertIn("payload.headers.location.query.xsec_token", stdout)
        self.assertNotIn("abcdefghijklmno", stdout)

    def test_textual_mentions_do_not_count_and_token_requires_source(self) -> None:
        textual = self.write_capture(
            "textual.jsonl",
            [{"kind": "note", "payload": {"body": "xsec_token=abcdefghijklmno&xsec_source=fake"}}],
        )
        result, stdout, _stderr = self.run_main(textual)
        self.assertEqual(result, 1)
        self.assertIn("missing token and source", stdout)

        token_only = self.write_capture(
            "token-only.jsonl",
            [{"kind": "note", "payload": {"xsec_token": "abcdefghijklmno"}}],
        )
        result, stdout, _stderr = self.run_main(token_only)
        self.assertEqual(result, 1)
        self.assertIn("missing source", stdout)

    def test_untrusted_terminal_content_is_escaped_and_bounded(self) -> None:
        path = self.write_capture(
            "terminal.jsonl",
            [
                {
                    "kind": "network.\x1b[31mresponse",
                    "payload": {
                        "xsec_token": "abc\x1b[31mdefghijklmnop",
                        "xsec_source": "pc\x1b[31msearch",
                    },
                }
            ],
        )
        result, stdout, _stderr = self.run_main(path)
        self.assertEqual(result, 0)
        self.assertNotIn("\x1b", stdout)
        self.assertIn("%1B", stdout)


if __name__ == "__main__":
    unittest.main()
