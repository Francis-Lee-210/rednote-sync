#!/usr/bin/env python3
"""Discover a public note through search, click it, and capture token provenance.

The script never navigates to a bare note-id URL. It requires an enabled public
sample, an identity-bound persistent profile, and explicit --execute --yes.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit

from playwright.sync_api import sync_playwright

from common import (
    CONFIG_DIR,
    DATA_DIR,
    SAFE_ID,
    ConfigError,
    ExperimentLock,
    find_account,
    load_accounts_file,
    load_request_policy,
    redact_url,
    require_path_below,
    reserve_daily_attempt,
    run_ts,
    sanitize_capture_url,
    sanitize_headers,
)
from experiment_io import Recorder, load_public_sample as _load_public_sample
from session import (
    is_session_risk_response,
    neutralize_existing_pages,
    page_has_visible_challenge,
    page_has_visible_login_prompt,
    page_has_visible_notice,
    validate_profile_marker,
    validate_profile_session,
)

SEARCH_URL = "https://www.xiaohongshu.com/search_result"
RISK_MARKERS = (
    "验证码",
    "安全验证",
    "访问频繁",
    "账号异常",
    "账号已被限制",
    "登录已过期",
    "请先登录",
)
NOT_FOUND_MARKERS = (
    "笔记不存在",
    "页面不见了",
    "内容不存在",
)
ALLOWED_NOTE_HOSTS = {"xiaohongshu.com", "www.xiaohongshu.com"}
CANONICAL_NOTE_HOST = "www.xiaohongshu.com"
SEARCH_PAYLOAD_PATH = "/api/sns/web/v1/search/notes"
URL_HEADER_NAMES = {"referer", "location", "content-location"}
ALLOWED_BROWSER_EVENTS = {
    "history.pushState": {"url"},
    "history.replaceState": {"url"},
    "fetch": {"url"},
    "xhr.open": {"url", "method"},
}

DETAIL_STATE_PROBE = """
(targetId) => {
  const roots = [window.__INITIAL_STATE__, window.__INITIAL_SSR_STATE__]
    .filter((value) => value && typeof value === 'object');
  const seen = new WeakSet();
  let visited = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node) || visited++ > 50000) return false;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key.toLowerCase().includes('notedetailmap') && value && typeof value === 'object') {
        if (value[targetId] && typeof value[targetId] === 'object') return true;
      }
    }
    return Object.values(node).some(walk);
  };
  return roots.some(walk);
}
"""

HOOK_SCRIPT = """
(() => {
  const report = (kind, data) => {
    if (!window.__xsecRecordEvent) return;
    try { window.__xsecRecordEvent(kind, JSON.stringify(data)); } catch (_) {}
  };
  const push = history.pushState;
  history.pushState = function (...args) {
    report('history.pushState', {url: args[2] === undefined ? location.href : String(args[2])});
    return push.apply(this, args);
  };
  const replace = history.replaceState;
  history.replaceState = function (...args) {
    report('history.replaceState', {url: args[2] === undefined ? location.href : String(args[2])});
    return replace.apply(this, args);
  };
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    let url = '';
    if (typeof args[0] === 'string') url = args[0];
    else if (args[0] && typeof args[0].url === 'string') url = args[0].url;
    report('fetch', {url});
    return origFetch.apply(this, args);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    report('xhr.open', {url: String(url), method: String(method)});
    return origOpen.call(this, method, url, ...rest);
  };
})();
"""


def load_public_sample(path: Path, note_id: str) -> dict[str, Any]:
    return _load_public_sample(path, note_id, config_dir=CONFIG_DIR)


def exact_note_href(page: Any, note_id: str) -> tuple[Any, str] | None:
    candidates = page.locator(f'a[href*="{note_id}"]')
    for index in range(candidates.count()):
        candidate = candidates.nth(index)
        href = candidate.get_attribute("href") or ""
        resolved = urljoin(page.url, href)
        if allowed_note_url(resolved, note_id) and candidate.is_visible():
            return candidate, resolved
    return None


def page_has_risk_notice(page: Any) -> bool:
    return page_has_visible_notice(page, RISK_MARKERS) or page_has_visible_login_prompt(page)


def page_has_not_found_notice(page: Any) -> bool | None:
    try:
        if page_has_visible_notice(page, ("当前笔记暂时无法浏览",)):
            return None
        return page_has_visible_notice(page, NOT_FOUND_MARKERS)
    except ConfigError:
        return None


def allowed_note_url(value: str, note_id: str) -> bool:
    parts = urlsplit(value)
    path_parts = [part for part in parts.path.split("/") if part]
    return (
        parts.scheme == "https"
        and parts.netloc == CANONICAL_NOTE_HOST
        and path_parts == ["explore", note_id]
    )


def sanitize_record_headers(
    headers: dict[str, Any], note_id: str | None = None
) -> dict[str, str]:
    """Redact credentials and sanitize URL-bearing header values."""
    sanitized = sanitize_headers(headers, target_note_id=note_id)
    for name, value in list(sanitized.items()):
        if name.lower() in URL_HEADER_NAMES and value != "<redacted>":
            sanitized[name] = sanitize_capture_url(value, target_note_id=note_id)
    return sanitized


def _safe_browser_url(value: Any, note_id: str | None = None) -> str | None:
    text = str(value)
    if not text or len(text) > 4_096:
        return None
    parts = urlsplit(text)
    if parts.scheme and parts.scheme not in {"http", "https"}:
        return None
    if not parts.scheme and parts.netloc:
        return None
    if parts.hostname and parts.hostname not in ALLOWED_NOTE_HOSTS:
        return None
    return sanitize_capture_url(text, target_note_id=note_id)


def sanitize_browser_event(
    kind: str, data: Any, note_id: str | None = None
) -> dict[str, str] | None:
    """Accept only the narrow event schema installed by this experiment."""
    allowed_fields = ALLOWED_BROWSER_EVENTS.get(kind)
    if allowed_fields is None:
        return None
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict):
        return None
    url = _safe_browser_url(data.get("url", ""), note_id=note_id)
    if url is None:
        return None
    result = {"url": url}
    if "method" in allowed_fields:
        method = str(data.get("method", "")).upper()
        result["method"] = method if method in {"GET", "POST"} else "OTHER"
    return result


def is_capture_payload_response(response: Any) -> bool:
    """Select only the site's read-only search payload response."""
    parts = urlsplit(str(response.url))
    path_allowed = parts.path == SEARCH_PAYLOAD_PATH or parts.path.startswith(
        SEARCH_PAYLOAD_PATH + "/"
    )
    return (
        parts.scheme == "https"
        and parts.netloc == CANONICAL_NOTE_HOST
        and path_allowed
        and response.request.resource_type in {"xhr", "fetch"}
        and str(response.request.method).upper() in {"GET", "POST"}
        and "json" in str(response.headers.get("content-type", "")).lower()
    )


def search_document_verdict(status: int | None) -> str | None:
    if status is None:
        return "SEARCH_NO_DOCUMENT_RESPONSE"
    if not 200 <= status < 300:
        return "SEARCH_HTTP_ERROR"
    return None


def detail_verdict(
    final_url: str,
    note_id: str,
    document_statuses: list[int],
    has_detail_state: bool,
    has_not_found_marker: bool | None,
) -> str:
    if not allowed_note_url(final_url, note_id):
        return "DETAIL_ID_OR_HOST_MISMATCH"
    if document_statuses and not 200 <= document_statuses[-1] < 300:
        return "DETAIL_HTTP_ERROR"
    if has_not_found_marker is None:
        return "DETAIL_UNCONFIRMED"
    if has_not_found_marker:
        return "DETAIL_NOT_FOUND"
    if not has_detail_state:
        return "DETAIL_UNCONFIRMED"
    return "OPENED"


def access_material_for_note(value: Any, note_id: str) -> list[dict[str, str]]:
    """Extract only target access fields; do not retain complete search payloads."""
    id_fields = {"id", "note_id", "noteId"}
    access_fields = {"xsec_token", "xsecToken", "xsec_source", "xsecSource"}
    found: list[dict[str, str]] = []
    seen: set[tuple[tuple[str, str], ...]] = set()
    visited = 0

    def walk(node: Any) -> None:
        nonlocal visited
        if len(found) >= 20:
            return
        visited += 1
        if visited > 50_000:
            return
        if isinstance(node, dict):
            exact_id = any(
                key in node and str(node[key]) == note_id
                for key in id_fields
                if isinstance(node.get(key), (str, int))
            )
            raw_url = node.get("url")
            exact_url = isinstance(raw_url, str) and allowed_note_url(
                urljoin(SEARCH_URL, raw_url), note_id
            )
            if exact_id or exact_url:
                fragment: dict[str, str] = {}
                for key in id_fields:
                    item = node.get(key)
                    if isinstance(item, (str, int)) and str(item) == note_id:
                        fragment[key] = str(item)
                for key in access_fields:
                    item = node.get(key)
                    if isinstance(item, (str, int, float, bool)):
                        fragment[key] = str(item)
                if exact_url:
                    fragment["url"] = sanitize_capture_url(
                        raw_url, target_note_id=note_id
                    )
                has_access_material = bool(access_fields.intersection(fragment)) or (
                    "url" in fragment
                    and any(
                        key in dict(parse_qsl(urlsplit(fragment["url"]).query))
                        for key in {"xsec_token", "xsec_source"}
                    )
                )
                signature = tuple(sorted(fragment.items()))
                if has_access_material and signature not in seen:
                    seen.add(signature)
                    found.append(fragment)
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    return found


def drain_access_responses(
    recorder: Recorder,
    responses: list[Any],
    start: int,
    note_id: str,
) -> int:
    """Consume completed allowlisted payloads outside Playwright callbacks."""
    end = len(responses)
    for response in responses[start:end]:
        try:
            fragments = access_material_for_note(response.json(), note_id)
        except Exception:  # noqa: BLE001 - keep details out of local evidence
            recorder.emit(
                "network.target_access_material.unreadable",
                {
                    "request_url": sanitize_capture_url(
                        response.url, target_note_id=note_id
                    )
                },
            )
            continue
        if fragments:
            recorder.emit(
                "network.target_access_material",
                {
                    "request_url": sanitize_capture_url(
                        response.url, target_note_id=note_id
                    ),
                    "fragments": fragments,
                },
            )
    return end


def wait_for_detail_page(
    context: Any,
    original_page: Any,
    pages_before: set[Any],
    note_id: str,
    timeout_ms: int,
) -> Any:
    """Wait within the policy timeout for an approved detail URL."""
    deadline = time.monotonic() + timeout_ms / 1000
    latest = original_page
    while time.monotonic() < deadline:
        new_pages = [item for item in context.pages if item not in pages_before]
        candidates = [*new_pages, original_page]
        for candidate in candidates:
            try:
                if allowed_note_url(candidate.url, note_id):
                    return candidate
                latest = candidate
            except Exception:  # noqa: BLE001 - a popup may close during inspection
                continue
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        original_page.wait_for_timeout(min(250, remaining_ms))
    return latest


def wait_for_detail_state(page: Any, note_id: str, timeout_ms: int) -> bool:
    """Wait for detail-specific state instead of sampling after a fixed delay."""
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        try:
            if bool(page.evaluate(DETAIL_STATE_PROBE, note_id)):
                return True
        except Exception:  # noqa: BLE001 - navigation may still be settling
            pass
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        page.wait_for_timeout(min(250, remaining_ms))
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-file", default=None)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--notes-file", default=str(CONFIG_DIR / "notes.yaml"))
    parser.add_argument("--note-id", required=True)
    parser.add_argument("--query-index", type=int, default=0)
    parser.add_argument("--output", default=None)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    try:
        if not SAFE_ID.fullmatch(args.note_id):
            raise ConfigError("note-id contains unsupported characters")
        account = find_account(load_accounts_file(args.accounts_file), args.account_id)
        marker = validate_profile_marker(account)
        profile_bound = bool(marker.get("identity_sha256"))
        sample = load_public_sample(Path(args.notes_file), args.note_id)
        queries = [str(value).strip() for value in sample["search_queries"] if str(value).strip()]
        if not 0 <= args.query_index < len(queries):
            raise ConfigError(f"query-index must be between 0 and {len(queries) - 1}")
        query = queries[args.query_index]
        policy = load_request_policy()
        output = Path(args.output) if args.output else (
            DATA_DIR / "captures" / f"{args.account_id}_{args.note_id}_{run_ts()}.jsonl"
        )
        if not output.is_absolute():
            output = DATA_DIR / "captures" / output.name
        output = require_path_below(output, DATA_DIR / "captures", "capture output")
    except (ConfigError, OSError) as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    print(
        f"account={args.account_id} note={args.note_id} "
        f"query_chars={len(query)} capture_file={output} "
        f"profile_binding={'OK' if profile_bound else 'PENDING'}"
    )
    if not args.execute:
        print("dry-run: profile not opened and no platform request made")
        return 0
    if not profile_bound:
        print("capture rejected: capture requires an identity-bound profile", file=sys.stderr)
        return 1
    if not args.yes:
        print("refusing online capture: --execute requires --yes", file=sys.stderr)
        return 2

    recorder = None
    context = None
    operation_lock = None
    blocked_statuses: list[int] = []
    detail_document_statuses: list[int] = []
    access_responses: list[Any] = []
    drained_access_responses = 0
    click_started = False
    try:
        operation_lock = ExperimentLock()
        operation_lock.__enter__()
        reserve_daily_attempt(
            args.account_id,
            "capture",
            int(policy["max_capture_runs_per_account_per_day"]),
        )
        delay = random.uniform(
            float(policy.get("min_delay_seconds", 5)),
            float(policy.get("max_delay_seconds", 15)),
        )
        timeout_ms = int(float(policy["default_timeout_seconds"]) * 1000)
        print(f"waiting {delay:.1f}s before search")
        time.sleep(delay)
        recorder = Recorder(output)
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                account["profile_dir"],
                channel="chrome",
                headless=not args.headed,
                user_agent=account.get("user_agent") or None,
            )
            neutralize_existing_pages(context)
            validate_profile_session(context, account)

            def on_request(request: Any) -> None:
                recorder.emit(
                    "network.request",
                    {
                        "request_url": sanitize_capture_url(
                            request.url, target_note_id=args.note_id
                        ),
                        "method": request.method,
                        "headers": sanitize_record_headers(
                            dict(request.headers), note_id=args.note_id
                        ),
                        "resource_type": request.resource_type,
                    },
                )

            def on_response(response: Any) -> None:
                if is_session_risk_response(response):
                    blocked_statuses.append(response.status)
                if (
                    click_started
                    and response.request.resource_type == "document"
                    and allowed_note_url(response.url, args.note_id)
                ):
                    detail_document_statuses.append(response.status)
                recorder.emit(
                    "network.response",
                    {
                        "request_url": sanitize_capture_url(
                            response.url, target_note_id=args.note_id
                        ),
                        "status": response.status,
                        "headers": sanitize_record_headers(
                            dict(response.headers), note_id=args.note_id
                        ),
                    },
                )
                if is_capture_payload_response(response):
                    access_responses.append(response)

            def browser_event(kind: str, data: Any) -> None:
                payload = sanitize_browser_event(str(kind), data, note_id=args.note_id)
                if payload is not None:
                    recorder.emit("browser." + str(kind), payload)

            context.on("request", on_request)
            context.on("response", on_response)
            context.add_init_script(HOOK_SCRIPT)
            page = context.new_page()
            page.expose_function("__xsecRecordEvent", browser_event)

            search_url = SEARCH_URL + "?" + urlencode({"keyword": query})
            response = page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            recorder.emit(
                "search.loaded",
                {"status": response.status if response else None, "query_chars": len(query)},
            )
            search_error = search_document_verdict(response.status if response else None)
            if search_error:
                recorder.emit("stop", {"reason": search_error})
                print(f"result={search_error}", file=sys.stderr)
                return 1
            page.wait_for_timeout(int(policy.get("search_settle_seconds", 5)) * 1000)
            if blocked_statuses or page_has_risk_notice(page) or page_has_visible_challenge(page):
                recorder.emit(
                    "stop",
                    {
                        "reason": "risk_or_block",
                        "statuses": blocked_statuses,
                    },
                )
                print("capture stopped: risk/block signal", file=sys.stderr)
                return 1

            drained_access_responses = drain_access_responses(
                recorder,
                access_responses,
                drained_access_responses,
                args.note_id,
            )

            match = exact_note_href(page, args.note_id)
            for _ in range(int(policy.get("max_search_scrolls_per_run", 3))):
                if match:
                    break
                page.mouse.wheel(0, 900)
                page.wait_for_timeout(1_500)
                match = exact_note_href(page, args.note_id)
            if not match:
                recorder.emit("discovery.miss", {"note_id": args.note_id})
                print("result=NOT_DISCOVERABLE")
                return 1

            candidate, href = match
            recorder.emit(
                "discovery.match",
                {
                    "note_id": args.note_id,
                    "href": sanitize_capture_url(href, target_note_id=args.note_id),
                },
            )
            pages_before = set(context.pages)
            click_started = True
            candidate.click(timeout=min(timeout_ms, 15_000))
            detail_page = wait_for_detail_page(
                context,
                page,
                pages_before,
                args.note_id,
                timeout_ms,
            )
            final_url = detail_page.url
            recorder.emit(
                "navigation.final_state",
                {
                    "final_url": sanitize_capture_url(
                        final_url, target_note_id=args.note_id
                    ),
                    "note_id": args.note_id,
                },
            )
            if (
                blocked_statuses
                or page_has_risk_notice(detail_page)
                or page_has_visible_challenge(detail_page)
            ):
                recorder.emit(
                    "stop",
                    {
                        "reason": "risk_or_block",
                        "statuses": blocked_statuses,
                    },
                )
                print("capture stopped: risk/block signal", file=sys.stderr)
                return 1
            drained_access_responses = drain_access_responses(
                recorder,
                access_responses,
                drained_access_responses,
                args.note_id,
            )
            has_detail_state = (
                wait_for_detail_state(detail_page, args.note_id, timeout_ms)
                if allowed_note_url(final_url, args.note_id)
                else False
            )
            drained_access_responses = drain_access_responses(
                recorder,
                access_responses,
                drained_access_responses,
                args.note_id,
            )
            if (
                blocked_statuses
                or page_has_risk_notice(detail_page)
                or page_has_visible_challenge(detail_page)
            ):
                recorder.emit(
                    "stop",
                    {"reason": "risk_or_block", "statuses": blocked_statuses},
                )
                print("capture stopped: risk/block signal", file=sys.stderr)
                return 1
            verdict = detail_verdict(
                final_url,
                args.note_id,
                detail_document_statuses,
                has_detail_state,
                page_has_not_found_notice(detail_page),
            )
            recorder.emit(
                "detail.assessment",
                {
                    "verdict": verdict,
                    "document_statuses": detail_document_statuses,
                    "has_detail_state": has_detail_state,
                },
            )
            if verdict != "OPENED":
                print(f"result={verdict}", file=sys.stderr)
                return 1
            print(f"result=OPENED final_url={redact_url(final_url)}")
            return 0
    except FileExistsError:
        print(f"capture already exists: {output}", file=sys.stderr)
        return 2
    except ConfigError as exc:
        print(f"capture rejected: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - suppress credential-bearing details
        print(f"capture error: {type(exc).__name__}", file=sys.stderr)
        return 1
    finally:
        if context is not None:
            try:
                context.close()
            except Exception:  # noqa: BLE001 - Playwright may already be stopped
                pass
        if recorder is not None:
            recorder.close()
        if operation_lock is not None:
            operation_lock.__exit__(None, None, None)


if __name__ == "__main__":
    raise SystemExit(main())
