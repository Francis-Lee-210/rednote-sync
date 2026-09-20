#!/usr/bin/env python3
"""Validate an external Cookie via HTTP, optionally discover and read one public note.

No note-id: one signed current-user request only. With a note-id: current user,
one search page, then the exact target's detail using search-derived material.
With --search-only: stop after target discovery, without requesting detail.
Dry-run reads local inputs but performs no request and writes no runtime state.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import stat
import sys
import uuid
from pathlib import Path
from typing import Any

from common import (
    CONFIG_DIR, DATA_DIR, SHA256_HEX, SAFE_ID, AttemptLimitReached, ConfigError, ExperimentLock,
    ensure_local_dir, find_account, load_accounts_file, load_request_policy,
    reserve_daily_attempt, run_ts, utc_now, write_json_private,
)
from experiment_io import Recorder, load_public_sample
from protocol_session import (
    SIGNER_VERSION, LocalSigner, ProtocolError, ProtocolSession,
    access_material, cookie_fields, require_detail,
)

METHOD = "http-cookie-v1"
CLIENT_REVISION = 3
TOTAL_TIMEOUT_SECONDS = 210


def private_directory(name: str, *, create: bool = False) -> Path:
    path = DATA_DIR / name
    if DATA_DIR.is_symlink() or path.is_symlink():
        raise ProtocolError("RUNTIME_DIRECTORY_SYMLINK")
    if create:
        ensure_local_dir(DATA_DIR)
        ensure_local_dir(path)
    return path


def binding_path(account_id: str) -> Path:
    if not SAFE_ID.fullmatch(account_id):
        raise ProtocolError("ACCOUNT_ID_INVALID")
    return private_directory("protocol-identities") / f"{account_id}.json"


def read_binding(account_id: str) -> dict[str, Any]:
    path = binding_path(account_id)
    if path.is_symlink():
        raise ProtocolError("IDENTITY_MARKER_INVALID")
    if not path.exists():
        return {}
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise ProtocolError("IDENTITY_MARKER_INVALID")
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            descriptor = -1
            text = stream.read(4097)
        if len(text) > 4096:
            raise ProtocolError("IDENTITY_MARKER_INVALID")
        marker = json.loads(text)
    except (ValueError, UnicodeError):
        raise ProtocolError("IDENTITY_MARKER_INVALID") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if (
        not isinstance(marker, dict)
        or set(marker) != {"method", "account_id", "identity_sha256", "validated_at"}
        or marker.get("method") != METHOD or marker.get("account_id") != account_id
        or not isinstance(marker.get("identity_sha256"), str)
        or not SHA256_HEX.fullmatch(marker["identity_sha256"])
        or not isinstance(marker.get("validated_at"), str)
    ):
        raise ProtocolError("IDENTITY_MARKER_INVALID")
    return marker


def check_binding(account: dict[str, Any], marker: dict[str, Any], digest: str) -> None:
    for expected in (account.get("expected_user_id_sha256"), marker.get("identity_sha256")):
        if expected and expected.lower() != digest:
            raise ProtocolError("IDENTITY_MISMATCH")


def run_protocol(
    account: dict[str, Any], policy: dict[str, Any], *, bind_identity: bool,
    note_id: str | None = None, query: str | None = None, search_only: bool = False,
) -> tuple[int, Path]:
    """Execute after all local preflight checks, sharing browser-route budgets."""
    if search_only and (not note_id or not isinstance(query, str) or not query.strip()):
        raise ProtocolError("SEARCH_ONLY_REQUIRES_NOTE_AND_QUERY")
    report: dict[str, Any] = {
        "method": METHOD, "client_revision": CLIENT_REVISION,
        "account_id": account["account_id"], "started_at": utc_now(),
        "signer": f"xhshow=={SIGNER_VERSION}", "signature_format": "xys",
        "phase": "search" if search_only else "discovery" if note_id else "identity",
        "search_only": search_only, "identity_verified": False,
        "search_api_succeeded": False, "target_discovered": False,
        "browser_login_verified": False, "detail_verified": False,
        "cookie_policy": "frozen_input_set_cookie_discarded", "result": "NOT_STARTED",
    }
    stem = f"{account['account_id']}_{run_ts()}_{uuid.uuid4().hex[:8]}"
    report_path = private_directory("protocol-runs") / f"{stem}.json"
    session = None
    recorder = None
    exit_code = 1
    with ExperimentLock():
        try:
            marker = read_binding(account["account_id"])
            if not (marker or account.get("expected_user_id_sha256") or bind_identity):
                raise ProtocolError("FIRST_BIND_REQUIRES_CONFIRMATION")
            # Local dependency checks happen before consuming a daily network attempt.
            signer = LocalSigner(account.get("user_agent") or "")
            session = ProtocolSession(account, policy, signer=signer)
            private_directory("protocol-runs", create=True)
            report["login_attempt"] = reserve_daily_attempt(
                account["account_id"], "login", int(policy["max_login_attempts_per_account_per_day"])
            )
            print("transport=protocol step=identity status=START", flush=True)
            digest = session.identity()
            check_binding(account, marker, digest)
            private_directory("protocol-identities", create=True)
            write_json_private(binding_path(account["account_id"]), {
                "method": METHOD, "account_id": account["account_id"],
                "identity_sha256": digest, "validated_at": utc_now(),
            })
            report["identity_verified"] = True
            report["identity_binding"] = "matched" if marker or account.get("expected_user_id_sha256") else "first_observed"
            print("transport=protocol step=identity status=OK browser_login=NOT_TESTED", flush=True)
            if note_id is None:
                report["result"] = "PROTOCOL_IDENTITY_VERIFIED"
            else:
                if not query:
                    raise ProtocolError("SEARCH_QUERY_REQUIRED")
                report["capture_attempt"] = reserve_daily_attempt(
                    account["account_id"], "capture", int(policy["max_capture_runs_per_account_per_day"])
                )
                print("transport=protocol step=search status=START page=1", flush=True)
                search_data = session.search(query)
                report["search_api_succeeded"] = True
                material = access_material(search_data, note_id)
                report["target_discovered"] = True
                capture = private_directory("captures", create=True) / f"protocol_{stem}.jsonl"
                recorder = Recorder(capture)
                recorder.emit("protocol.search_access_material", material)
                report["capture"] = str(capture.relative_to(DATA_DIR))
                report["source_origin"] = material["source_origin"]
                if search_only:
                    print("transport=protocol step=search status=OK detail=NOT_REQUESTED", flush=True)
                    report["result"] = "PROTOCOL_SEARCH_VERIFIED"
                else:
                    print("transport=protocol step=detail status=START", flush=True)
                    require_detail(session.detail(material), note_id)
                    recorder.emit("protocol.detail_verified", {"note_id": note_id, "verified": True})
                    report["detail_verified"] = True
                    report["result"] = "PROTOCOL_COMPLETE"
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
            if recorder is not None:
                recorder.close()
            if session is not None:
                report["requests"] = session.events
                session.close()
            report["finished_at"] = utc_now()
            private_directory("protocol-runs", create=True)
            write_json_private(report_path, report)
    print(f"result={report['result']} report={report_path}", flush=True)
    return exit_code, report_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-file", default=None)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--note-id", help="omit for an identity-only protocol test")
    parser.add_argument("--search-only", action="store_true", help="stop after approved target discovery; requires --note-id")
    parser.add_argument("--notes-file", default=str(CONFIG_DIR / "notes.yaml"))
    parser.add_argument("--query-index", type=int, default=0)
    parser.add_argument("--bind-identity", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    if args.execute and not args.yes:
        print("refusing online experiment: --execute requires --yes", file=sys.stderr)
        return 2
    try:
        if args.search_only and args.note_id is None:
            raise ProtocolError("SEARCH_ONLY_REQUIRES_NOTE_ID")
        if not SAFE_ID.fullmatch(args.account_id):
            raise ProtocolError("ACCOUNT_ID_INVALID")
        if args.note_id is not None and not SAFE_ID.fullmatch(args.note_id):
            raise ProtocolError("NOTE_ID_INVALID")
        account = find_account(load_accounts_file(args.accounts_file, require_profile=False), args.account_id)
        cookie_fields(account.get("cookie") or "")
        policy = load_request_policy()
        marker = read_binding(args.account_id)
        if not (marker or account.get("expected_user_id_sha256") or args.bind_identity):
            raise ProtocolError("FIRST_BIND_REQUIRES_CONFIRMATION")
        if marker:
            check_binding(account, {}, marker["identity_sha256"].lower())
        query = None
        if args.note_id:
            sample = load_public_sample(Path(args.notes_file), args.note_id)
            if not 0 <= args.query_index < len(sample["search_queries"]):
                raise ProtocolError("QUERY_INDEX_INVALID")
            query = sample["search_queries"][args.query_index].strip()
        elif args.query_index:
            raise ProtocolError("QUERY_REQUIRES_NOTE_ID")
        # No real credentials are passed to the signer during preflight.
        LocalSigner(account.get("user_agent") or "")
    except ProtocolError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2
    except (ConfigError, OSError, ImportError):
        print("config error: check the external account file, sample, policy and installed requirements", file=sys.stderr)
        return 2
    phase = "search" if args.search_only else "discovery" if query else "identity"
    print(f"transport=protocol account={args.account_id} phase={phase}")
    if not args.execute:
        print("dry-run: local inputs read; no platform request, browser launch or state write")
        return 0

    def stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    def timeout(_signum: int, _frame: Any) -> None:
        raise ProtocolError("RUN_TIMEOUT")

    old_term = signal.signal(signal.SIGTERM, stop)
    old_alarm = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, TOTAL_TIMEOUT_SECONDS)
    try:
        result, _ = run_protocol(
            account, policy, bind_identity=args.bind_identity, note_id=args.note_id,
            query=query, search_only=args.search_only,
        )
        return result
    except (ConfigError, OSError):
        print("protocol stopped: local operation lock, policy or runtime state rejected", file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGALRM, old_alarm)


if __name__ == "__main__":
    raise SystemExit(main())
