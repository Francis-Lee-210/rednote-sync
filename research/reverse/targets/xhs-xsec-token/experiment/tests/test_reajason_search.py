"""Offline integration checks for the fixed SDK, using synthetic inputs only."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import socket
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import common
import protocol_session as protocol
import reajason_search as runner

USER_ID = "synthetic-sdk-user"
DIGEST = hashlib.sha256(USER_ID.encode()).hexdigest()
NOTE_ID = "synthetic-note-123"
QUERY = "合成 SDK query"
TOKEN = "synthetic-sdk-token-private"
BODY_TEXT = "synthetic-sdk-note-body-private"
COOKIES = {
    "a1": "a" * 50 + "==", "web_session": "synthetic-session==",
    "webId": "synthetic-web-id", "gid": "synthetic-gid", "other": "keep==",
}
COOKIE = "; ".join(f"{name}={value}" for name, value in COOKIES.items())
POLICY = {**common.REQUEST_POLICY_DEFAULTS, "min_delay_seconds": 0, "max_delay_seconds": 0}


def envelope(data):
    return {"success": True, "code": 0, "data": data}


def identity_response(**overrides):
    return httpx.Response(200, json=envelope({"guest": False, "user_id": USER_ID, **overrides}))


def search_response():
    return httpx.Response(200, json=envelope({"has_more": False, "items": [
        {"id": NOTE_ID, "xsec_token": TOKEN, "note_card": {"note_id": NOTE_ID, "desc": BODY_TEXT}},
        {"id": NOTE_ID + "-extra", "note_card": {"desc": BODY_TEXT}},
        {"id": "synthetic-ad", "model_type": "hot_query"},
    ]}))


class FakeSigner:
    user_agent = "synthetic-sdk-agent"

    def __init__(self):
        self.signed = []
        self.on_sign = None

    def headers(self, method, path, cookies, payload):
        self.signed.append((method, path, copy.deepcopy(cookies), copy.deepcopy(payload)))
        if self.on_sign is not None:
            self.on_sign(method, path, payload)
        return {"x-s": "synthetic-sdk-signature", "x-t": "1", "x-s-common": "synthetic-sdk-common"}


@unittest.skipUnless((runner.SDK_SOURCE / "xhs/__init__.py").is_file(), "fixed SDK checkout is absent")
class ReajasonSearchTests(unittest.TestCase):
    def setUp(self):
        self.account = {"account_id": "synthetic_sdk", "source": "self_registered", "cookie": COOKIE}
        self.marker = {"identity_sha256": DIGEST}
        self.requests = []
        self.signer = FakeSigner()
        # MockTransport is the only external API seam. A missed injection must
        # still fail before DNS or any socket connection, including SDK imports.
        for target, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guard = patch.object(target, name, side_effect=AssertionError("network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def client(self, responses, *, signer=None, account=None):
        pending = iter(responses)

        def handler(request):
            self.requests.append(request)
            try:
                response = next(pending)
            except StopIteration:
                raise AssertionError("unexpected additional HTTP request") from None
            return response

        client = runner.ReajasonSearchClient(
            self.account if account is None else account, POLICY,
            transport=httpx.MockTransport(handler), signer=self.signer if signer is None else signer,
        )
        self.addCleanup(client.close)
        return client

    def assert_stopped(self, client, count):
        with self.assertRaises(protocol.ProtocolError):
            client.search(QUERY, NOTE_ID)
        self.assertEqual(len(self.requests), count)

    def test_native_search_sends_exact_six_fields_and_signed_utf8_bytes(self):
        client = self.client([identity_response(), search_response()])
        from xhs import XhsClient
        for name in ("get_self_info2", "get_note_by_keyword", "get", "post", "_pre_headers"):
            self.assertIs(getattr(type(client.sdk), name), getattr(XhsClient, name))
        client.identity(self.marker)
        summary = client.search(QUERY, NOTE_ID)
        self.assertIs(summary["target_found"], True)
        self.assertEqual([(request.method, str(request.url)) for request in self.requests], [
            ("GET", protocol.API_ORIGIN + protocol.IDENTITY_PATH),
            ("POST", protocol.API_ORIGIN + protocol.SEARCH_PATH),
        ])
        payload = json.loads(self.requests[1].content)
        self.assertEqual(set(payload), {"keyword", "page", "page_size", "search_id", "sort", "note_type"})
        self.assertEqual({key: value for key, value in payload.items() if key != "search_id"}, {
            "keyword": QUERY, "page": 1, "page_size": 20, "sort": "general", "note_type": 0,
        })
        self.assertRegex(payload["search_id"], r"^[0-9A-Z]+$")
        self.assertEqual(payload, self.signer.signed[1][3])
        expected = ('{"keyword":"合成 SDK query","page":1,"page_size":20,"search_id":"'
                    + payload["search_id"] + '","sort":"general","note_type":0}').encode("utf-8")
        self.assertEqual(self.requests[1].content, expected)
        self.assertEqual(self.requests[0].content, b"")
        self.assert_stopped(client, 2)

    def test_cookie_equals_and_absent_defaults_survive_set_cookie_unchanged(self):
        minimal = {name: COOKIES[name] for name in ("a1", "web_session")}
        for fields in (COOKIES, minimal):
            with self.subTest(fields=tuple(fields)):
                self.requests.clear()
                header = "; ".join(f"{name}={value}" for name, value in fields.items())
                account = {**self.account, "cookie": header}
                response = identity_response()
                response.headers["set-cookie"] = "web_session=synthetic-replacement; Path=/"
                client = self.client([response, search_response()], account=account)
                self.assertEqual(client.sdk.cookie_dict, fields)
                client.identity(self.marker)
                client.search(QUERY, NOTE_ID)
                self.assertEqual(client.sdk.cookie_dict, fields)
                self.assertTrue(all(request.headers["cookie"] == header for request in self.requests))
                self.assertEqual(self.signer.signed[-1][2], fields)
                self.assertNotIn("gid.sign", client.sdk.cookie_dict)

    def test_identity_requires_prior_binding_before_signing_or_network(self):
        client = self.client([])
        with self.assertRaisesRegex(protocol.ProtocolError, "^SDK_PRIOR_IDENTITY_REQUIRED$"):
            client.identity({})
        self.assertFalse(client.identity_verified)
        self.assertEqual(self.signer.signed, [])
        self.assertEqual(self.requests, [])

    def test_account_digest_can_supply_the_matching_prior_binding(self):
        client = self.client([identity_response(), search_response()], account={
            **self.account, "expected_user_id_sha256": DIGEST,
        })
        client.identity({})
        self.assertIs(client.identity_verified, True)
        self.assertIs(client.search(QUERY, NOTE_ID)["search_api_succeeded"], True)
        self.assertEqual(len(self.requests), 2)

    def test_guest_and_mismatched_identity_prevent_search(self):
        cases = (
            (identity_response(guest=True), self.marker, "GUEST_SESSION"),
            (identity_response(), {"identity_sha256": "0" * 64}, "IDENTITY_MISMATCH"),
            (identity_response(userId="synthetic-conflicting-user"), self.marker, "IDENTITY_CONFLICT"),
        )
        for response, marker, reason in cases:
            with self.subTest(reason=reason):
                self.requests.clear()
                client = self.client([response])
                with self.assertRaisesRegex(protocol.ProtocolError, f"^{reason}$"):
                    client.identity(marker)
                self.assertIs(client.identity_verified, False)
                self.assert_stopped(client, 1)

    def test_search_before_identity_stops_the_session_without_network(self):
        client = self.client([])
        with self.assertRaisesRegex(protocol.ProtocolError, "^IDENTITY_REQUIRED$"):
            client.search(QUERY, NOTE_ID)
        with self.assertRaisesRegex(protocol.ProtocolError, "^SDK_SESSION_STOPPED$"):
            client.identity(self.marker)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.signer.signed, [])

    def test_http_risk_stops_preserve_only_safe_diagnostics_and_never_retry(self):
        for status in (403, 429, 461, 471):
            with self.subTest(status=status):
                self.requests.clear()
                client = self.client([identity_response(), httpx.Response(
                    status, headers={"verifytype": "synthetic-private-type", "verifyuuid": TOKEN},
                    json={"success": False, "code": 300012, "msg": "验证码 " + TOKEN},
                )])
                client.identity(self.marker)
                with self.assertRaisesRegex(protocol.ProtocolError, "^HTTP_RISK_STOP$"):
                    client.search(QUERY, NOTE_ID)
                event = client.protocol.events[-1]
                self.assertEqual((event["http_status"], event["api_code"]), (status, 300012))
                self.assertIs(event["diagnostics"]["verifyuuid_present"], True)
                self.assertIn("captcha_hint", event["diagnostics"]["message_flags"])
                self.assertNotIn(TOKEN, json.dumps(event))
                self.assertNotIn("synthetic-private-type", json.dumps(event))
                self.assert_stopped(client, 2)

    def test_non_json_risk_response_stops_before_upstream_response_decoding(self):
        client = self.client([identity_response(), httpx.Response(461, text=TOKEN)])
        client.identity(self.marker)
        with self.assertRaisesRegex(protocol.ProtocolError, "^HTTP_RISK_STOP$"):
            client.search(QUERY, NOTE_ID)
        event = client.protocol.events[-1]
        self.assertEqual(event["diagnostics"]["body_state"], "non_json")
        self.assertNotIn(TOKEN, json.dumps(event))
        self.assert_stopped(client, 2)

    def test_expired_search_keeps_api_minus_100_without_response_text(self):
        client = self.client([identity_response(), httpx.Response(200, json={
            "success": False, "code": -100, "msg": "session expired " + TOKEN,
        })])
        client.identity(self.marker)
        with self.assertRaisesRegex(protocol.ProtocolError, "^SESSION_EXPIRED$"):
            client.search(QUERY, NOTE_ID)
        event = client.protocol.events[-1]
        self.assertEqual(event["api_code"], -100)
        self.assertIn("login_hint", event["diagnostics"]["message_flags"])
        self.assertNotIn(TOKEN, json.dumps(event))
        self.assert_stopped(client, 2)

    def test_success_status_with_challenge_header_or_message_still_stops(self):
        for response in (
            httpx.Response(200, headers={"verifyuuid": TOKEN}, json=envelope({"items": []})),
            httpx.Response(200, json={"success": False, "code": 0, "msg": "安全验证 " + TOKEN}),
        ):
            with self.subTest(header=bool(response.headers.get("verifyuuid"))):
                self.requests.clear()
                client = self.client([identity_response(), response])
                client.identity(self.marker)
                with self.assertRaisesRegex(protocol.ProtocolError, "^CHALLENGE_REQUIRED$"):
                    client.search(QUERY, NOTE_ID)
                self.assertNotIn(TOKEN, json.dumps(client.protocol.events))
                self.assert_stopped(client, 2)

    def test_native_detail_and_direct_requests_transport_are_forbidden(self):
        for operation in ("detail", "request", "send"):
            with self.subTest(operation=operation):
                self.requests.clear()
                client = self.client([identity_response()])
                client.identity(self.marker)
                with self.assertRaises(protocol.ProtocolError):
                    if operation == "detail":
                        client.sdk.get_note_by_id(NOTE_ID, TOKEN)
                    elif operation == "request":
                        client.sdk.session.request("GET", protocol.API_ORIGIN + protocol.IDENTITY_PATH)
                    else:
                        client.sdk.session.send(object())
                self.assert_stopped(client, 1)

    def test_altered_sdk_host_is_rejected_before_http(self):
        client = self.client([identity_response()])
        client.identity(self.marker)
        client.sdk._host = "https://synthetic-foreign.example"
        with self.assertRaisesRegex(protocol.ProtocolError, "^SDK_OPERATION_NOT_ALLOWED$"):
            client.search(QUERY, NOTE_ID)
        self.assert_stopped(client, 1)

    def test_payload_changed_by_signer_cannot_replace_sdk_serialized_bytes(self):
        client = self.client([identity_response()])
        client.identity(self.marker)

        def mutate(method, _path, payload):
            if method == "POST":
                payload["keyword"] = "synthetic unauthorized replacement"

        self.signer.on_sign = mutate
        with self.assertRaisesRegex(protocol.ProtocolError, "^SDK_BODY_MISMATCH$"):
            client.search(QUERY, NOTE_ID)
        self.assert_stopped(client, 1)

    def test_user_agent_and_signature_header_tampering_never_reaches_http(self):
        class TamperingHeaders(dict):
            def update(self, *args, **kwargs):
                super().update(*args, **kwargs)
                self["x-s"] = "synthetic tampered signature"

        for field, reason in (
            ("user_agent", "SDK_UA_MISMATCH"),
            ("user_agent_header", "SDK_UA_MISMATCH"),
            ("signature_header", "SDK_SIGNATURE_HEADERS_MISMATCH"),
        ):
            with self.subTest(field=field):
                self.requests.clear()
                client = self.client([identity_response()])
                client.identity(self.marker)
                if field == "user_agent":
                    client.sdk.user_agent = "synthetic tampered agent"
                elif field == "user_agent_header":
                    client.sdk.session.headers["user-agent"] = "synthetic tampered agent"
                else:
                    client.sdk.session.headers = TamperingHeaders(client.sdk.session.headers)
                with self.assertRaisesRegex(protocol.ProtocolError, f"^{reason}$"):
                    client.search(QUERY, NOTE_ID)
                self.assert_stopped(client, 1)

    def test_run_report_and_summary_omit_private_payload_and_require_exact_target(self):
        for target_present in (True, False):
            with self.subTest(target_present=target_present), tempfile.TemporaryDirectory() as temporary:
                self.requests.clear()
                response = search_response() if target_present else httpx.Response(200, json=envelope({
                    "items": [{"id": NOTE_ID + "-extra", "note_card": {"desc": BODY_TEXT}, "xsec_token": TOKEN}],
                }))
                client = self.client([identity_response(), response])

                def directory(name, *, create=False):
                    path = Path(temporary) / name
                    if create:
                        path.mkdir(mode=0o700, parents=True, exist_ok=True)
                    return path

                with patch.object(runner, "private_directory", side_effect=directory), \
                     patch.object(runner, "ExperimentLock", return_value=nullcontext()), \
                     patch.object(runner, "read_binding", return_value=self.marker), \
                     patch.object(runner, "reserve_daily_attempt", return_value=1), \
                     patch.object(runner, "ReajasonSearchClient", return_value=client), \
                     redirect_stdout(io.StringIO()) as output:
                    code, report_path = runner.run(self.account, POLICY, NOTE_ID, QUERY)
                text = report_path.read_text()
                report = json.loads(text)
                self.assertEqual(code, 0)
                self.assertEqual(report["result"], "SDK_SEARCH_SUCCEEDED")
                self.assertIs(report["target_found"], target_present)
                self.assertIs(report["detail_requested"], False)
                self.assertIs(report["capture_written"], False)
                self.assertEqual(report["items_count"], 3 if target_present else 1)
                self.assertEqual(report["note_cards_count"], 2 if target_present else 1)
                self.assertEqual(report_path.stat().st_mode & 0o777, 0o600)
                for secret in (COOKIE, USER_ID, QUERY, NOTE_ID, TOKEN, BODY_TEXT,
                               "synthetic-sdk-signature", "synthetic-sdk-common", *COOKIES.values()):
                    self.assertNotIn(secret, text + output.getvalue())
                self.assertEqual(len(self.requests), 2)
                self.assertEqual(client.sdk.cookie_dict, {})
                self.assertEqual(client.account["cookie"], "")

    def test_real_local_signer_handles_native_get_and_post_with_synthetic_cookies(self):
        mac = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")
        windows = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
        for name, user_agent in (("default", ""), ("macOS", mac), ("Windows", windows)):
            with self.subTest(platform=name):
                self.requests.clear()
                signer = protocol.LocalSigner(user_agent)
                client = self.client([identity_response(), search_response()], signer=signer)
                client.identity(self.marker)
                self.assertIs(client.search(QUERY, NOTE_ID)["target_found"], True)
                self.assertEqual(len(self.requests), 2)
                for request in self.requests:
                    self.assertTrue(request.headers["x-s"].startswith("XYS_"))
                    self.assertTrue(request.headers["x-s-common"])
                    self.assertEqual(request.headers["user-agent"], signer.user_agent)
                    self.assertEqual(request.headers["cookie"], COOKIE)
                self.assertTrue(self.requests[1].headers["x-rap-param"])


if __name__ == "__main__":
    unittest.main()
