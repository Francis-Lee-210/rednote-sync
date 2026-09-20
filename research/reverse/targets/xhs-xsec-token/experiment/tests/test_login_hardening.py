from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch


EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402
import login_profile  # noqa: E402
from session import identity_digest  # noqa: E402


class FakeContext:
    def __init__(self) -> None:
        self.pages = []
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self, context: FakeContext) -> None:
        self.context = context

    def launch_persistent_context(self, *_args, **_kwargs) -> FakeContext:
        return self.context


class FakePlaywrightManager:
    def __init__(self, context: FakeContext) -> None:
        self.playwright = type("Playwright", (), {"chromium": FakeChromium(context)})()

    def __enter__(self):
        return self.playwright

    def __exit__(self, *_args) -> None:
        return None


class LoginHardeningTests(unittest.TestCase):
    def run_login(self, account: dict, context: FakeContext, seed_result) -> int:
        argv = ["login_profile.py", "--account-id", account["account_id"], "--execute", "--yes"]
        with patch.object(sys, "argv", argv), patch.object(
            login_profile, "load_accounts_file", return_value=[account]
        ), patch.object(login_profile, "ExperimentLock", return_value=nullcontext()), patch.object(
            login_profile,
            "load_request_policy",
            return_value={
                "min_delay_seconds": 0,
                "max_delay_seconds": 0,
                "max_login_attempts_per_account_per_day": 3,
            },
        ), patch.object(login_profile, "reserve_daily_attempt"), patch.object(
            login_profile.time, "sleep"
        ), patch.object(
            login_profile,
            "sync_playwright",
            return_value=FakePlaywrightManager(context),
        ), patch.object(
            login_profile,
            "seed_cookie_and_validate",
            side_effect=seed_result if isinstance(seed_result, Exception) else None,
            return_value=None if isinstance(seed_result, Exception) else seed_result,
        ):
            return login_profile.main()

    def test_failed_candidate_preserves_existing_profile_and_closes_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "test_d"
            profile.mkdir()
            (profile / "old-state").write_text("old", encoding="utf-8")
            account = {
                "account_id": "test_d",
                "source": "self_registered",
                "cookie": "synthetic=value",
                "profile_dir": str(profile),
                "expected_user_id_sha256": "a" * 64,
            }
            context = FakeContext()

            result = self.run_login(account, context, common.ConfigError("invalid session"))

            self.assertEqual(result, 1)
            self.assertTrue(context.closed)
            self.assertEqual((profile / "old-state").read_text(encoding="utf-8"), "old")
            self.assertFalse((profile / "experiment-account.json").exists())

    def test_success_closes_staging_before_promoting_and_binding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "test_d"
            digest = identity_digest("synthetic-user")
            account = {
                "account_id": "test_d",
                "source": "self_registered",
                "cookie": "synthetic=value",
                "profile_dir": str(profile),
                "expected_user_id_sha256": digest,
            }
            context = FakeContext()

            result = self.run_login(account, context, digest)

            self.assertEqual(result, 0)
            self.assertTrue(context.closed)
            self.assertTrue((profile / "experiment-account.json").is_file())


if __name__ == "__main__":
    unittest.main()
