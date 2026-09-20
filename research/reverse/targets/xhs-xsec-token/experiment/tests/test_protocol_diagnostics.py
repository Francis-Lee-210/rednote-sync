"""Synthetic transport regressions; never a test of remote 461 acceptance."""
from __future__ import annotations

import copy
import importlib
import io
import json
import socket
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import common
import protocol_experiment as runner
import protocol_session as protocol

COOKIE = "a1=" + "a" * 52 + "; web_session=synthetic-session"
POLICY = {**common.REQUEST_POLICY_DEFAULTS, "min_delay_seconds": 0, "max_delay_seconds": 0}
FILTERS = [
    {"tags": ["general"], "type": "sort_type"},
    {"tags": ["不限"], "type": "filter_note_type"},
    {"tags": ["不限"], "type": "filter_note_time"},
    {"tags": ["不限"], "type": "filter_note_range"},
    {"tags": ["不限"], "type": "filter_pos_distance"},
]


class SyntheticSigner:
    user_agent = "synthetic-agent"

    def __init__(self):
        self.payloads = []

    def headers(self, method, path, cookies, payload):
        self.payloads.append(copy.deepcopy(payload))
        return {"x-s": "synthetic-signature", "x-t": "1", "x-s-common": "synthetic-common"}


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        for target, attr in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                             (socket, "getaddrinfo"), (socket, "create_connection")):
            blocker = patch.object(target, attr, side_effect=AssertionError("NETWORK_FORBIDDEN"))
            blocker.start()
            self.addCleanup(blocker.stop)
        sleeper = patch.object(protocol.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.account = {"account_id": "test_synthetic", "source": "self_registered", "cookie": COOKIE}

    def client(self, search_response):
        requests = []
        signer = SyntheticSigner()

        def transport(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(200, json={"success": True, "code": 0,
                                               "data": {"guest": False, "user_id": "synthetic-user"}})
            if len(requests) != 2:
                raise AssertionError("unexpected extra request")
            return search_response

        client = protocol.ProtocolSession(self.account, POLICY, signer=signer,
                                          transport=httpx.MockTransport(transport))
        self.addCleanup(client.close)
        return client, requests, signer

    def fail_search(self, response, expected="HTTP_RISK_STOP"):
        client, requests, _ = self.client(response)
        client.identity()
        with self.assertRaisesRegex(protocol.ProtocolError, "^" + expected + "$"):
            client.search("synthetic-keyword")
        with self.assertRaises(protocol.ProtocolError):
            client.search("no retry")
        with self.assertRaises(protocol.ProtocolError):
            client.detail({})
        self.assertEqual(len(requests), 2)
        self.assertTrue(client._stopped)
        self.assertEqual(client.events[-1]["result"], expected)
        return client.events[-1]

    def test_error_code_and_challenge_flags_survive_all_risk_stops(self):
        for status in (403, 429, 461, 471):
            with self.subTest(status=status):
                event = self.fail_search(httpx.Response(status, json={
                    "success": False, "code": 300015, "msg": "安全验证 captcha SECRET_TEXT",
                }, headers={"verifytype": "SECRET_TYPE", "verifyuuid": "SECRET_ID"}))
                self.assertEqual(event.get("api_code"), 300015)
                diag = event["diagnostics"]
                self.assertTrue(diag["verifytype_present"])
                self.assertTrue(diag["verifyuuid_present"])
                self.assertEqual(diag["body_state"], "json_object")
                self.assertEqual(diag["message_flags"], ["captcha_hint", "security_verification_hint"])
                self.assertNotIn("SECRET", json.dumps(event))

    def test_distinct_risk_reasons_remain_distinguishable(self):
        first = self.fail_search(httpx.Response(461, json={"code": 300015}))
        second = self.fail_search(httpx.Response(461, json={"code": 999001},
                                                 headers={"verifytype": "synthetic"}))
        self.assertNotEqual(first, second)

    def test_http_classification_is_not_overwritten_by_error_json(self):
        for status, result in ((401, "AUTH_REQUIRED"), (302, "REDIRECT_REFUSED"),
                               (500, "HTTP_ERROR"), (461, "HTTP_RISK_STOP")):
            with self.subTest(status=status):
                event = self.fail_search(httpx.Response(status, json={"code": -100},
                                                        headers={"verifytype": ""}), result)
                self.assertEqual(event.get("api_code"), -100)
                self.assertTrue(event["diagnostics"]["verifytype_present"])

    def test_api_errors_and_2xx_challenge_preserve_diagnostics(self):
        event = self.fail_search(httpx.Response(200, json={
            "success": False, "code": 300015, "msg": "访问频繁",
        }), "SIGNATURE_REJECTED")
        self.assertEqual(event["api_code"], 300015)
        self.assertEqual(event["diagnostics"]["message_flags"], ["rate_limit_hint"])
        event = self.fail_search(httpx.Response(200, json={"code": 0},
                                               headers={"verifyuuid": ""}), "CHALLENGE_REQUIRED")
        self.assertTrue(event["diagnostics"]["verifyuuid_present"])

    def test_invalid_codes_and_nested_or_nonstring_messages_are_not_copied(self):
        for code in (True, 1.2, "300015", 2 ** 65, None):
            with self.subTest(code_type=type(code).__name__):
                event = self.fail_search(httpx.Response(461, json={
                    "code": code, "msg": {"private": "captcha"},
                    "data": {"desc": "安全验证 captcha PRIVATE_TEXT"},
                }))
                self.assertNotIn("api_code", event)
                self.assertEqual(event["diagnostics"]["message_flags"], [])
                self.assertNotIn("PRIVATE_TEXT", json.dumps(event))

    def test_unparseable_responses_retain_http_stop(self):
        for content, content_type, state in (
            (b"<html>PRIVATE_BODY</html>", "text/html", "non_json"),
            (b"{broken", "application/json", "invalid_json"),
            (b"[]", "application/json", "non_object_json"),
            (b"{", "text/not-json", "non_json"),
            (b"[" * 1500, "application/json", "invalid_json"),
        ):
            with self.subTest(state=state):
                event = self.fail_search(httpx.Response(461, content=content,
                                                       headers={"content-type": content_type}))
                self.assertEqual(event["diagnostics"]["body_state"], state)
                self.assertNotIn("PRIVATE_BODY", json.dumps(event))

    def test_diagnostic_stream_read_failures_cannot_hide_risk_status(self):
        for error, state in ((httpx.ReadTimeout("PRIVATE_ERROR"), "timeout"),
                             (httpx.ReadError("PRIVATE_ERROR"), "read_error")):
            with self.subTest(state=state):
                class BrokenStream(httpx.SyncByteStream):
                    def __iter__(self):
                        raise error
                        yield b""  # Makes this a stream, not an eager exception.
                event = self.fail_search(httpx.Response(461, stream=BrokenStream(),
                                                       headers={"content-type": "application/json"}))
                self.assertEqual(event["diagnostics"]["body_state"], state)
                self.assertNotIn("PRIVATE_ERROR", json.dumps(event))

    def test_stream_close_and_collector_failures_preserve_original_stop(self):
        class BadCloseResponse(httpx.Response):
            def close(self):
                super().close()
                if getattr(self, "break_on_close", False):
                    raise httpx.ReadError("PRIVATE_CLOSE_ERROR")

        response = BadCloseResponse(461, json={"code": 300015})
        response.break_on_close = True
        event = self.fail_search(response)
        self.assertEqual(event["api_code"], 300015)
        with patch.object(protocol, "failed_response_metadata", side_effect=ValueError("PRIVATE_ERROR")):
            event = self.fail_search(httpx.Response(461, json={"code": 300015}))
        self.assertEqual(event["diagnostics"]["body_state"], "read_error")

    def test_wall_budget_and_stop_state_are_checked_while_reading(self):
        import protocol_diagnostics

        class SlowStream(httpx.SyncByteStream):
            def __iter__(self):
                self_outer.assertTrue(client._stopped)
                yield b'{"code":300015}'

        self_outer = self
        client, requests, _ = self.client(httpx.Response(461, stream=SlowStream(),
                                                        headers={"content-type": "application/json"}))
        client.identity()
        with patch.object(protocol_diagnostics, "time") as clock:
            clock.monotonic.side_effect = [0, 3]
            with self.assertRaisesRegex(protocol.ProtocolError, "^HTTP_RISK_STOP$"):
                client.search("synthetic")
        self.assertEqual(client.events[-1]["diagnostics"]["body_state"], "timeout")
        self.assertEqual(len(requests), 2)

    def test_ambiguous_json_and_nonfinite_values_are_not_diagnostic_evidence(self):
        for body in (b'{"code":300015,"code":0}', b'{"code":NaN}'):
            event = self.fail_search(httpx.Response(461, content=body,
                                                   headers={"content-type": "application/json"}))
            self.assertEqual(event["diagnostics"]["body_state"], "invalid_json")
            self.assertNotIn("api_code", event)

    def test_oversized_stream_is_not_fully_consumed(self):
        consumed = []

        class LargeStream(httpx.SyncByteStream):
            def __iter__(self):
                consumed.append(1)
                yield b"x" * (16 * 1024 + 1)
                consumed.append(2)
                yield b"PRIVATE_REMAINDER"

        event = self.fail_search(httpx.Response(461, stream=LargeStream(),
                                               headers={"content-type": "application/json"}))
        self.assertEqual(consumed, [1])
        self.assertEqual(event["diagnostics"]["body_state"], "too_large")

    def test_compressed_error_is_not_decompressed_or_read(self):
        class UnreadStream(httpx.SyncByteStream):
            def __iter__(self):
                raise AssertionError("compressed body must not be read")
                yield b""
        event = self.fail_search(httpx.Response(461, stream=UnreadStream(), headers={
            "content-type": "application/json", "content-encoding": "gzip", "verifytype": "private",
        }))
        self.assertEqual(event["diagnostics"]["body_state"], "encoded_body_skipped")
        self.assertTrue(event["diagnostics"]["verifytype_present"])

    def test_runner_persists_only_safe_error_metadata_without_capture(self):
        private_values = (COOKIE, "PRIVATE_UUID", "PRIVATE_TYPE", "PRIVATE_TOKEN",
                          "PRIVATE_MSG", "https://private.example/challenge", "synthetic-user")
        client, requests, _ = self.client(httpx.Response(461, json={
            "code": 300015, "msg": "安全验证 PRIVATE_MSG " + COOKIE,
            "data": {"token": "PRIVATE_TOKEN", "url": private_values[-2]},
        }, headers={"verifytype": "PRIVATE_TYPE", "verifyuuid": "PRIVATE_UUID",
                    "location": private_values[-2], "set-cookie": "web_session=PRIVATE_TOKEN"}))
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()) as output:
                code, report_path = runner.run_protocol(self.account, POLICY, bind_identity=True,
                                                       note_id="synthetic-note", query="synthetic-query")
            self.assertEqual(code, 1)
            text = report_path.read_text()
            report = json.loads(text)
            self.assertEqual(report.get("client_revision"), 3)
            self.assertEqual(report["requests"][-1].get("api_code"), 300015)
            self.assertTrue(report["requests"][-1]["diagnostics"]["verifyuuid_present"])
            self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
            self.assertNotIn("capture", report)
            self.assertFalse((Path(temp) / "captures").exists())
            for secret in (*private_values, "synthetic-query", "synthetic-signature"):
                self.assertNotIn(secret, text + output.getvalue())
            self.assertEqual(len(requests), 2)

    def test_search_payload_matches_fixed_reference_default_contract(self):
        client, requests, signer = self.client(httpx.Response(200, json={
            "success": True, "code": 0, "data": {"items": []},
        }))
        keyword = '中文 "quote" slash\\ emoji🍎'
        client.identity()
        client.search(keyword)
        payload = json.loads(requests[-1].content)
        self.assertEqual(payload.get("filters"), FILTERS)
        self.assertEqual(set(payload), {"keyword", "page", "page_size", "search_id", "sort",
                                        "note_type", "ext_flags", "filters", "geo", "image_formats"})
        self.assertEqual((payload["page"], payload["page_size"], payload["sort"], payload["note_type"]),
                         (1, 20, "general", 0))
        self.assertEqual(payload["keyword"], keyword)
        self.assertEqual(payload["ext_flags"], [])
        self.assertEqual(payload["geo"], "")
        self.assertEqual(payload["image_formats"], ["jpg", "webp", "avif"])
        self.assertEqual(requests[-1].content, json.dumps(signer.payloads[-1], ensure_ascii=False,
                                                       separators=(",", ":")).encode("utf-8"))
        self.assertEqual(len(requests), 2)

    def test_filters_are_fresh_for_each_session(self):
        for index in range(2):
            client, _, signer = self.client(httpx.Response(200, json={
                "success": True, "code": 0, "data": {"items": []},
            }))
            original = signer.headers

            def inspect_and_mutate(method, path, cookies, payload):
                if method == "POST":
                    self.assertEqual(payload["filters"], FILTERS)
                    result = original(method, path, cookies, payload)
                    # Deliberately mutate the actual input, not the signer's copy.
                    payload["filters"][0]["tags"].append("synthetic mutation")
                    return result
                return original(method, path, cookies, payload)

            with self.subTest(session=index), patch.object(signer, "headers", side_effect=inspect_and_mutate):
                client.identity()
                client.search("synthetic")

    def test_real_signer_bytes_still_match_with_filters(self):
        signer = protocol.LocalSigner()
        signed = []
        rap = []
        requests = []
        xrap = importlib.import_module("xhshow.core.xrap")
        original_content = signer._signer._build_content_string
        original_rap = xrap._to_compact_json

        def record_content(method, uri, payload=None):
            result = original_content(method, uri, payload)
            signed.append(result.encode("utf-8"))
            return result

        def record_rap(payload):
            result = original_rap(payload)
            rap.append(result.encode("utf-8"))
            return result

        def transport(request):
            requests.append(request)
            data = {"guest": False, "user_id": "synthetic-user"} if len(requests) == 1 else {"items": []}
            return httpx.Response(200, json={"success": True, "code": 0, "data": data})

        client = protocol.ProtocolSession(self.account, POLICY, signer=signer,
                                          transport=httpx.MockTransport(transport))
        self.addCleanup(client.close)
        with patch.object(signer._signer, "_build_content_string", side_effect=record_content), \
             patch.object(xrap, "_to_compact_json", side_effect=record_rap):
            client.identity()
            client.search('中文 "quote" slash\\ emoji🍎')
        self.assertEqual(len(requests), 2)
        self.assertEqual(signed[-1], protocol.SEARCH_PATH.encode() + requests[-1].content)
        self.assertEqual(rap, [requests[-1].content])
        self.assertEqual(json.loads(requests[-1].content)["filters"], FILTERS)


if __name__ == "__main__":
    unittest.main()
