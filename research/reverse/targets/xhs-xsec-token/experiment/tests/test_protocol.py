from __future__ import annotations

import hashlib
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
import run_experiment

COOKIE = "a1=" + "a" * 52 + "; web_session=synthetic-session==; other=keep-me"
USER_ID = "synthetic-user"
DIGEST = hashlib.sha256(USER_ID.encode()).hexdigest()
POLICY = {**common.REQUEST_POLICY_DEFAULTS, "min_delay_seconds": 0, "max_delay_seconds": 0}


def envelope(data):
    return {"success": True, "code": 0, "data": data}


def identity_data():
    return {"guest": False, "user_id": USER_ID}


class FakeSigner:
    user_agent = "synthetic-agent"

    def __init__(self):
        self.signed = []

    def headers(self, method, path, cookies, payload):
        self.signed.append((method, path, cookies, payload))
        return {"x-s": "synthetic-signature", "x-t": "1", "x-s-common": "synthetic-common"}


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.account = {"account_id": "test_d", "source": "self_registered", "cookie": COOKIE}
        self.signer = FakeSigner()
        self.requests = []
        self.sleeper = patch.object(protocol.time, "sleep")
        self.sleeper.start()
        self.addCleanup(self.sleeper.stop)

    def client(self, responses):
        def handler(request):
            self.requests.append(request)
            response = responses[len(self.requests) - 1]
            if isinstance(response, Exception):
                raise response
            return response
        client = protocol.ProtocolSession(
            self.account, POLICY, transport=httpx.MockTransport(handler), signer=self.signer
        )
        self.addCleanup(client.close)
        return client

    def test_exact_cookie_header_and_account_bound_identity(self):
        client = self.client([httpx.Response(200, json=envelope(identity_data()))])
        self.assertEqual(client.identity(), DIGEST)
        request = self.requests[0]
        self.assertEqual(str(request.url), protocol.API_ORIGIN + protocol.IDENTITY_PATH)
        self.assertEqual(request.headers["cookie"], COOKIE)
        self.assertEqual(self.signer.signed[0][2]["web_session"], "synthetic-session==")
        self.assertIn("x-s", request.headers)

    def test_expired_guest_and_ambiguous_identity_cannot_search(self):
        cases = [
            {"success": False, "code": -100},
            envelope({"guest": True, "user_id": USER_ID}),
            envelope({"user_id": USER_ID}),
            envelope({"guest": 0, "user_id": USER_ID}),
            envelope({"guest": False, "user_id": ""}),
            envelope({"guest": False, "user_id": USER_ID, "userId": "other-user"}),
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                self.requests.clear()
                client = self.client([httpx.Response(200, json=payload)])
                with self.assertRaises(protocol.ProtocolError):
                    client.identity()
                with self.assertRaises(protocol.ProtocolError):
                    client.search("synthetic query")
                self.assertEqual(len(self.requests), 1)

    def test_http_stops_do_not_retry_redirect_or_fallback(self):
        for status_code in (301, 302, 401, 403, 406, 429, 461, 471, 500):
            with self.subTest(status_code=status_code):
                self.requests.clear()
                client = self.client([httpx.Response(
                    status_code, headers={"location": "https://foreign.example/private"},
                    json=envelope(identity_data()),
                )])
                with self.assertRaises(protocol.ProtocolError):
                    client.identity()
                with self.assertRaises(protocol.ProtocolError):
                    client.search("query")
                self.assertEqual(len(self.requests), 1)

    def test_bad_bodies_and_verification_headers_never_prove_identity(self):
        responses = [
            httpx.Response(200, text="private error body"),
            httpx.Response(200, headers={"content-type": "application/json"}, content=b"{"),
            httpx.Response(200, json={"success": True, "code": False, "data": identity_data()}),
            httpx.Response(200, json={"success": "true", "data": identity_data()}),
            httpx.Response(200, json=envelope(identity_data()), headers={"verifytype": "slider"}),
            httpx.Response(200, json={"success": False, "msg": "需要安全验证"}),
        ]
        for response in responses:
            self.requests.clear()
            with self.subTest(response=response.status_code):
                client = self.client([response])
                with self.assertRaises(protocol.ProtocolError) as error:
                    client.identity()
                self.assertNotIn("private", str(error.exception))

    def test_unsigned_or_arbitrary_operations_never_reach_transport(self):
        client = self.client([])
        for method, path in [
            ("POST", "/api/sns/web/v1/note/like"), ("GET", "https://foreign.example/"),
        ]:
            with self.assertRaises(protocol.ProtocolError):
                client._request(method, path)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.signer.signed, [])

    def test_full_path_uses_exact_search_material_and_discards_set_cookie(self):
        target = {"id": "note123", "xsec_token": "target-secret", "note_card": {}}
        client = self.client([
            httpx.Response(200, json=envelope(identity_data()), headers={"set-cookie": "web_session=replaced; Path=/"}),
            httpx.Response(200, json=envelope({"items": [
                {"id": "other", "xsec_token": "unrelated-secret"}, target,
            ]})),
            httpx.Response(200, json=envelope({"items": [{"id": "note123", "note_card": {
                "note_id": "note123", "type": "normal", "desc": "synthetic detail",
            }}]})),
        ])
        self.assertEqual(client.identity(), DIGEST)
        material = protocol.access_material(client.search("中文 search"), "note123")
        self.assertEqual(material["source_origin"], "search_context")
        self.assertEqual(material["xsec_source"], "pc_search")
        protocol.require_detail(client.detail(material), "note123")
        self.assertEqual(len(self.requests), 3)
        self.assertTrue(all(request.headers["cookie"] == COOKIE for request in self.requests))
        for index in (1, 2):
            payload = self.signer.signed[index][3]
            self.assertEqual(self.requests[index].content, json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode())
        self.assertNotIn("unrelated-secret", self.requests[-1].content.decode())
        with self.assertRaises(protocol.ProtocolError):
            client.detail(material)

    def test_response_size_limit_is_enforced(self):
        client = self.client([httpx.Response(200, json=envelope(identity_data()))])
        with patch.object(protocol, "MAX_RESPONSE_BYTES", 4):
            with self.assertRaisesRegex(protocol.ProtocolError, "RESPONSE_TOO_LARGE"):
                client.identity()

    def test_search_rejects_wrong_ids_conflicts_and_missing_token(self):
        for items in (
            [{"id": "other", "xsec_token": "token"}],
            [{"id": "note123"}],
            [{"id": "note123", "xsec_token": "token", "note_card": {"note_id": "other"}}],
            [{"id": "note123", "xsec_token": "one", "xsecToken": "two"}],
        ):
            with self.subTest(items=items), self.assertRaises(protocol.ProtocolError):
                protocol.access_material({"items": items}, "note123")

    def test_detail_rejects_empty_cards_search_card_shape_and_wrong_id(self):
        for card in (
            {"note_id": "other", "type": "normal", "desc": "content"},
            {"note_id": "note123", "type": "normal"},
            {"note_id": "note123", "type": "normal", "title": "search title"},
            {"note_id": "note123", "type": "normal", "image_list": "invalid"},
        ):
            with self.subTest(card=card), self.assertRaises(protocol.ProtocolError):
                protocol.require_detail({"items": [{"note_card": card}]}, "note123")

    def test_local_signer_works_offline_with_synthetic_material(self):
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")):
            signer = protocol.LocalSigner()
            headers = signer.headers("GET", protocol.IDENTITY_PATH, protocol.cookie_fields(COOKIE), None)
            post_headers = signer.headers("POST", protocol.SEARCH_PATH, protocol.cookie_fields(COOKIE), {
                "keyword": "中文 synthetic", "page": 1,
            })
        self.assertTrue(all(headers.get(name) for name in ("x-s", "x-t", "x-s-common")))
        self.assertTrue(post_headers.get("x-rap-param"))

    def test_cookie_preflight_rejects_partial_or_malformed_input(self):
        for header in ("web_session=value", "a1=value", "Cookie: a1=x", "a1=x; a1=y", "a1=x; web_session=x\r"):
            with self.subTest(header=header), self.assertRaises(common.ConfigError):
                protocol.cookie_fields(header)

    def test_run_reports_only_safe_metadata_and_separate_protocol_binding(self):
        client = self.client([httpx.Response(200, json=envelope(identity_data()))])
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()) as output:
                code, report_path = runner.run_protocol(self.account, POLICY, bind_identity=True)
                self.assertEqual(code, 0)
                binding = runner.read_binding("test_d")
            report = json.loads(report_path.read_text())
            self.assertEqual(report["result"], "PROTOCOL_IDENTITY_VERIFIED")
            self.assertFalse(report["browser_login_verified"])
            self.assertEqual(binding["identity_sha256"], DIGEST)
            self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
            all_text = output.getvalue() + report_path.read_text()
            for private in (USER_ID, COOKIE, "synthetic-signature", "synthetic-session"):
                self.assertNotIn(private, all_text)
            self.assertFalse((Path(temp) / "profiles").exists())

    def test_mismatch_never_searches_or_overwrites_existing_binding(self):
        client = self.client([httpx.Response(200, json=envelope(identity_data()))])
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()):
                original = {"method": runner.METHOD, "account_id": "test_d", "identity_sha256": "b" * 64, "validated_at": common.utc_now()}
                runner.private_directory("protocol-identities", create=True)
                common.write_json_private(runner.binding_path("test_d"), original)
                code, report_path = runner.run_protocol(self.account, POLICY, bind_identity=False, note_id="note123", query="keyword")
                self.assertEqual(code, 1)
                self.assertEqual(runner.read_binding("test_d"), original)
            self.assertEqual(json.loads(report_path.read_text())["result"], "IDENTITY_MISMATCH")
            self.assertEqual(len(self.requests), 1)
            self.assertFalse((Path(temp) / "captures").exists())

    def test_full_run_stores_only_target_access_material(self):
        client = self.client([
            httpx.Response(200, json=envelope(identity_data())),
            httpx.Response(200, json=envelope({"items": [
                {"id": "other", "xsec_token": "foreign-secret"},
                {"id": "note123", "xsec_token": "target-secret", "xsec_source": "pc_search"},
            ]})),
            httpx.Response(200, json=envelope({"items": [{"note_card": {
                "note_id": "note123", "type": "normal", "desc": "private body",
            }}]})),
        ])
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()) as output:
                code, report_path = runner.run_protocol(
                    self.account, POLICY, bind_identity=True, note_id="note123", query="private keyword"
                )
            self.assertEqual(code, 0)
            report = json.loads(report_path.read_text())
            self.assertEqual(report["result"], "PROTOCOL_COMPLETE")
            capture = Path(temp) / report["capture"]
            self.assertEqual(stat.S_IMODE(capture.stat().st_mode), 0o600)
            records = [json.loads(line) for line in capture.read_text().splitlines()]
            self.assertEqual(records[0]["payload"]["source_origin"], "response")
            self.assertEqual(records[0]["payload"]["xsec_token"], "target-secret")
            captured_text = output.getvalue() + report_path.read_text() + capture.read_text()
            for secret in ("foreign-secret", "private keyword", "private body", COOKIE, USER_ID):
                self.assertNotIn(secret, captured_text)
            self.assertNotIn("target-secret", output.getvalue() + report_path.read_text())

    def test_binding_rejects_cross_account_and_symlink(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runner, "DATA_DIR", Path(temp)):
            runner.private_directory("protocol-identities", create=True)
            path = runner.binding_path("test_d")
            common.write_json_private(path, {
                "method": runner.METHOD, "account_id": "test_b", "identity_sha256": DIGEST,
                "validated_at": common.utc_now(),
            })
            with self.assertRaises(protocol.ProtocolError):
                runner.read_binding("test_d")
            alias = runner.binding_path("test_a")
            alias.symlink_to(path)
            with self.assertRaises(protocol.ProtocolError):
                runner.read_binding("test_a")

    def test_routes_share_login_attempt_budget(self):
        client = self.client([])
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(runner, "ProtocolSession", return_value=client), redirect_stdout(io.StringIO()):
                for _ in range(3):
                    common.reserve_daily_attempt("test_d", "login", 3)
                code, _ = runner.run_protocol(self.account, POLICY, bind_identity=True)
        self.assertEqual(code, 1)
        self.assertEqual(self.requests, [])

    def test_dry_run_does_not_open_browser_write_or_request(self):
        with tempfile.TemporaryDirectory() as temp:
            accounts_path = Path(temp) / "accounts.json"
            accounts_path.write_text(json.dumps({"accounts": [self.account]}))
            accounts_path.chmod(0o600)
            runtime = Path(temp) / "runtime"
            argv = ["protocol_experiment.py", "--accounts-file", str(accounts_path), "--account-id", "test_d", "--bind-identity"]
            with patch.object(sys, "argv", argv), patch.object(runner, "DATA_DIR", runtime), \
                 patch.object(runner, "run_protocol", side_effect=AssertionError("must not run")), redirect_stdout(io.StringIO()):
                self.assertEqual(runner.main(), 0)
            self.assertFalse(runtime.exists())

    def test_default_entrypoint_is_protocol_identity_only(self):
        argv = ["run_experiment.py", "--account-id", "test_d", "--bind-identity"]
        with patch.object(sys, "argv", argv), patch.object(run_experiment, "run_step", return_value=0) as step:
            self.assertEqual(run_experiment.main(), 0)
        command = step.call_args.args[1]
        self.assertTrue(command[2].endswith("protocol_experiment.py"))
        self.assertNotIn("--execute", command)
        self.assertNotIn("--note-id", command)

    def test_protocol_failure_does_not_launch_browser(self):
        argv = ["run_experiment.py", "--account-id", "test_d", "--execute", "--yes"]
        with patch.object(sys, "argv", argv), patch.object(run_experiment, "run_step", return_value=1) as step:
            self.assertEqual(run_experiment.main(), 1)
        self.assertEqual(step.call_count, 1)


if __name__ == "__main__":
    unittest.main()
