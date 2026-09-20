from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402
import login_profile  # noqa: E402
import run_experiment  # noqa: E402
import session  # noqa: E402
from capture_visit import (  # noqa: E402
    access_material_for_note,
    allowed_note_url,
    detail_verdict,
)
from session import identity_digest, parse_user_me, validate_profile_session  # noqa: E402


class FakeResponse:
    def __init__(
        self,
        status: int,
        payload: object,
        url: str = "https://www.xiaohongshu.com/api/sns/web/v2/user/me",
        content_type: str = "application/json",
        method: str = "GET",
        resource_type: str = "xhr",
        request_headers: dict[str, str] | None = None,
    ):
        self.status = status
        self._payload = payload
        self.url = url
        self.headers = {"content-type": content_type}
        self.request = SimpleNamespace(
            method=method,
            resource_type=resource_type,
            headers=request_headers or {"x-s": "synthetic", "x-t": "1"},
        )

    def json(self) -> object:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeRequest:
    def __init__(self, response: FakeResponse):
        self._response = response

    def get(self, _url: str, timeout: int) -> FakeResponse:
        self.timeout = timeout
        return self._response


class FakeContext:
    def __init__(
        self,
        response: FakeResponse,
        extra_responses: list[FakeResponse] | None = None,
        visible_challenge: bool | list[bool] = False,
        visible_login_prompt: bool = False,
    ):
        self.request = FakeRequest(response)
        self._response = response
        self._extra_responses = extra_responses or []
        self._visible_challenge = visible_challenge
        self._visible_login_prompt = visible_login_prompt

    def new_page(self) -> "SignedResponsePage":
        return SignedResponsePage(
            self._response,
            extra_responses=self._extra_responses,
            visible_challenge=self._visible_challenge,
            visible_login_prompt=self._visible_login_prompt,
        )


class SignedResponsePage:
    def __init__(
        self,
        response: FakeResponse,
        extra_responses: list[FakeResponse] | None = None,
        visible_challenge: bool | list[bool] = False,
        visible_login_prompt: bool = False,
    ):
        self._response = response
        self._extra_responses = extra_responses or []
        self._visible_challenge = (
            list(visible_challenge)
            if isinstance(visible_challenge, list)
            else visible_challenge
        )
        self._callback = None
        self._visible_login_prompt = visible_login_prompt

    def on(self, event: str, callback: object) -> None:
        if event == "response":
            self._callback = callback

    def goto(self, url: str, **_kwargs: object) -> FakeResponse:
        if self._callback is not None:
            self._callback(self._response)
            for response in self._extra_responses:
                self._callback(response)
        return FakeResponse(200, {}, url=url)

    def wait_for_timeout(self, _timeout: int) -> None:
        return None

    def evaluate(self, _script: str) -> bool:
        if _script == session.VISIBLE_LOGIN_PROMPT_PROBE:
            return self._visible_login_prompt
        if isinstance(self._visible_challenge, list):
            if len(self._visible_challenge) > 1:
                return self._visible_challenge.pop(0)
            return self._visible_challenge[0]
        return self._visible_challenge

    def close(self) -> None:
        return None


class SequencingPage:
    def __init__(self, events: list[str]):
        self.events = events

    def goto(self, _url: str, **_kwargs: object) -> None:
        self.events.append("anonymous_home")


class ExistingPage:
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.closed = False

    def goto(self, url: str, **_kwargs: object) -> None:
        self.urls.append(url)

    def close(self) -> None:
        self.closed = True


class SequencingContext:
    def __init__(self):
        self.events: list[str] = []

    def clear_cookies(self) -> None:
        self.events.append("clear")

    def new_page(self) -> SequencingPage:
        self.events.append("new_page")
        return SequencingPage(self.events)

    def add_cookies(self, _cookies: object) -> None:
        self.events.append("add_account_cookies")


class CommonTests(unittest.TestCase):
    def test_capture_url_keeps_only_access_material(self) -> None:
        value = common.sanitize_capture_url(
            "https://www.xiaohongshu.com/explore/note123?keyword=private&"
            "xsec_token=tok&xsec_source=pc_search&extra=value#fragment",
            target_note_id="note123",
        )
        self.assertIn("keyword=%3Credacted%3E", value)
        self.assertIn("xsec_token=tok", value)
        self.assertIn("xsec_source=pc_search", value)
        self.assertIn("extra=%3Credacted%3E", value)
        self.assertNotIn("private", value)
        self.assertNotIn("#fragment", value)

    def test_capture_url_redacts_other_notes_access_material(self) -> None:
        value = common.sanitize_capture_url(
            "https://www.xiaohongshu.com/explore/other?"
            "xsec_token=other-secret&xsec_source=pc_search",
            target_note_id="note123",
        )
        self.assertNotIn("other-secret", value)
        self.assertNotIn("pc_search", value)
        self.assertNotIn("/explore/other", value)

    def test_capture_url_redacts_unapproved_dynamic_paths_and_userinfo(self) -> None:
        value = common.sanitize_capture_url(
            "https://private-user:password@www.xiaohongshu.com/user/private-user-id?key=value",
            target_note_id="note123",
        )
        self.assertNotIn("private-user", value)
        self.assertNotIn("password", value)
        self.assertNotIn("private-user-id", value)
        self.assertIn("/<redacted>", value)

    def test_sensitive_headers_are_redacted(self) -> None:
        sanitized = common.sanitize_headers(
            {
                "Cookie": "secret",
                "Authorization": "secret",
                "Accept": "application/json",
                "X-Custom-Identity": "private-user",
                "Referer": (
                    "https://www.xiaohongshu.com/explore/other?"
                    "keyword=private&xsec_token=other-secret"
                ),
            },
            target_note_id="note123",
        )
        self.assertEqual(sanitized["Cookie"], "<redacted>")
        self.assertEqual(sanitized["Authorization"], "<redacted>")
        self.assertEqual(sanitized["Accept"], "application/json")
        self.assertEqual(sanitized["X-Custom-Identity"], "<redacted>")
        self.assertNotIn("private", sanitized["Referer"])
        self.assertNotIn("other-secret", sanitized["Referer"])

    def test_cookie_header_uses_exact_request_host_scope(self) -> None:
        cookies = common.parse_cookie_header("synthetic=account")
        self.assertEqual(
            cookies,
            [
                {
                    "name": "synthetic",
                    "value": "account",
                    "url": "https://www.xiaohongshu.com/",
                    "secure": True,
                }
            ],
        )

    def test_cookie_header_rejects_duplicate_names(self) -> None:
        with self.assertRaisesRegex(common.ConfigError, "duplicate name"):
            common.parse_cookie_header("synthetic=first; synthetic=second")

    def test_cookie_header_rejects_malformed_or_prefixed_input(self) -> None:
        for value in ("Cookie: synthetic=value", "synthetic=value; malformed", "=value"):
            with self.subTest(value=value), self.assertRaises(common.ConfigError):
                common.parse_cookie_header(value)

    def test_experiment_lock_rejects_concurrent_operation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(common, "DATA_DIR", Path(directory)):
                with common.ExperimentLock():
                    with self.assertRaisesRegex(common.ConfigError, "already running"):
                        with common.ExperimentLock():
                            self.fail("second lock acquisition unexpectedly succeeded")

    def test_accounts_require_private_file_and_self_registered_source(self) -> None:
        account = {
            "accounts": [
                {
                    "account_id": "test_a",
                    "source": "self_registered",
                    "cookie": "a=b",
                    "profile_dir": str(common.PROFILES_DIR / "unit-test-profile"),
                    "expected_user_id_sha256": "a" * 64,
                }
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.json"
            path.write_text(json.dumps(account), encoding="utf-8")
            path.chmod(0o600)
            loaded = common.load_accounts_file(path)
            self.assertEqual(loaded[0]["account_id"], "test_a")
            path.chmod(0o644)
            with self.assertRaisesRegex(common.ConfigError, "owner-only"):
                common.load_accounts_file(path)

    def test_accounts_cannot_share_a_profile(self) -> None:
        profile = str(common.PROFILES_DIR / "shared-unit-test-profile")
        accounts = {
            "accounts": [
                {"account_id": "a", "source": "self_registered", "cookie": "a=b", "profile_dir": profile},
                {"account_id": "b", "source": "self_registered", "cookie": "c=d", "profile_dir": profile},
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.json"
            path.write_text(json.dumps(accounts), encoding="utf-8")
            path.chmod(0o600)
            with self.assertRaisesRegex(common.ConfigError, "more than one account"):
                common.load_accounts_file(path)

    def test_account_label_is_optional_descriptive_metadata(self) -> None:
        base = {
            "account_id": "test_g",
            "source": "self_registered",
            "cookie": "a=b",
            "profile_dir": str(common.PROFILES_DIR / "unit-test-label-profile"),
            "expected_user_id_sha256": "a" * 64,
        }
        for metadata in ({}, {"label": "小号"}, {"label": "号" * 64}):
            account = {**base, **metadata}
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "accounts.json"
                path.write_text(json.dumps({"accounts": [account]}), encoding="utf-8")
                path.chmod(0o600)
                with patch("builtins.print") as printed:
                    loaded = common.load_accounts_file(path)
                self.assertEqual(loaded, [account])
                self.assertIs(common.find_account(loaded, "test_g"), loaded[0])
                printed.assert_not_called()

    def test_account_label_rejects_non_strings_blank_oversized_and_controls(self) -> None:
        invalid_labels = (
            None, False, 1, [], {}, "", " ", "\u3000", "号" * 65,
            "小\x00号", "小\n号", "小\r号", "小\t号", "小\x7f号", "小\x85号",
        )
        for label in invalid_labels:
            account = {
                "account_id": "test_g", "source": "self_registered", "label": label,
            }
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "accounts.json"
                path.write_text(json.dumps({"accounts": [account]}), encoding="utf-8")
                path.chmod(0o600)
                with self.assertRaisesRegex(common.ConfigError, "label must be"):
                    common.load_accounts_file(path, require_profile=False)

    def test_account_cookie_and_user_agent_reject_controls(self) -> None:
        base = {
            "account_id": "test_a",
            "source": "self_registered",
            "cookie": "a=b",
            "user_agent": "synthetic",
            "profile_dir": str(common.PROFILES_DIR / "unit-test-profile"),
        }
        for field, value in (("cookie", "a=b\nInjected: x"), ("user_agent", "ua\rvalue")):
            account = dict(base)
            account[field] = value
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "accounts.json"
                path.write_text(json.dumps({"accounts": [account]}), encoding="utf-8")
                path.chmod(0o600)
                with self.subTest(field=field), self.assertRaises(common.ConfigError):
                    common.load_accounts_file(path)

    def test_request_policy_rejects_unknown_or_invalid_fields(self) -> None:
        with patch.object(common, "load_policy", return_value={"request_policy": {"unused": 1}}):
            with self.assertRaisesRegex(common.ConfigError, "unsupported"):
                common.load_request_policy()
        with patch.object(
            common,
            "load_policy",
            return_value={"request_policy": {"min_delay_seconds": 2, "max_delay_seconds": 1}},
        ):
            with self.assertRaisesRegex(common.ConfigError, "must be >="):
                common.load_request_policy()


class SessionTests(unittest.TestCase):
    def test_hard_http_stop_signals_override_a_valid_signed_identity(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        for status in (403, 429, 461):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                blocked = FakeResponse(status, {}, url="https://www.xiaohongshu.com/api/sns/web/v1/feed")
                self.assertTrue(session.is_session_risk_response(blocked))
                with self.assertRaisesRegex(common.ConfigError, "hard login/risk response"):
                    validate_profile_session(
                        FakeContext(identity, extra_responses=[blocked]),
                        {"account_id": "test_d", "profile_dir": directory},
                    )

    def test_identity_mismatch_and_expiry_still_stop_without_a_visible_prompt(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory,
                       "expected_user_id_sha256": identity_digest("different-user")}
            with self.assertRaisesRegex(common.ConfigError, "identity does not match"):
                validate_profile_session(FakeContext(identity), account)
            expired = FakeResponse(200, {"success": False, "code": -100})
            with self.assertRaisesRegex(common.ConfigError, "invalid or expired"):
                validate_profile_session(FakeContext(expired), account)

    def test_signed_identity_and_risk_responses_are_classified(self) -> None:
        identity = FakeResponse(200, {})
        captcha = FakeResponse(
            200,
            {},
            url="https://www.xiaohongshu.com/website-login/captcha",
        )
        blocked = FakeResponse(
            461,
            {},
            url="https://www.xiaohongshu.com/api/sns/web/v1/login/activate",
        )
        self.assertTrue(session.is_user_me_response(identity))
        self.assertTrue(session.is_signed_identity_response(identity))
        self.assertFalse(session.is_session_risk_response(identity))
        self.assertFalse(session.is_signed_identity_response(captcha))
        self.assertFalse(session.is_session_risk_response(captcha))
        self.assertTrue(session.is_session_risk_response(blocked))

    def test_identity_and_risk_responses_require_trusted_origin(self) -> None:
        foreign_identity = FakeResponse(
            200,
            {"success": True, "code": 0, "data": {"user_id": "u1"}},
            url="https://evil.example/api/sns/web/v2/user/me",
        )
        foreign_block = FakeResponse(429, {}, url="https://tracker.example/resource")
        self.assertFalse(session.is_signed_identity_response(foreign_identity))
        self.assertFalse(session.is_session_risk_response(foreign_block))

    def test_identity_requires_strict_success_schema(self) -> None:
        invalid_payloads = (
            {"code": 999, "data": {"user_id": "u1"}},
            {"success": "false", "code": 0, "data": {"user_id": "u1"}},
            {"success": True, "code": 1, "data": {"user_id": "u1"}},
            {"success": True, "code": 0, "data": {"guest": 1, "user_id": "u1"}},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(common.ConfigError):
                parse_user_me(FakeResponse(200, payload))

    def test_valid_identity_ignores_preloaded_login_component(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        login_component = FakeResponse(
            200,
            {},
            url="https://www.xiaohongshu.com/website-login/captcha",
        )
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            digest = validate_profile_session(
                FakeContext(identity, extra_responses=[login_component]),
                account,
            )
        self.assertEqual(digest, identity_digest("u1"))

    def test_non_json_trailing_response_does_not_hide_signed_identity(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        trailing = FakeResponse(
            200,
            ValueError("not JSON"),
            content_type="text/html",
        )
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            digest = validate_profile_session(
                FakeContext(identity, extra_responses=[trailing]),
                account,
            )
        self.assertEqual(digest, identity_digest("u1"))

    def test_unreadable_json_trailing_response_does_not_hide_signed_identity(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        trailing = FakeResponse(200, ValueError("synthetic unreadable JSON body"))
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            digest = validate_profile_session(
                FakeContext(identity, extra_responses=[trailing]),
                account,
            )
        self.assertEqual(digest, identity_digest("u1"))

    def test_latest_semantic_identity_state_wins_but_conflicts_fail(self) -> None:
        guest = FakeResponse(200, {"success": True, "code": 0, "data": {"guest": True}})
        valid = FakeResponse(
            200,
            {"success": True, "code": 0, "data": {"guest": False, "user_id": "u1"}},
        )
        other = FakeResponse(
            200,
            {"success": True, "code": 0, "data": {"guest": False, "user_id": "u2"}},
        )
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            self.assertEqual(
                validate_profile_session(FakeContext(guest, extra_responses=[valid]), account),
                identity_digest("u1"),
            )
            with self.assertRaises(common.ConfigError):
                validate_profile_session(FakeContext(valid, extra_responses=[guest]), account)
            with self.assertRaisesRegex(common.ConfigError, "more than one"):
                validate_profile_session(FakeContext(valid, extra_responses=[other]), account)

    def test_visible_challenge_rejects_even_with_valid_identity(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            with self.assertRaisesRegex(common.ConfigError, "visible CAPTCHA"):
                validate_profile_session(
                    FakeContext(identity, visible_challenge=True),
                    account,
                )

    def test_visible_qr_login_prompt_is_not_treated_as_manual_verification(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            with self.assertRaisesRegex(common.ConfigError, "QR/login prompt"):
                validate_profile_session(
                    FakeContext(identity, visible_login_prompt=True),
                    account,
                    manual_challenge_timeout_seconds=300,
                )

    def test_manual_challenge_can_clear_before_identity_is_revalidated(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            digest = validate_profile_session(
                FakeContext(identity, visible_challenge=[True, False, False]),
                account,
                manual_challenge_timeout_seconds=2,
            )
        self.assertEqual(digest, identity_digest("u1"))

    def test_manual_challenge_timeout_still_fails_closed(self) -> None:
        identity = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            account = {"account_id": "test_d", "profile_dir": directory}
            with self.assertRaisesRegex(common.ConfigError, "timed out"):
                validate_profile_session(
                    FakeContext(identity, visible_challenge=True),
                    account,
                    manual_challenge_timeout_seconds=2,
                )

    def test_device_bootstrap_precedes_account_cookie_overlay(self) -> None:
        context = SequencingContext()
        account = {
            "account_id": "test_a",
            "cookie": "web_session=value",
            "profile_dir": "/tmp/profile",
        }

        with patch.object(session, "validate_profile_session", return_value="digest"):
            session.seed_cookie_and_validate(context, account)

        self.assertEqual(
            context.events[:4],
            ["clear", "new_page", "anonymous_home", "add_account_cookies"],
        )

    def test_persistent_context_keeps_one_neutral_tab_alive(self) -> None:
        keeper = ExistingPage()
        extra = ExistingPage()
        context = SimpleNamespace(pages=[keeper, extra])

        session.neutralize_existing_pages(context)

        self.assertEqual(keeper.urls, ["about:blank"])
        self.assertFalse(keeper.closed)
        self.assertTrue(extra.closed)

    def test_authenticated_user_is_hashed_without_persisting_raw_id(self) -> None:
        user_id = parse_user_me(FakeResponse(200, {"success": True, "data": {"user_id": "u1"}}))
        self.assertEqual(user_id, "u1")
        self.assertEqual(len(identity_digest(user_id)), 64)

    def test_invalid_or_guest_session_fails_closed(self) -> None:
        cases = [
            FakeResponse(401, {}),
            FakeResponse(200, {"success": False, "code": -100}),
            FakeResponse(200, {"success": True, "data": {"guest": True}}),
            FakeResponse(200, {"success": True, "data": {}}),
        ]
        for response in cases:
            with self.subTest(status=response.status):
                with self.assertRaises(common.ConfigError):
                    parse_user_me(response)

    def test_profile_marker_cannot_be_reassigned_to_another_label(self) -> None:
        response = FakeResponse(200, {"success": True, "data": {"user_id": "u1"}})
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            (profile / "experiment-account.json").write_text(
                json.dumps({"account_id": "test_a", "identity_sha256": identity_digest("u1")}),
                encoding="utf-8",
            )
            (profile / "experiment-account.json").chmod(0o600)
            account = {"account_id": "test_b", "profile_dir": str(profile)}
            with self.assertRaisesRegex(common.ConfigError, "different account label"):
                validate_profile_session(FakeContext(response), account)


class CaptureTests(unittest.TestCase):
    def test_note_url_requires_allowed_host_and_exact_path_segment(self) -> None:
        self.assertTrue(allowed_note_url("https://www.xiaohongshu.com/explore/note123", "note123"))
        self.assertFalse(allowed_note_url("https://evil.example/explore/note123", "note123"))
        self.assertFalse(allowed_note_url("https://www.xiaohongshu.com/explore/note1234", "note123"))

    def test_detail_verdict_fails_closed(self) -> None:
        url = "https://www.xiaohongshu.com/explore/note123"
        self.assertEqual(detail_verdict(url, "note123", [200], True, False), "OPENED")
        self.assertEqual(detail_verdict(url, "note123", [404], True, False), "DETAIL_HTTP_ERROR")
        self.assertEqual(detail_verdict(url, "note123", [200], True, True), "DETAIL_NOT_FOUND")
        self.assertEqual(detail_verdict(url, "note123", [200], False, False), "DETAIL_UNCONFIRMED")
        self.assertEqual(
            detail_verdict("https://evil.example/explore/note123", "note123", [200], True, False),
            "DETAIL_ID_OR_HOST_MISMATCH",
        )

    def test_access_material_is_reduced_to_target_fields(self) -> None:
        payload = {
            "items": [
                {
                    "note_id": "note123",
                    "title": "sensitive title",
                    "xsec_token": "token",
                    "xsec_source": "pc_search",
                },
                {"note_id": "other", "xsec_token": "other-token"},
            ]
        }
        fragments = access_material_for_note(payload, "note123")
        self.assertEqual(
            fragments,
            [{"note_id": "note123", "xsec_token": "token", "xsec_source": "pc_search"}],
        )


class OrchestrationTests(unittest.TestCase):
    def test_staging_profile_promotion_can_restore_previous_profile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "test_d"
            staging = root / ".test_d.staging-synthetic"
            profile.mkdir()
            staging.mkdir()
            (profile / "old-state").write_text("old", encoding="utf-8")
            (staging / "new-state").write_text("new", encoding="utf-8")

            backup = login_profile.promote_staging_profile(staging, profile)
            self.assertTrue((profile / "new-state").exists())
            self.assertIsNotNone(backup)
            login_profile.rollback_profile_promotion(profile, backup)
            self.assertTrue((profile / "old-state").exists())
            self.assertFalse((profile / "new-state").exists())

    def test_dry_run_sequences_login_then_capture_without_online_flags(self) -> None:
        argv = [
            "run_experiment.py",
            "--transport",
            "browser",
            "--accounts-file",
            "/tmp/accounts.json",
            "--account-id",
            "test_a",
            "--note-id",
            "note123",
            "--bind-identity",
        ]
        process = SimpleNamespace(wait=unittest.mock.Mock(return_value=0))
        with patch.object(sys, "argv", argv), patch.object(
            run_experiment.subprocess,
            "Popen",
            return_value=process,
        ) as mocked_run:
            self.assertEqual(run_experiment.main(), 0)

        commands = [call.args[0] for call in mocked_run.call_args_list]
        self.assertEqual(len(commands), 2)
        self.assertTrue(commands[0][2].endswith("login_profile.py"))
        self.assertIn("--bind-identity", commands[0])
        self.assertTrue(commands[1][2].endswith("capture_visit.py"))
        self.assertNotIn("--execute", commands[0])
        self.assertNotIn("--execute", commands[1])

    def test_timed_out_step_terminates_the_child_process_group(self) -> None:
        process = SimpleNamespace(pid=123, returncode=None)
        process.wait = unittest.mock.Mock(
            side_effect=[subprocess.TimeoutExpired(["child"], 1), 0]
        )
        with patch.object(
            run_experiment.subprocess,
            "Popen",
            return_value=process,
        ), patch.object(run_experiment.os, "killpg") as killpg:
            result = run_experiment.run_step("cookie_login", ["child"], timeout_seconds=1)

        self.assertEqual(result, 124)
        killpg.assert_called_once_with(123, run_experiment.signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
