#!/usr/bin/env python3
"""Seed one isolated Chromium profile from an external Cookie header.

Dry-run is the default. Online validation requires both --execute and --yes.
No Cookie value or user identifier is printed or written to the repository.
"""
from __future__ import annotations

import argparse
import random
import sys
import tempfile
import time
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

from common import (
    ConfigError,
    ExperimentLock,
    ensure_local_dir,
    find_account,
    load_accounts_file,
    load_request_policy,
    reserve_daily_attempt,
    run_ts,
)
from session import (
    neutralize_existing_pages,
    persist_profile_binding,
    seed_cookie_and_validate,
    validate_profile_marker,
)


def create_staging_profile(profile_dir: Path) -> Path:
    """Create a fresh sibling profile so a candidate Cookie cannot mutate the live one."""
    ensure_local_dir(profile_dir.parent, mode=0o700)
    return Path(
        tempfile.mkdtemp(
            prefix=f".{profile_dir.name}.staging-",
            dir=profile_dir.parent,
        )
    )


def promote_staging_profile(staging: Path, profile_dir: Path) -> Path | None:
    """Atomically promote a closed staging profile, preserving the previous profile."""
    backup = None
    if profile_dir.exists():
        backup = profile_dir.with_name(
            f".{profile_dir.name}.previous-{run_ts()}-{uuid.uuid4().hex[:8]}"
        )
        profile_dir.rename(backup)
    try:
        staging.rename(profile_dir)
    except Exception:
        if backup is not None and backup.exists() and not profile_dir.exists():
            backup.rename(profile_dir)
        raise
    return backup


def rollback_profile_promotion(profile_dir: Path, backup: Path | None) -> None:
    """Quarantine an unbound promoted profile and restore the previous profile."""
    if profile_dir.exists():
        failed = profile_dir.with_name(
            f".{profile_dir.name}.failed-{run_ts()}-{uuid.uuid4().hex[:8]}"
        )
        profile_dir.rename(failed)
    if backup is not None and backup.exists():
        backup.rename(profile_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-file", default=None)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--manual-challenge-timeout-seconds",
        type=int,
        default=0,
        help="keep headed Chrome open for manual CAPTCHA/security verification (max 600s)",
    )
    parser.add_argument(
        "--bind-identity",
        action="store_true",
        help="explicitly bind an unbound account label to this Cookie's validated user id",
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    try:
        account = find_account(load_accounts_file(args.accounts_file), args.account_id)
        if not account.get("cookie"):
            raise ConfigError("selected account has no Cookie value")
        if not account.get("profile_dir"):
            raise ConfigError("selected account has no profile_dir")
        profile_dir = Path(account["profile_dir"])
        marker = validate_profile_marker(account) if profile_dir.exists() else {}
        has_identity_binding = bool(
            marker.get("identity_sha256") or account.get("expected_user_id_sha256")
        )
        if not has_identity_binding and not args.bind_identity:
            raise ConfigError(
                "first use requires --bind-identity to confirm the account/Cookie mapping"
            )
        if not 0 <= args.manual_challenge_timeout_seconds <= 600:
            raise ConfigError("manual challenge timeout must be between 0 and 600 seconds")
        if args.manual_challenge_timeout_seconds and not args.headed:
            raise ConfigError("manual challenge waiting requires --headed")
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    print(f"account={args.account_id} profile={profile_dir}")
    if not args.execute:
        print("dry-run: local account config read; Cookie not injected and no platform request made")
        return 0
    if not args.yes:
        print("refusing online login: --execute requires --yes", file=sys.stderr)
        return 2

    staging = None
    try:
        with ExperimentLock():
            request_policy = load_request_policy()
            reserve_daily_attempt(
                args.account_id,
                "login",
                int(request_policy["max_login_attempts_per_account_per_day"]),
            )
            delay = random.uniform(
                float(request_policy.get("min_delay_seconds", 5)),
                float(request_policy.get("max_delay_seconds", 15)),
            )
            print(f"waiting {delay:.1f}s before read-only login validation")
            time.sleep(delay)
            staging = create_staging_profile(profile_dir)
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    str(staging),
                    channel="chrome",
                    headless=not args.headed,
                    user_agent=account.get("user_agent") or None,
                )
                try:
                    neutralize_existing_pages(context)
                    digest = seed_cookie_and_validate(
                        context,
                        account,
                        manual_challenge_timeout_seconds=(
                            args.manual_challenge_timeout_seconds
                        ),
                    )
                finally:
                    context.close()
            backup = promote_staging_profile(staging, profile_dir)
            staging = None
            try:
                persist_profile_binding(account, digest)
            except Exception:
                rollback_profile_promotion(profile_dir, backup)
                raise
    except ConfigError as exc:
        print(f"login rejected: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - never print response bodies or credentials
        print(f"login error: {type(exc).__name__}", file=sys.stderr)
        return 1

    print("login=OK identity_binding=OK profile_persisted=YES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
