from __future__ import annotations

import io
import json
import socket
import stat
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

from test_protocol import COOKIE, POLICY, USER_ID, FakeSigner, envelope, identity_data

import common
import protocol_experiment as runner
import protocol_session as protocol
import run_experiment


NOTE_ID = "note123"
QUERY = "synthetic private query"
TARGET_TOKEN = "synthetic-target-token"
OTHER_TOKEN = "synthetic-unrelated-token"


class ProtocolSearchOnlyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name) / "runtime"
        self.account = {"account_id": "test_d", "source": "self_registered", "cookie": COOKIE}
        self.signer = FakeSigner()
        self.requests = []
        # The real HTTP session always receives MockTransport; also deny network
        # and DNS at the socket boundary so a missed injection fails offline.
        for target, name, kwargs in (
            (common, "DATA_DIR", {"new": self.runtime}),
            (runner, "DATA_DIR", {"new": self.runtime}),
            (runner, "LocalSigner", {"return_value": self.signer}),
            (protocol.time, "sleep", {}),
            (socket.socket, "connect", {"side_effect": AssertionError("network forbidden")}),
            (socket.socket, "connect_ex", {"side_effect": AssertionError("network forbidden")}),
            (socket, "getaddrinfo", {"side_effect": AssertionError("DNS forbidden")}),
        ):
            patcher = patch.object(target, name, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def client(self, responses):
        def handler(request):
            self.requests.append(request)
            if len(self.requests) > len(responses):
                raise AssertionError("request exceeded the supplied offline responses")
            return responses[len(self.requests) - 1]

        client = protocol.ProtocolSession(
            self.account, POLICY, transport=httpx.MockTransport(handler), signer=self.signer
        )
        self.addCleanup(client.close)
        return client

    def search_responses(self, items):
        return [
            httpx.Response(200, json=envelope(identity_data())),
            httpx.Response(200, json=envelope({"items": items})),
        ]

    def run_search(self, responses):
        client = self.client(responses)
        with patch.object(runner, "ProtocolSession", return_value=client), \
             patch.object(client, "detail", side_effect=AssertionError("detail forbidden")) as detail, \
             redirect_stdout(io.StringIO()) as output:
            code, report_path = runner.run_protocol(
                self.account, POLICY, bind_identity=True,
                note_id=NOTE_ID, query=QUERY, search_only=True,
            )
        detail.assert_not_called()
        self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
        report_text = report_path.read_text()
        report = json.loads(report_text)
        self.assertEqual(report["phase"], "search")
        self.assertIs(report["search_only"], True)
        self.assertIs(report["detail_verified"], False)
        self.assertEqual(report["client_revision"], 3)
        safe_output = output.getvalue() + report_text
        for secret in (COOKIE, USER_ID, QUERY, TARGET_TOKEN, OTHER_TOKEN, "synthetic-signature"):
            self.assertNotIn(secret, safe_output)
        self.assertNotIn("step=detail", output.getvalue())
        return code, report

    def assert_request_paths(self, *expected):
        self.assertEqual([(request.method, request.url.path) for request in self.requests], list(expected))

    def assert_no_capture(self, report):
        self.assertNotIn("capture", report)
        self.assertFalse((self.runtime / "captures").exists())

    def test_search_only_captures_exact_target_after_two_requests_without_detail(self):
        code, report = self.run_search(self.search_responses([
            {"id": "other", "xsec_token": OTHER_TOKEN},
            {"id": NOTE_ID, "xsec_token": TARGET_TOKEN, "xsec_source": "pc_search",
             "note_card": {"note_id": NOTE_ID, "desc": "synthetic search card body"}},
        ]))
        self.assertEqual(code, 0)
        self.assertEqual(report["result"], "PROTOCOL_SEARCH_VERIFIED")
        self.assertIs(report["identity_verified"], True)
        self.assertIs(report["search_api_succeeded"], True)
        self.assertIs(report["target_discovered"], True)
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH), ("POST", protocol.SEARCH_PATH))
        self.assertEqual(len(report["requests"]), 2)
        capture = self.runtime / report["capture"]
        self.assertEqual(stat.S_IMODE(capture.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(capture.parent.stat().st_mode), 0o700)
        records = [json.loads(line) for line in capture.read_text().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["kind"], "protocol.search_access_material")
        self.assertEqual(records[0]["payload"], {
            "note_id": NOTE_ID, "xsec_token": TARGET_TOKEN,
            "xsec_source": "pc_search", "source_origin": "response",
        })
        for secret in (OTHER_TOKEN, COOKIE, USER_ID, QUERY, "synthetic search card body"):
            self.assertNotIn(secret, capture.read_text())
        self.assertTrue(all(request.headers["cookie"] == COOKIE for request in self.requests))

    def test_search_only_preserves_search_context_source_fallback(self):
        code, report = self.run_search(self.search_responses([
            {"id": NOTE_ID, "xsec_token": TARGET_TOKEN},
        ]))
        self.assertEqual(code, 0)
        self.assertEqual(report["source_origin"], "search_context")
        capture = self.runtime / report["capture"]
        material = json.loads(capture.read_text())["payload"]
        self.assertEqual(material["xsec_source"], "pc_search")
        self.assertEqual(material["source_origin"], "search_context")
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH), ("POST", protocol.SEARCH_PATH))

    def test_search_http_461_stops_without_capture_or_detail(self):
        code, report = self.run_search([
            httpx.Response(200, json=envelope(identity_data())),
            httpx.Response(461, json={"success": False, "code": 300012}),
        ])
        self.assertEqual(code, 1)
        self.assertEqual(report["result"], "HTTP_RISK_STOP")
        self.assertIs(report["identity_verified"], True)
        self.assertIs(report["search_api_succeeded"], False)
        self.assertIs(report["target_discovered"], False)
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH), ("POST", protocol.SEARCH_PATH))
        self.assertEqual(report["requests"][-1]["http_status"], 461)
        self.assert_no_capture(report)

    def test_search_success_without_target_remains_not_discoverable(self):
        code, report = self.run_search(self.search_responses([
            {"id": "note123-extra", "xsec_token": OTHER_TOKEN},
        ]))
        self.assertEqual(code, 1)
        self.assertEqual(report["result"], "NOT_DISCOVERABLE_FIRST_PAGE")
        self.assertIs(report["search_api_succeeded"], True)
        self.assertIs(report["target_discovered"], False)
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH), ("POST", protocol.SEARCH_PATH))
        self.assert_no_capture(report)

    def test_search_success_with_missing_token_does_not_discover_target(self):
        code, report = self.run_search(self.search_responses([{"id": NOTE_ID}]))
        self.assertEqual(code, 1)
        self.assertEqual(report["result"], "ACCESS_MATERIAL_INCOMPLETE_OR_CONFLICTING")
        self.assertIs(report["search_api_succeeded"], True)
        self.assertIs(report["target_discovered"], False)
        self.assert_no_capture(report)

    def test_expired_identity_prevents_search_capture_and_detail(self):
        code, report = self.run_search([
            httpx.Response(200, json={"success": False, "code": -100}),
        ])
        self.assertEqual(code, 1)
        self.assertEqual(report["result"], "SESSION_EXPIRED")
        self.assertIs(report["identity_verified"], False)
        self.assertIs(report["search_api_succeeded"], False)
        self.assertIs(report["target_discovered"], False)
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH))
        self.assert_no_capture(report)
        self.assertFalse((self.runtime / "protocol-identities").exists())

    def test_search_only_requires_note_and_query_before_network_or_state(self):
        cases = ((None, QUERY), ("", QUERY), (NOTE_ID, None), (NOTE_ID, ""),
                 (NOTE_ID, " \t\n"), (NOTE_ID, 123))
        with patch.object(runner, "ProtocolSession", side_effect=AssertionError("session forbidden")) as session, \
             patch.object(runner, "LocalSigner", side_effect=AssertionError("signer forbidden")) as signer:
            for note_id, query in cases:
                with self.subTest(note_id=note_id, query=query), \
                     self.assertRaisesRegex(protocol.ProtocolError, "^SEARCH_ONLY_REQUIRES_NOTE_AND_QUERY$"):
                    runner.run_protocol(
                        self.account, POLICY, bind_identity=True,
                        note_id=note_id, query=query, search_only=True,
                    )
                self.assertFalse(self.runtime.exists())
        session.assert_not_called()
        signer.assert_not_called()
        self.assertEqual(self.requests, [])

    def test_default_discovery_still_verifies_detail_with_three_requests(self):
        responses = self.search_responses([{"id": NOTE_ID, "xsec_token": TARGET_TOKEN}])
        responses.append(httpx.Response(200, json=envelope({"items": [{"note_card": {
            "note_id": NOTE_ID, "type": "normal", "desc": "synthetic detail body",
        }}]})))
        client = self.client(responses)
        with patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()):
            code, report_path = runner.run_protocol(
                self.account, POLICY, bind_identity=True, note_id=NOTE_ID, query=QUERY,
            )
        report = json.loads(report_path.read_text())
        self.assertEqual(code, 0)
        self.assertEqual(report["phase"], "discovery")
        self.assertEqual(report["result"], "PROTOCOL_COMPLETE")
        self.assertIs(report["search_only"], False)
        self.assertIs(report["search_api_succeeded"], True)
        self.assertIs(report["target_discovered"], True)
        self.assertIs(report["detail_verified"], True)
        self.assert_request_paths(("GET", protocol.IDENTITY_PATH), ("POST", protocol.SEARCH_PATH),
                                  ("POST", protocol.DETAIL_PATH))

    @contextmanager
    def cli_inputs(self, argv):
        # File loading is replaced with synthetic inputs; default credential and
        # sample locations must never be opened by this offline test module.
        with patch.object(sys, "argv", argv), \
             patch.object(runner, "load_accounts_file", return_value=[self.account]), \
             patch.object(runner, "load_request_policy", return_value=POLICY), \
             patch.object(runner, "load_public_sample", return_value={"search_queries": [QUERY]}), \
             redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            yield output

    def test_wrapper_forwards_search_only_to_protocol_entrypoint(self):
        argv = ["run_experiment.py", "--account-id", "test_d", "--note-id", NOTE_ID,
                "--search-only", "--bind-identity", "--execute", "--yes"]
        with patch.object(sys, "argv", argv), \
             patch.object(run_experiment, "run_step", return_value=0) as step:
            self.assertEqual(run_experiment.main(), 0)
        step.assert_called_once()
        command = step.call_args.args[1]
        self.assertTrue(command[2].endswith("protocol_experiment.py"))
        self.assertIn("--search-only", command)
        self.assertEqual(command[command.index("--note-id") + 1], NOTE_ID)
        self.assertIn("--execute", command)
        self.assertIn("--yes", command)

    def test_wrapper_rejects_search_only_without_note_or_with_browser(self):
        for extra in ([], ["--transport", "browser", "--note-id", NOTE_ID],
                      ["--transport", "browser"]):
            argv = ["run_experiment.py", "--account-id", "test_d", "--search-only",
                    "--execute", "--yes", *extra]
            with self.subTest(extra=extra), patch.object(sys, "argv", argv), \
                 patch.object(run_experiment, "run_step", return_value=0) as step, \
                 redirect_stderr(io.StringIO()):
                self.assertEqual(run_experiment.main(), 2)
                step.assert_not_called()
        self.assertFalse(self.runtime.exists())

    def test_protocol_cli_forwards_search_only_to_run_protocol(self):
        argv = ["protocol_experiment.py", "--account-id", "test_d", "--note-id", NOTE_ID,
                "--search-only", "--bind-identity", "--execute", "--yes"]
        with self.cli_inputs(argv), patch.object(runner, "run_protocol", return_value=(0, self.runtime / "report.json")) as run:
            self.assertEqual(runner.main(), 0)
        run.assert_called_once()
        self.assertIs(run.call_args.kwargs["search_only"], True)
        self.assertEqual(run.call_args.kwargs["note_id"], NOTE_ID)
        self.assertEqual(run.call_args.kwargs["query"], QUERY)
        self.assertFalse(self.runtime.exists())

    def test_protocol_cli_rejects_search_only_without_note_before_inputs(self):
        argv = ["protocol_experiment.py", "--account-id", "test_d", "--search-only",
                "--bind-identity", "--execute", "--yes"]
        with patch.object(sys, "argv", argv), \
             patch.object(runner, "load_accounts_file", side_effect=AssertionError("inputs forbidden")) as inputs, \
             patch.object(runner, "run_protocol", side_effect=AssertionError("run forbidden")) as run, \
             redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(runner.main(), 2)
        self.assertIn("SEARCH_ONLY_REQUIRES_NOTE_ID", errors.getvalue())
        inputs.assert_not_called()
        run.assert_not_called()
        self.assertFalse(self.runtime.exists())

    def test_search_only_dry_run_has_no_network_browser_or_runtime_state(self):
        argv = ["protocol_experiment.py", "--account-id", "test_d", "--note-id", NOTE_ID,
                "--search-only", "--bind-identity"]
        with self.cli_inputs(argv) as output, \
             patch.object(runner, "run_protocol", side_effect=AssertionError("run forbidden")) as run, \
             patch.object(runner, "ProtocolSession", side_effect=AssertionError("session forbidden")) as session, \
             patch.object(run_experiment.subprocess, "Popen", side_effect=AssertionError("browser forbidden")) as process:
            self.assertEqual(runner.main(), 0)
        run.assert_not_called()
        session.assert_not_called()
        process.assert_not_called()
        self.assertIn("phase=search", output.getvalue())
        self.assertIn("dry-run", output.getvalue())
        self.assertFalse(self.runtime.exists())
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
