#!/usr/bin/env python3
"""Run the protocol Cookie experiment, or explicitly select the browser comparison.

One invocation handles one account and at most one enabled public note. Protocol
without --note-id tests identity only; --search-only stops before detail. Dry-run is the default; online execution
requires both --execute and --yes. Cookie values never enter argv.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import uuid

from common import CONFIG_DIR, DATA_DIR, EXPERIMENT_DIR, SAFE_ID, run_ts

SCRIPTS_DIR = EXPERIMENT_DIR / "scripts"
LOGIN_STEP_TIMEOUT_SECONDS = 135
CAPTURE_STEP_TIMEOUT_SECONDS = 240
LOCATE_STEP_TIMEOUT_SECONDS = 30
PROCESS_REAP_TIMEOUT_SECONDS = 5


class StepSignalInterrupt(Exception):
    """Internal exception used to turn termination signals into bounded cleanup."""

    def __init__(self, signum: int):
        super().__init__(signum)
        self.signum = signum


def _terminate_process_group(process: subprocess.Popen[bytes]) -> bool:
    """Stop a child process group, returning whether it was reaped in time."""
    poll = getattr(process, "poll", None)
    if callable(poll) and poll() is not None:
        return True
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        try:
            process.wait(timeout=PROCESS_REAP_TIMEOUT_SECONDS)
            return True
        except subprocess.TimeoutExpired:
            return False
    try:
        process.wait(timeout=PROCESS_REAP_TIMEOUT_SECONDS)
        return True
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=PROCESS_REAP_TIMEOUT_SECONDS)
            return True
        except subprocess.TimeoutExpired:
            return False


def run_step(name: str, command: list[str], *, timeout_seconds: int) -> int:
    print(f"step={name} status=START", flush=True)
    process = subprocess.Popen(command, start_new_session=True)
    previous_handlers: dict[int, signal.Handlers] = {}
    returncode: int | None = None
    interrupted_by: int | None = None
    unexpected: BaseException | None = None

    def interrupt_step(signum: int, _frame: object) -> None:
        raise StepSignalInterrupt(signum)

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, interrupt_step)
        try:
            returncode = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            pass
        except KeyboardInterrupt:
            interrupted_by = signal.SIGINT
        except StepSignalInterrupt as exc:
            interrupted_by = exc.signum
    except BaseException as exc:  # Ensure unexpected parent failures do not orphan Chrome.
        unexpected = exc
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)

    if unexpected is not None:
        _terminate_process_group(process)
        raise unexpected

    if returncode is None:
        reaped = _terminate_process_group(process)
        if interrupted_by is None:
            print(
                f"step={name} status=TIMED_OUT limit_seconds={timeout_seconds} "
                f"cleanup={'OK' if reaped else 'UNCONFIRMED'}",
                file=sys.stderr,
                flush=True,
            )
            return 124
        print(
            f"step={name} status=INTERRUPTED signal={interrupted_by} "
            f"cleanup={'OK' if reaped else 'UNCONFIRMED'}",
            file=sys.stderr,
            flush=True,
        )
        return 128 + int(interrupted_by)
    if returncode:
        print(f"step={name} status=FAILED exit={returncode}", file=sys.stderr)
        return returncode
    print(f"step={name} status=OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-file", default=None)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--transport", choices=("protocol", "browser"), default="protocol")
    parser.add_argument("--notes-file", default=str(CONFIG_DIR / "notes.yaml"))
    parser.add_argument("--note-id", help="omit for an identity-only protocol test")
    parser.add_argument("--search-only", action="store_true", help="protocol only: stop after approved target discovery")
    parser.add_argument("--query-index", type=int, default=0)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--manual-challenge-timeout-seconds",
        type=int,
        default=0,
        help="keep headed login Chrome open for manual verification (max 600s)",
    )
    parser.add_argument(
        "--bind-identity",
        action="store_true",
        help="required on the first run unless expected_user_id_sha256 is configured",
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    if args.search_only and (args.transport != "protocol" or args.note_id is None):
        print("config error: --search-only requires --transport protocol and --note-id", file=sys.stderr)
        return 2
    if not SAFE_ID.fullmatch(args.account_id):
        print("config error: invalid account-id", file=sys.stderr)
        return 2
    if args.note_id is not None and not SAFE_ID.fullmatch(args.note_id):
        print("config error: invalid note-id", file=sys.stderr)
        return 2
    if args.execute and not args.yes:
        print("refusing online experiment: --execute requires --yes", file=sys.stderr)
        return 2
    if args.transport == "protocol":
        if args.headed or args.manual_challenge_timeout_seconds:
            print("config error: browser flags require --transport browser", file=sys.stderr)
            return 2
        command = [sys.executable, "-u", str(SCRIPTS_DIR / "protocol_experiment.py"),
                   "--account-id", args.account_id]
        if args.accounts_file:
            command.extend(["--accounts-file", args.accounts_file])
        if args.note_id:
            command.extend(["--note-id", args.note_id, "--notes-file", args.notes_file])
        if args.search_only:
            command.append("--search-only")
        command.extend(["--query-index", str(args.query_index)])
        if args.bind_identity:
            command.append("--bind-identity")
        if args.execute:
            command.extend(["--execute", "--yes"])
        return run_step("protocol_experiment", command, timeout_seconds=225)
    if args.note_id is None:
        print("config error: --transport browser requires --note-id", file=sys.stderr)
        return 2
    if not 0 <= args.manual_challenge_timeout_seconds <= 600:
        print("config error: manual challenge timeout must be between 0 and 600 seconds", file=sys.stderr)
        return 2
    if args.manual_challenge_timeout_seconds and not args.headed:
        print("config error: manual challenge waiting requires --headed", file=sys.stderr)
        return 2

    run_id = f"{run_ts()}_{uuid.uuid4().hex[:8]}"
    capture = DATA_DIR / "captures" / f"{args.account_id}_{args.note_id}_{run_id}.jsonl"
    shared = ["--account-id", args.account_id]
    if args.accounts_file:
        shared.extend(["--accounts-file", args.accounts_file])

    login_command = [sys.executable, "-u", str(SCRIPTS_DIR / "login_profile.py"), *shared]
    capture_command = [
        sys.executable,
        "-u",
        str(SCRIPTS_DIR / "capture_visit.py"),
        *shared,
        "--notes-file",
        args.notes_file,
        "--note-id",
        args.note_id,
        "--query-index",
        str(args.query_index),
        "--output",
        str(capture),
    ]
    if args.headed:
        login_command.append("--headed")
        capture_command.append("--headed")
    if args.manual_challenge_timeout_seconds:
        login_command.extend(
            [
                "--manual-challenge-timeout-seconds",
                str(args.manual_challenge_timeout_seconds),
            ]
        )
    if args.bind_identity:
        login_command.append("--bind-identity")
    if args.execute:
        login_command.extend(["--execute", "--yes"])
        capture_command.extend(["--execute", "--yes"])

    print(
        f"run_id={run_id} account={args.account_id} note={args.note_id} "
        f"mode={'execute' if args.execute else 'dry-run'}"
    )
    if run_step(
        "cookie_login",
        login_command,
        timeout_seconds=max(
            LOGIN_STEP_TIMEOUT_SECONDS,
            args.manual_challenge_timeout_seconds + 90,
        ),
    ):
        return 1
    if run_step(
        "search_capture",
        capture_command,
        timeout_seconds=CAPTURE_STEP_TIMEOUT_SECONDS,
    ):
        return 1
    if not args.execute:
        print("experiment dry-run complete; no platform request made")
        return 0

    locate_command = [
        sys.executable,
        "-u",
        str(SCRIPTS_DIR / "locate_token.py"),
        "--capture",
        str(capture),
    ]
    if run_step(
        "locate_token",
        locate_command,
        timeout_seconds=LOCATE_STEP_TIMEOUT_SECONDS,
    ):
        print("result=ACCESS_MATERIAL_INCOMPLETE", file=sys.stderr)
        return 1

    print(f"result=COMPLETE capture={capture}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
