"""Allowlisted failure evidence, never raw upstream messages or header values."""
from __future__ import annotations

import json
import time
from typing import Any

import httpx

MAX_DIAGNOSTIC_BYTES = 16 * 1024
MAX_MESSAGE_CHARS = 2048
DIAGNOSTIC_READ_BUDGET_SECONDS = 2.0
MESSAGE_HINTS = (
    ("captcha_hint", ("captcha", "验证码")),
    ("security_verification_hint", ("security verification", "安全验证")),
    ("device_verification_hint", ("device verification", "设备验证")),
    ("rate_limit_hint", ("访问频繁", "too many requests", "rate limit")),
    ("login_hint", ("请登录", "未登录", "登录失效", "login required", "session expired")),
)


def safe_api_code(payload: Any) -> int | None:
    code = payload.get("code") if isinstance(payload, dict) else None
    # Do not turn arbitrary strings, booleans, or very large numeric IDs into codes.
    return code if type(code) is int and -(2 ** 31) <= code < 2 ** 31 else None


def content_type_kind(response: httpx.Response) -> str:
    media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type == "application/json" or (media_type.startswith("application/") and media_type.endswith("+json")):
        return "json"
    if media_type == "text/html":
        return "html"
    if media_type.startswith("text/"):
        return "text"
    return "other" if media_type else "missing"


def response_metadata(response: httpx.Response, body_state: str, payload: Any = None) -> dict[str, Any]:
    """Callers supply a fixed body_state; no upstream string is returned."""
    messages = []
    if isinstance(payload, dict):
        for key in ("msg", "message"):
            value = payload.get(key)
            if isinstance(value, str):
                messages.append(value[:MAX_MESSAGE_CHARS].lower())
    flags = [name for name, phrases in MESSAGE_HINTS
             if any(phrase in message for message in messages for phrase in phrases)]
    result: dict[str, Any] = {"diagnostics": {
        "verifytype_present": "verifytype" in response.headers,
        "verifyuuid_present": "verifyuuid" in response.headers,
        "content_type": content_type_kind(response),
        "body_state": body_state,
        "message_flags": flags,
    }}
    code = safe_api_code(payload)
    if code is not None:
        result["api_code"] = code
    return result


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("NON_JSON_CONSTANT")


def failed_response_metadata(response: httpx.Response, timeout_seconds: float) -> dict[str, Any]:
    """Best-effort evidence only; failures here cannot change the known HTTP stop.

    Read at most 16 KiB of unencoded JSON. The short wall budget is checked
    between raw chunks; individual reads remain bounded by httpx's read timeout
    and the runner's existing overall deadline. Never decompress error bodies.
    """
    if content_type_kind(response) != "json":
        return response_metadata(response, "non_json")
    if response.headers.get("content-encoding", "").strip().lower() not in ("", "identity"):
        return response_metadata(response, "encoded_body_skipped")
    content = bytearray()
    deadline = time.monotonic() + min(timeout_seconds, DIAGNOSTIC_READ_BUDGET_SECONDS)
    try:
        chunks = (response.content,) if response.is_stream_consumed else response.iter_raw()
        for chunk in chunks:
            if time.monotonic() > deadline:
                return response_metadata(response, "timeout")
            if len(content) + len(chunk) > MAX_DIAGNOSTIC_BYTES:
                return response_metadata(response, "too_large")
            content.extend(chunk)
        if time.monotonic() > deadline:
            return response_metadata(response, "timeout")
    except httpx.TimeoutException:
        return response_metadata(response, "timeout")
    except Exception:
        return response_metadata(response, "read_error")
    try:
        payload = json.loads(content, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        return response_metadata(response, "invalid_json")
    if not isinstance(payload, dict):
        return response_metadata(response, "non_object_json")
    return response_metadata(response, "json_object", payload)
