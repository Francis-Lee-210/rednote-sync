"""No-network capability checks: fixed endpoints, bound identity, safe reporting."""
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import common
import capability_probe as probe
import protocol_experiment as runner
import protocol_session as protocol

USER = "a" * 24
DIGEST = hashlib.sha256(USER.encode()).hexdigest()
COOKIE = "a1=" + "a" * 52 + "; web_session=synthetic-capability-session=="
ACCOUNT = {"account_id": "test_f", "source": "self_registered", "cookie": COOKIE}
POLICY = {**common.REQUEST_POLICY_DEFAULTS, "min_delay_seconds": 0, "max_delay_seconds": 0}
MARKER = {"identity_sha256": DIGEST}


def response(data, **kwargs):
    return httpx.Response(200, json={"success": True, "code": 0, "data": data}, **kwargs)


def identity(**kwargs):
    return response({"guest": False, "user_id": USER, **kwargs})


def profile():
    return response({"basic_info": {"nickname": "private-synthetic-name"}})


def posted(notes=None):
    if notes is None:
        notes = [{"note_id": "private-synthetic-note", "display_title": "private-title",
                  "xsec_token": "private-token", "type": "normal"}]
    return response({"notes": notes, "cursor": "private-cursor", "has_more": False})


class FakeSigner:
    user_agent = "synthetic-user-agent"

    def __init__(self):
        self.calls = []

    def headers(self, method, path, cookies, payload):
        self.calls.append((method, path, dict(cookies), payload))
        return {"x-s": "private-synthetic-signature", "x-t": "1", "x-s-common": "synthetic-common"}


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.signer = FakeSigner()
        for target, attr in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                             (socket, "getaddrinfo")):
            guard = patch.object(target, attr, side_effect=AssertionError("network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def transport(self, responses):
        pending = iter(responses)

        def handler(request):
            self.sent.append(request)
            return next(pending)

        return httpx.MockTransport(handler)

    def client(self, responses):
        client = probe.CapabilitySession(ACCOUNT, POLICY, transport=self.transport(responses), signer=self.signer)
        self.addCleanup(client.close)
        return client

    def test_three_fixed_gets_keep_cookie_and_sign_exact_query(self):
        client = self.client([
            response({"guest": False, "user_id": USER}, headers={"set-cookie": "web_session=changed; Path=/"}),
            profile(), posted(),
        ])
        self.assertEqual(client.identity(MARKER), DIGEST)
        self.assertFalse(client.profile()["field_schema_verified"])
        self.assertEqual(client.posted()["item_count"], 1)
        paths = [protocol.IDENTITY_PATH, *probe.own_paths(USER)]
        self.assertEqual([(req.method, str(req.url)) for req in self.sent],
                         [("GET", protocol.API_ORIGIN + path) for path in paths])
        self.assertEqual([call[1] for call in self.signer.calls], paths)
        self.assertTrue(all(req.headers["cookie"] == COOKIE and req.content == b"" for req in self.sent))
        safe = json.dumps(client.events)
        for secret in (USER, COOKIE, "private-cursor", "private-token", "private-title", "private-synthetic-name"):
            self.assertNotIn(secret, safe)
        self.assertNotIn("?", safe)
        with self.assertRaises(protocol.ProtocolError):
            client.posted()
        self.assertEqual(len(self.sent), 3)

    def test_binding_required_before_first_request(self):
        client = self.client([])
        with self.assertRaisesRegex(protocol.ProtocolError, "EXISTING_BINDING_REQUIRED"):
            client.identity()
        self.assertEqual(self.sent, [])

    def test_wrong_identity_stops_before_profile(self):
        client = self.client([identity()])
        with self.assertRaisesRegex(protocol.ProtocolError, "IDENTITY_MISMATCH"):
            client.identity({"identity_sha256": "0" * 64})
        with self.assertRaises(protocol.ProtocolError):
            client.profile()
        self.assertEqual(len(self.sent), 1)

    def test_guest_and_expired_identity_cannot_continue(self):
        for payload in (identity(guest=True), httpx.Response(200, json={"success": False, "code": -100})):
            self.sent.clear()
            client = self.client([payload])
            with self.assertRaises(protocol.ProtocolError):
                client.identity(MARKER)
            with self.assertRaises(protocol.ProtocolError):
                client.profile()
            self.assertEqual(len(self.sent), 1)

    def test_bad_identity_cannot_be_used_as_query(self):
        for value in ("a&user_id=other", "", "a" * 25):
            with self.subTest(value=value), self.assertRaises(protocol.ProtocolError):
                probe.own_paths(value)

    def test_out_of_order_and_cross_account_requests_are_blocked(self):
        for operation in (lambda c: c.profile(), lambda c: c.posted()):
            client = self.client([])
            with self.assertRaises(protocol.ProtocolError):
                operation(client)
        self.assertEqual(self.sent, [])
        client = self.client([identity()])
        client.identity(MARKER)
        with self.assertRaises(protocol.ProtocolError):
            client._request("GET", probe.own_paths("b" * 24)[0])
        self.assertEqual(len(self.sent), 1)

    def test_search_and_write_operations_are_never_allowed(self):
        for method, path in (("POST", protocol.SEARCH_PATH), ("POST", protocol.DETAIL_PATH),
                             ("POST", "/api/sns/web/v1/note/like"),
                             ("GET", "https://other.example/private")):
            self.sent.clear()
            client = self.client([identity()])
            client.identity(MARKER)
            with self.assertRaises(protocol.ProtocolError):
                client._request(method, path)
            self.assertEqual(len(self.sent), 1)

    def test_default_protocol_gate_remains_unchanged(self):
        client = protocol.ProtocolSession(ACCOUNT, POLICY, transport=self.transport([]), signer=self.signer)
        self.addCleanup(client.close)
        with self.assertRaises(protocol.ProtocolError):
            client._request("GET", probe.own_paths(USER)[0])
        self.assertEqual(self.sent, [])
        signer = protocol.LocalSigner()
        with self.assertRaisesRegex(protocol.ProtocolError, "REQUEST_NOT_ALLOWED"):
            signer.headers("GET", probe.own_paths(USER)[0], protocol.cookie_fields(COOKIE), None)

    def test_risk_or_redirect_stops_whole_probe_without_later_calls(self):
        for status in (301, 401, 403, 406, 429, 461, 471, 500):
            for index in range(3):
                with self.subTest(status=status, index=index):
                    self.sent.clear()
                    responses = [identity(), profile(), posted()]
                    responses[index] = httpx.Response(status, json={"success": True, "code": 0},
                        headers={"verifytype": "private-type", "verifyuuid": "private-uuid"})
                    client = self.client(responses)
                    with self.assertRaises(protocol.ProtocolError):
                        client.identity(MARKER)
                        client.profile()
                        client.posted()
                    with self.assertRaises(protocol.ProtocolError):
                        client.posted()
                    self.assertEqual(len(self.sent), index + 1)
                    safe = json.dumps(client.events)
                    self.assertNotIn("private-type", safe)
                    self.assertNotIn("private-uuid", safe)

    def test_200_with_verification_header_is_not_success(self):
        client = self.client([identity(), response({"profile": True}, headers={"verifytype": ""})])
        client.identity(MARKER)
        with self.assertRaisesRegex(protocol.ProtocolError, "CHALLENGE_REQUIRED"):
            client.profile()
        with self.assertRaises(protocol.ProtocolError):
            client.posted()
        self.assertEqual(len(self.sent), 2)

    def test_empty_profile_stops_before_list(self):
        client = self.client([identity(), response({})])
        client.identity(MARKER)
        with self.assertRaisesRegex(protocol.ProtocolError, "PROFILE_EMPTY_RESPONSE"):
            client.profile()
        with self.assertRaises(protocol.ProtocolError):
            client.posted()
        self.assertEqual(len(self.sent), 2)

    def test_empty_posted_list_is_valid_but_bad_shapes_are_not(self):
        for value, valid in (({"notes": [], "cursor": "", "has_more": False}, True),
                             ({"notes": [], "cursor": "", "has_more": 0}, False),
                             ({"notes": [{}], "cursor": "", "has_more": False}, False),
                             ({"notes": [{"note_id": "", "type": "normal"}], "cursor": "", "has_more": False}, False),
                             ({"notes": [{}] * 31, "cursor": "", "has_more": True}, False),
                             ({"notes": "not-list", "cursor": "", "has_more": False}, False)):
            self.sent.clear()
            client = self.client([identity(), profile(), response(value)])
            client.identity(MARKER)
            client.profile()
            if valid:
                self.assertTrue(client.posted()["empty"])
            else:
                with self.assertRaisesRegex(protocol.ProtocolError, "POSTED_SCHEMA_UNCONFIRMED"):
                    client.posted()

    def test_signer_only_accepts_canonical_shapes_and_signs_offline(self):
        signer = probe.CapabilitySigner()
        for path in probe.own_paths(USER):
            self.assertTrue(signer.headers("GET", path, protocol.cookie_fields(COOKIE), None).get("x-s"))
            for bad in (path + "&extra=1", path + "#fragment", "https://other.example" + path,
                        path + "&user_id=" + USER):
                with self.assertRaisesRegex(protocol.ProtocolError, "REQUEST_NOT_ALLOWED"):
                    signer.headers("GET", bad, protocol.cookie_fields(COOKIE), None)

    def test_other_accounts_are_not_authorized(self):
        with self.assertRaisesRegex(protocol.ProtocolError, "CAPABILITY_ACCOUNT_NOT_AUTHORIZED"):
            probe.CapabilitySession({**ACCOUNT, "account_id": "test_g"}, POLICY, signer=self.signer)

    def test_runner_saves_only_metadata_and_uses_both_shared_budgets(self):
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()) as output:
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(probe, "read_binding", return_value=MARKER), \
                 patch.object(probe, "reserve_daily_attempt", return_value=1) as reserve:
                code, report_path = probe.run_probe(ACCOUNT, POLICY,
                    transport=self.transport([identity(), profile(), posted()]), signer=self.signer)
                report = json.loads(report_path.read_text())
                self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
            self.assertEqual(code, 0)
            self.assertEqual([call.args[1] for call in reserve.call_args_list], ["login", "capture"])
            self.assertEqual(report["result"], "CAPABILITY_PROBE_COMPLETE")
            self.assertTrue(report["identity_verified"])
            combined = json.dumps(report) + output.getvalue()
            for secret in (USER, COOKIE, "private-token", "private-title", "private-synthetic-name", "private-cursor"):
                self.assertNotIn(secret, combined)

    def test_dry_run_and_execute_yes_gate_never_call_runner(self):
        with patch.object(probe, "load_accounts_file", return_value=[ACCOUNT]), \
             patch.object(probe, "read_binding", return_value=MARKER), \
             patch.object(probe, "run_probe") as run, redirect_stdout(io.StringIO()):
            with patch.object(sys, "argv", ["probe", "--account-id", "test_f"]):
                self.assertEqual(probe.main(), 0)
            with patch.object(sys, "argv", ["probe", "--account-id", "test_f", "--execute"]):
                self.assertEqual(probe.main(), 2)
            run.assert_not_called()

    def test_failed_profile_is_attempted_and_posted_remains_unrequested(self):
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()):
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(probe, "read_binding", return_value=MARKER), \
                 patch.object(probe, "reserve_daily_attempt", return_value=1):
                code, path = probe.run_probe(ACCOUNT, POLICY, signer=self.signer, transport=self.transport([
                    identity(), httpx.Response(461, json={"code": 0}, headers={"verifyuuid": "private-challenge"}),
                ]))
                report = json.loads(path.read_text())
            self.assertEqual(code, 1)
            self.assertEqual(len(self.sent), 2)
            self.assertEqual(report["profile"], {"result": "HTTP_RISK_STOP", "attempted": True})
            self.assertEqual(report["posted"]["result"], "NOT_REQUESTED")
            self.assertNotIn("private-challenge", json.dumps(report))

    def test_content_budget_denial_stops_after_identity(self):
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()):
            with patch.object(common, "DATA_DIR", Path(temp)), patch.object(runner, "DATA_DIR", Path(temp)), \
                 patch.object(probe, "read_binding", return_value=MARKER), \
                 patch.object(probe, "reserve_daily_attempt", side_effect=[
                     1, common.AttemptLimitReached("capture", "synthetic limit")]):
                code, path = probe.run_probe(ACCOUNT, POLICY, signer=self.signer,
                                             transport=self.transport([identity()]))
                report = json.loads(path.read_text())
            self.assertEqual(code, 1)
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(report["result"], "DAILY_CAPTURE_LIMIT_REACHED")
            self.assertEqual(report["profile"]["result"], "NOT_REQUESTED")


if __name__ == "__main__":
    unittest.main()
