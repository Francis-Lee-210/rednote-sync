from __future__ import annotations

import json
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call, patch


EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import common  # noqa: E402
import run_experiment  # noqa: E402


class PolicyHardeningTests(unittest.TestCase):
    def assert_policy_rejected(self, field: str, value: object) -> None:
        with patch.object(
            common,
            "load_policy",
            return_value={"request_policy": {field: value}},
        ):
            with self.assertRaises(common.ConfigError):
                common.load_request_policy()

    def test_policy_rejects_bool_fractional_and_nonfinite_values(self) -> None:
        self.assert_policy_rejected("max_search_scrolls_per_run", True)
        self.assert_policy_rejected("max_search_scrolls_per_run", 2.5)
        self.assert_policy_rejected("min_delay_seconds", float("nan"))
        self.assert_policy_rejected("max_delay_seconds", float("inf"))

    def test_policy_rejects_values_above_safety_maxima(self) -> None:
        cases = {
            "min_delay_seconds": 15.1,
            "max_delay_seconds": 15.1,
            "max_login_attempts_per_account_per_day": 4,
            "max_capture_runs_per_account_per_day": 4,
            "max_search_scrolls_per_run": 4,
            "search_settle_seconds": 5.1,
            "default_timeout_seconds": 45.1,
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                self.assert_policy_rejected(field, value)

    def test_policy_accepts_declared_safety_maxima(self) -> None:
        with patch.object(
            common,
            "load_policy",
            return_value={"request_policy": dict(common.REQUEST_POLICY_MAXIMUMS)},
        ):
            self.assertEqual(
                common.load_request_policy(),
                common.REQUEST_POLICY_MAXIMUMS,
            )


class AtomicPrivateWriteTests(unittest.TestCase):
    def test_daily_attempt_ledger_counts_failures_independently_of_captures(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            common, "DATA_DIR", Path(directory)
        ):
            self.assertEqual(common.reserve_daily_attempt("test_d", "login", 2), 1)
            self.assertEqual(common.reserve_daily_attempt("test_d", "login", 2), 2)
            with self.assertRaisesRegex(common.ConfigError, "daily login attempt limit"):
                common.reserve_daily_attempt("test_d", "login", 2)
            self.assertEqual(common.reserve_daily_attempt("test_d", "capture", 1), 1)

    def test_private_json_write_is_atomic_and_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "marker.json"
            target.write_text('{"old": true}', encoding="utf-8")

            with patch.object(common.os, "replace", wraps=common.os.replace) as replace:
                common.write_json_private(target, {"new": True})

            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"new": True})
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])
            replace.assert_called_once()

    def test_failed_serialization_preserves_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "marker.json"
            original = '{"old": true}'
            target.write_text(original, encoding="utf-8")

            with self.assertRaises(TypeError):
                common.write_json_private(target, {"bad": {"not-json"}})  # type: ignore[dict-item]

            self.assertEqual(target.read_text(encoding="utf-8"), original)
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])


class ProcessCleanupTests(unittest.TestCase):
    def test_timeout_uses_bounded_term_then_kill_reaping(self) -> None:
        process = SimpleNamespace(pid=123)
        process.wait = unittest.mock.Mock(
            side_effect=[
                subprocess.TimeoutExpired(["child"], 1),
                subprocess.TimeoutExpired(["child"], 5),
                0,
            ]
        )
        process.poll = unittest.mock.Mock(return_value=None)

        with patch.object(run_experiment.subprocess, "Popen", return_value=process), patch.object(
            run_experiment.os, "killpg"
        ) as killpg:
            result = run_experiment.run_step("step", ["child"], timeout_seconds=1)

        self.assertEqual(result, 124)
        self.assertEqual(
            killpg.call_args_list,
            [call(123, signal.SIGTERM), call(123, signal.SIGKILL)],
        )
        self.assertEqual(
            process.wait.call_args_list,
            [call(timeout=1), call(timeout=5), call(timeout=5)],
        )

    def test_keyboard_interrupt_terminates_child_group(self) -> None:
        process = SimpleNamespace(pid=123)
        process.wait = unittest.mock.Mock(side_effect=[KeyboardInterrupt(), 0])
        process.poll = unittest.mock.Mock(return_value=None)

        with patch.object(run_experiment.subprocess, "Popen", return_value=process), patch.object(
            run_experiment.os, "killpg"
        ) as killpg:
            result = run_experiment.run_step("step", ["child"], timeout_seconds=1)

        self.assertEqual(result, 130)
        killpg.assert_called_once_with(123, signal.SIGTERM)
        self.assertEqual(process.wait.call_args_list, [call(timeout=1), call(timeout=5)])

    def test_sigterm_is_converted_to_child_cleanup(self) -> None:
        installed: dict[int, object] = {}
        process = SimpleNamespace(pid=123)

        def wait(*, timeout: int) -> int:
            if timeout == 1:
                installed[signal.SIGTERM](signal.SIGTERM, None)  # type: ignore[operator]
            return 0

        process.wait = unittest.mock.Mock(side_effect=wait)
        process.poll = unittest.mock.Mock(return_value=None)

        def install(signum: int, handler: object) -> object:
            previous = installed.get(signum, signal.SIG_DFL)
            installed[signum] = handler
            return previous

        with patch.object(run_experiment.subprocess, "Popen", return_value=process), patch.object(
            run_experiment.signal, "getsignal", return_value=signal.SIG_DFL
        ), patch.object(run_experiment.signal, "signal", side_effect=install), patch.object(
            run_experiment.os, "killpg"
        ) as killpg:
            result = run_experiment.run_step("step", ["child"], timeout_seconds=1)

        self.assertEqual(result, 128 + signal.SIGTERM)
        killpg.assert_called_once_with(123, signal.SIGTERM)

    def test_kill_reap_timeout_is_bounded(self) -> None:
        process = SimpleNamespace(pid=123)
        process.wait = unittest.mock.Mock(
            side_effect=[
                subprocess.TimeoutExpired(["child"], 5),
                subprocess.TimeoutExpired(["child"], 5),
            ]
        )
        process.poll = unittest.mock.Mock(return_value=None)

        with patch.object(run_experiment.os, "killpg") as killpg:
            self.assertFalse(run_experiment._terminate_process_group(process))

        self.assertEqual(
            killpg.call_args_list,
            [call(123, signal.SIGTERM), call(123, signal.SIGKILL)],
        )
        self.assertEqual(process.wait.call_args_list, [call(timeout=5), call(timeout=5)])


if __name__ == "__main__":
    unittest.main()
