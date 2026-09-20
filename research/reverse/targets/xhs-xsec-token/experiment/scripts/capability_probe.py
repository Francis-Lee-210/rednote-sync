#!/usr/bin/env python3
"""One test_f identity -> own profile -> own posted-list probe; dry-run by default.

Three fixed GETs, no search, detail, pagination, account rotation or writes.
The shared HTTP transport retains its budgets, redaction and hard stops.
Only status/shape/count summaries survive; no returned account or note data.
"""
from __future__ import annotations

import argparse
import re
import signal
import sys
import uuid
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

from common import (
    AttemptLimitReached, ConfigError, ExperimentLock, find_account,
    load_accounts_file, load_request_policy, reserve_daily_attempt, run_ts,
    utc_now, write_json_private,
)
from protocol_experiment import check_binding, private_directory, read_binding
from protocol_session import (
    IDENTITY_PATH, SIGNER_VERSION, LocalSigner, ProtocolError, ProtocolSession,
    authenticated_digest, cookie_fields,
)

PROFILE_PATH = "/api/sns/web/v1/user/otherinfo"
POSTED_PATH = "/api/sns/web/v1/user_posted"
USER_ID = re.compile(r"^[0-9a-fA-F]{24}$")
TOTAL_TIMEOUT_SECONDS = 180


def own_paths(user_id: str) -> tuple[str, str]:
    if not isinstance(user_id, str) or not USER_ID.fullmatch(user_id):
        raise ProtocolError("CAPABILITY_ID_FORMAT_UNCONFIRMED")
    return (
        PROFILE_PATH + "?" + urlencode({"target_user_id": user_id}),
        POSTED_PATH + "?" + urlencode({
            "num": 30, "cursor": "", "user_id": user_id, "image_scenes": "FD_WM_WEBP",
        }),
    )


class CapabilitySigner(LocalSigner):
    """Sign only exact canonical GET shapes; no generic URL/parameter option."""

    def _operation_allowed(self, method: str, path: str) -> bool:
        if method != "GET":
            return False
        if path == IDENTITY_PATH:
            return True
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            return False
        try:
            fields = dict(parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True))
            user_id = fields.get("target_user_id") if parsed.path == PROFILE_PATH else fields.get("user_id")
            return path in own_paths(user_id)
        except (ProtocolError, ValueError):
            return False


class CapabilitySession(ProtocolSession):
    def __init__(self, account, policy, *, transport=None, signer=None):
        if account.get("account_id") != "test_f":
            raise ProtocolError("CAPABILITY_ACCOUNT_NOT_AUTHORIZED")
        super().__init__(account, policy, transport=transport,
                         signer=signer or CapabilitySigner(account.get("user_agent") or ""))
        self._expected = account.get("expected_user_id_sha256")
        self._own_paths: tuple[str, str] | None = None
        self._profile_verified = False

    def _operation_allowed(self, method: str, path: str) -> bool:
        if method != "GET":
            return False
        if not self.events:
            return path == IDENTITY_PATH
        if not self._identity_verified or self._own_paths is None:
            return False
        if len(self.events) == 1:
            return path == self._own_paths[0]
        return len(self.events) == 2 and self._profile_verified and path == self._own_paths[1]

    def identity(self, marker=None) -> str:
        if self.events:
            self._stopped = True
            raise ProtocolError("IDENTITY_ALREADY_ATTEMPTED")
        try:
            if not marker or not marker.get("identity_sha256"):
                raise ProtocolError("EXISTING_BINDING_REQUIRED")
            data = self._request("GET", IDENTITY_PATH)
            digest = authenticated_digest(data)
            check_binding({"expected_user_id_sha256": self._expected}, marker, digest)
            self._own_paths = own_paths(data.get("user_id") or data.get("userId"))
            self._identity_verified = True
            return digest
        except ProtocolError:
            self._stopped = True
            raise

    def profile(self) -> dict[str, Any]:
        try:
            if not self._identity_verified or self._own_paths is None:
                raise ProtocolError("BOUND_IDENTITY_REQUIRED")
            data = self._request("GET", self._own_paths[0])
            if not data:
                raise ProtocolError("PROFILE_EMPTY_RESPONSE")
            self._profile_verified = True
            # Fixed upstream sources specify only dict, not a field contract.
            return {"result": "PROFILE_API_ACCEPTED", "api_succeeded": True,
                    "nonempty_object": True, "field_schema_verified": False}
        except ProtocolError:
            self._stopped = True
            raise

    def posted(self) -> dict[str, Any]:
        try:
            if not self._profile_verified or self._own_paths is None:
                raise ProtocolError("PROFILE_REQUIRED")
            data = self._request("GET", self._own_paths[1])
            notes = data.get("notes")
            if (not isinstance(notes, list) or len(notes) > 30
                    or any(not isinstance(note, dict)
                           or not isinstance(note.get("note_id"), str)
                           or not note["note_id"].strip() or len(note["note_id"]) > 128
                           or note.get("type") not in ("normal", "video") for note in notes)
                    or type(data.get("has_more")) is not bool
                    or not isinstance(data.get("cursor"), str)):
                raise ProtocolError("POSTED_SCHEMA_UNCONFIRMED")
            return {"result": "POSTED_LIST_RETURNED", "api_succeeded": True,
                    "schema_verified": True, "item_count": len(notes),
                    "has_more": data["has_more"], "empty": not notes}
        except ProtocolError:
            self._stopped = True
            raise

    def close(self) -> None:
        self._own_paths = None
        self._expected = None
        super().close()


def run_probe(account, policy, *, transport=None, signer=None):
    if account.get("account_id") != "test_f":
        raise ProtocolError("CAPABILITY_ACCOUNT_NOT_AUTHORIZED")
    report = {
        "method": "http-cookie-capabilities-v1", "account_id": "test_f",
        "started_at": utc_now(), "signer": f"xhshow=={SIGNER_VERSION}",
        "signature_format": "xys", "cookie_policy": "frozen_input_set_cookie_discarded",
        "identity_verified": False, "profile": {"result": "NOT_REQUESTED"},
        "posted": {"result": "NOT_REQUESTED"}, "result": "NOT_STARTED",
        "search_requested": False, "detail_requested": False, "phase": "preflight",
    }
    session = None
    path = private_directory("capability-runs") / f"test_f_{run_ts()}_{uuid.uuid4().hex[:8]}.json"
    exit_code = 1
    with ExperimentLock():
        try:
            marker = read_binding("test_f")
            if not marker:
                raise ProtocolError("EXISTING_BINDING_REQUIRED")
            check_binding(account, {}, marker["identity_sha256"])
            session = CapabilitySession(account, policy, transport=transport, signer=signer)
            private_directory("capability-runs", create=True)
            report["login_attempt"] = reserve_daily_attempt(
                "test_f", "login", int(policy["max_login_attempts_per_account_per_day"]))
            report["phase"] = "identity"
            print("capabilities account=test_f step=identity status=START", flush=True)
            session.identity(marker)
            report["identity_verified"] = True
            report["identity_binding"] = "matched"
            print("capabilities step=identity status=OK", flush=True)
            # Share the existing content-run budget; do not create a way around it.
            report["capture_attempt"] = reserve_daily_attempt(
                "test_f", "capture", int(policy["max_capture_runs_per_account_per_day"]))
            report["phase"] = "profile"
            print("capabilities step=profile status=START", flush=True)
            report["profile"] = session.profile()
            print("capabilities step=profile status=API_ACCEPTED", flush=True)
            report["phase"] = "posted"
            print("capabilities step=posted status=START page=1 limit=30", flush=True)
            report["posted"] = session.posted()
            print(f"capabilities step=posted status=OK count={report['posted']['item_count']}", flush=True)
            report["result"] = "CAPABILITY_PROBE_COMPLETE"
            exit_code = 0
        except ProtocolError as exc:
            report["result"] = str(exc)
        except AttemptLimitReached as exc:
            report["result"] = f"DAILY_{exc.category.upper()}_LIMIT_REACHED"
        except ConfigError:
            report["result"] = "LOCAL_POLICY_OR_CONFIG_REJECTED"
        except KeyboardInterrupt:
            report["result"] = "CANCELLED"
            exit_code = 130
        except Exception:
            report["result"] = "LOCAL_OR_TRANSPORT_ERROR"
        finally:
            if session is not None:
                report["requests"] = session.events
                session.close()
            for step, endpoint in (("profile", PROFILE_PATH), ("posted", POSTED_PATH)):
                if (report[step]["result"] == "NOT_REQUESTED"
                        and any(event["path"] == endpoint for event in report.get("requests", []))):
                    report[step] = {"result": report["result"], "attempted": True}
            report["finished_at"] = utc_now()
            private_directory("capability-runs", create=True)
            write_json_private(path, report)
    print(f"result={report['result']} report={path}", flush=True)
    return exit_code, path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True, choices=("test_f",))
    parser.add_argument("--accounts-file", default=None)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    if args.execute and not args.yes:
        print("refusing online probe: --execute requires --yes", file=sys.stderr)
        return 2
    try:
        account = dict(find_account(load_accounts_file(args.accounts_file, require_profile=False), "test_f"))
        cookie_fields(account.get("cookie") or "")
        marker = read_binding("test_f")
        if not marker:
            raise ProtocolError("EXISTING_BINDING_REQUIRED")
        check_binding(account, {}, marker["identity_sha256"])
        policy = load_request_policy()
        CapabilitySigner(account.get("user_agent") or "")
    except (ConfigError, OSError, ImportError):
        print("config error: check external input, existing binding, policy and dependencies", file=sys.stderr)
        return 2
    if not args.execute:
        print("dry-run: test_f identity -> own profile -> own posted list; max_requests=3; no network or state writes")
        return 0

    def timeout(_signum, _frame):
        raise ProtocolError("RUN_TIMEOUT")

    def terminate(_signum, _frame):
        raise KeyboardInterrupt

    old_alarm = signal.signal(signal.SIGALRM, timeout)
    old_term = signal.signal(signal.SIGTERM, terminate)
    signal.setitimer(signal.ITIMER_REAL, TOTAL_TIMEOUT_SECONDS)
    try:
        return run_probe(account, policy)[0]
    except (ConfigError, OSError):
        print("probe stopped: local lock, policy or runtime state rejected", file=sys.stderr)
        return 1
    finally:
        account.clear()
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_alarm)
        signal.signal(signal.SIGTERM, old_term)


if __name__ == "__main__":
    raise SystemExit(main())
