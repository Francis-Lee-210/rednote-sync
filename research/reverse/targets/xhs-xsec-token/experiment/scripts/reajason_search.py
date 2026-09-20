#!/usr/bin/env python3
"""One ReaJason/xhs identity + search comparison, dry-run by default.

The fixed upstream business methods, get/post serialization and external-sign
callback run unchanged. Only Cookie loading and request/response transport are
replaced. Requests never sends traffic; the existing bounded HTTPX transport
enforces stop conditions. No detail, capture, retries or account rotation.
"""
from __future__ import annotations

import argparse
import importlib
import json
import random
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from common import (
    CONFIG_DIR, WORKSPACE_DIR, AttemptLimitReached, ConfigError, ExperimentLock,
    find_account, load_accounts_file, load_request_policy, reserve_daily_attempt,
    run_ts, utc_now, write_json_private,
)
from experiment_io import load_public_sample
from protocol_experiment import check_binding, private_directory, read_binding
from protocol_session import (
    API_ORIGIN, IDENTITY_PATH, SEARCH_PATH, LocalSigner, ProtocolError,
    ProtocolSession, authenticated_digest, cookie_fields,
)

SDK_REVISION = "f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0"
SDK_SOURCE = WORKSPACE_DIR / "research/projects/xhs/source"
TOTAL_TIMEOUT_SECONDS = 210


def encoded(payload: Any) -> bytes | None:
    return None if payload is None else json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")


def load_sdk():
    """Check the fixed tracked package before importing it; never run examples."""
    try:
        head = subprocess.check_output(
            ["git", "-C", str(SDK_SOURCE), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL, timeout=5, text=True,
        ).strip()
        clean = subprocess.run(
            ["git", "-C", str(SDK_SOURCE), "diff", "--quiet", SDK_REVISION, "--", "xhs"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        raise ProtocolError("SDK_SOURCE_UNAVAILABLE") from None
    if head != SDK_REVISION or not clean:
        raise ProtocolError("SDK_REVISION_MISMATCH")
    sys.dont_write_bytecode = True
    source = str(SDK_SOURCE)
    if source not in sys.path:
        sys.path.insert(0, source)
    sdk = importlib.import_module("xhs")
    if Path(sdk.__file__).resolve() != SDK_SOURCE.resolve() / "xhs/__init__.py":
        raise ProtocolError("SDK_IMPORT_SOURCE_MISMATCH")
    return sdk


class PreparedSigner:
    """Supply the SDK callback's already-created signature exactly once."""

    def __init__(self, user_agent: str):
        self.user_agent = user_agent
        self.pending = None

    def headers(self, method, path, cookies, payload):
        expected = self.pending
        self.pending = None
        if expected is None or expected[:4] != (method, path, cookies, encoded(payload)):
            raise ProtocolError("SDK_PREPARED_REQUEST_MISMATCH")
        return dict(expected[4])


class ReajasonSearchClient:
    def __init__(self, account, policy, *, transport=None, signer=None):
        sdk = load_sdk()
        self.account = dict(account)
        self.cookies = cookie_fields(account.get("cookie", ""))
        self.policy = dict(policy)
        self.signer = signer or LocalSigner(account.get("user_agent") or "")
        self.prepared = PreparedSigner(self.signer.user_agent)
        # Delay is enforced in the SDK callback, BEFORE signing. The shared
        # transport must not add another delay after that signature is created.
        transport_policy = {**policy, "min_delay_seconds": 0, "max_delay_seconds": 0}
        self.protocol = ProtocolSession(
            account, transport_policy, transport=transport, signer=self.prepared,
        )
        self.identity_verified = False
        self.closed = False
        outer = self

        class GuardedClient(sdk.XhsClient):
            @property
            def cookie(self):
                return outer.account["cookie"]

            @cookie.setter
            def cookie(self, value):
                # Do not invoke upstream split('=') or hard-coded defaults.
                if value != outer.account["cookie"]:
                    outer.reject("SDK_COOKIE_MUTATION")
                self.session.cookies.clear()
                self.session.cookies.update(dict(outer.cookies))

            def request(self, method, url, **kwargs):
                return outer.request(method, url, **kwargs)

        self.sdk = GuardedClient(
            cookie=account["cookie"], user_agent=self.signer.user_agent,
            sign=self.sign_callback, timeout=policy["default_timeout_seconds"],
        )
        self.sdk.session.trust_env = False

        def no_requests_network(*args, **kwargs):
            self.reject("SDK_DIRECT_NETWORK_FORBIDDEN")

        self.sdk.session.request = no_requests_network
        self.sdk.session.send = no_requests_network

    def reject(self, reason):
        self.protocol._stopped = True
        self.prepared.pending = None
        raise ProtocolError(reason)

    def sign_callback(self, uri, data=None, *, a1=None, web_session=None):
        if self.closed or self.protocol._stopped or self.prepared.pending is not None:
            self.reject("SDK_SESSION_STOPPED")
        if self.sdk.cookie_dict != self.cookies:
            self.reject("SDK_COOKIE_MUTATION")
        if a1 != self.cookies["a1"] or web_session != self.cookies["web_session"]:
            self.reject("SDK_COOKIE_MISMATCH")
        if uri == IDENTITY_PATH and data is None and not self.protocol.events:
            method = "GET"
        elif uri == SEARCH_PATH and isinstance(data, dict) and self.identity_verified and len(self.protocol.events) == 1:
            method = "POST"
        else:
            self.reject("SDK_OPERATION_NOT_ALLOWED")
        time.sleep(random.uniform(self.policy["min_delay_seconds"], self.policy["max_delay_seconds"]))
        signed = self.signer.headers(method, uri, dict(self.cookies), data)
        self.prepared.pending = (method, uri, dict(self.cookies), encoded(data), dict(signed))
        return dict(signed)

    def request(self, method, url, **kwargs):
        expected = self.prepared.pending
        if self.closed or self.protocol._stopped or expected is None:
            self.reject("SDK_PREPARED_REQUEST_MISSING")
        expected_method, path, _, body, signed = expected
        if method != expected_method or url != API_ORIGIN + path:
            self.reject("SDK_OPERATION_NOT_ALLOWED")
        if set(kwargs) != ({"data"} if method == "POST" else set()) or kwargs.get("data") != body:
            self.reject("SDK_BODY_MISMATCH")
        if self.sdk.user_agent != self.signer.user_agent or self.sdk.session.headers.get("user-agent") != self.signer.user_agent:
            self.reject("SDK_UA_MISMATCH")
        if any(self.sdk.session.headers.get(k) != v for k, v in signed.items()):
            self.reject("SDK_SIGNATURE_HEADERS_MISMATCH")
        payload = None if body is None else json.loads(body)
        # The shared transport's bytes must equal SDK.post's actual bytes.
        if encoded(payload) != body:
            self.reject("SDK_BODY_MISMATCH")
        return self.protocol._request(method, path, payload)

    def identity(self, marker):
        if not (marker or self.account.get("expected_user_id_sha256")):
            self.reject("SDK_PRIOR_IDENTITY_REQUIRED")
        data = self.sdk.get_self_info2()
        digest = authenticated_digest(data)
        check_binding(self.account, marker, digest)
        self.identity_verified = True

    def search(self, keyword, note_id):
        if not self.identity_verified:
            self.reject("IDENTITY_REQUIRED")
        data = self.sdk.get_note_by_keyword(keyword, page=1, page_size=20)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            self.reject("SDK_SEARCH_SCHEMA_UNRECOGNIZED")
        items = data["items"]
        if any(not isinstance(item, dict) for item in items):
            self.reject("SDK_SEARCH_SCHEMA_UNRECOGNIZED")
        notes = [item for item in items if isinstance(item.get("note_card"), dict)]
        return {
            "search_api_succeeded": True, "items_count": len(items),
            "note_cards_count": len(notes), "has_more": data.get("has_more") if type(data.get("has_more")) is bool else None,
            "target_found": any(note_id in (item.get("id"), item["note_card"].get("note_id"), item["note_card"].get("id")) for item in notes),
        }

    def close(self):
        self.closed = True
        self.prepared.pending = None
        self.protocol.close()
        self.sdk.session.cookies.clear()
        self.sdk.session.headers.clear()
        self.sdk.session.close()
        self.cookies.clear()
        self.account["cookie"] = ""


def run(account, policy, note_id, query):
    report = {
        "method": "reajason-xhs-search-v1", "sdk_revision": SDK_REVISION,
        "sdk_search_method": "get_note_by_keyword", "sdk_identity_method": "get_self_info2",
        "transport": "bounded-httpx", "signer": "xhshow==0.2.0", "signature_format": "xys",
        "account_id": account["account_id"], "started_at": utc_now(),
        "identity_verified": False, "search_api_succeeded": False,
        "detail_requested": False, "capture_written": False, "page": 1, "page_size": 20,
        "cookie_policy": "frozen_input_set_cookie_discarded", "result": "NOT_STARTED",
    }
    path = private_directory("reajason-runs") / f"{account['account_id']}_{run_ts()}_{uuid.uuid4().hex[:8]}.json"
    client = None
    code = 1
    with ExperimentLock():
        try:
            marker = read_binding(account["account_id"])
            if not (marker or account.get("expected_user_id_sha256")):
                raise ProtocolError("SDK_PRIOR_IDENTITY_REQUIRED")
            client = ReajasonSearchClient(account, policy)
            private_directory("reajason-runs", create=True)
            report["login_attempt"] = reserve_daily_attempt(account["account_id"], "login", int(policy["max_login_attempts_per_account_per_day"]))
            print("sdk=ReaJason/xhs step=identity status=START", flush=True)
            client.identity(marker)
            report["identity_verified"] = True
            report["identity_binding"] = "matched"
            report["capture_attempt"] = reserve_daily_attempt(account["account_id"], "capture", int(policy["max_capture_runs_per_account_per_day"]))
            print("sdk=ReaJason/xhs step=identity status=OK step=search status=START page=1", flush=True)
            report.update(client.search(query, note_id))
            report["result"] = "SDK_SEARCH_SUCCEEDED"
            code = 0
        except ProtocolError as exc:
            report["result"] = str(exc)
        except AttemptLimitReached as exc:
            report["result"] = f"DAILY_{exc.category.upper()}_LIMIT_REACHED"
        except KeyboardInterrupt:
            report["result"] = "CANCELLED"
        except Exception:
            report["result"] = "LOCAL_OR_TRANSPORT_ERROR"
        finally:
            if client is not None:
                report["requests"] = client.protocol.events
                client.close()
            report["finished_at"] = utc_now()
            private_directory("reajason-runs", create=True)
            write_json_private(path, report)
    print(f"result={report['result']} report={path}", flush=True)
    return code, path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--note-id", required=True)
    parser.add_argument("--query-index", type=int, default=0)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    if args.execute and not args.yes:
        print("refusing online run: --execute requires --yes", file=sys.stderr)
        return 2
    try:
        account = find_account(load_accounts_file(require_profile=False), args.account_id)
        policy = load_request_policy()
        marker = read_binding(args.account_id)
        if not (marker or account.get("expected_user_id_sha256")):
            raise ProtocolError("SDK_PRIOR_IDENTITY_REQUIRED")
        if marker:
            check_binding(account, {}, marker["identity_sha256"].lower())
        sample = load_public_sample(CONFIG_DIR / "notes.yaml", args.note_id)
        if not 0 <= args.query_index < len(sample["search_queries"]):
            raise ProtocolError("QUERY_INDEX_INVALID")
        query = sample["search_queries"][args.query_index].strip()
        client = ReajasonSearchClient(account, policy)
        client.close()
    except (ConfigError, OSError, ImportError):
        print("preflight rejected: check fixed SDK, dependencies, account binding and approved sample", file=sys.stderr)
        return 2
    if not args.execute:
        print("dry-run: fixed ReaJason/xhs loaded; local inputs checked; no signatures or platform requests")
        return 0

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    def timeout(_signum, _frame):
        raise ProtocolError("RUN_TIMEOUT")

    old_term = signal.signal(signal.SIGTERM, stop)
    old_alarm = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, TOTAL_TIMEOUT_SECONDS)
    try:
        return run(account, policy, args.note_id, query)[0]
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGALRM, old_alarm)


if __name__ == "__main__":
    raise SystemExit(main())
