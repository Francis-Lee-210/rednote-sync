"""Bounded HTTP Cookie experiment; credentials and responses stay in memory.

By default only the three fixed read operations below can be sent. Request signing uses
xhshow locally; no browser, external signing service, retry or login fallback.
The separate capability probe overrides the operation gate for two fixed GETs.
See protocol-method.md for fixed-version provenance and interpretation limits.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
import time
from importlib.metadata import version
from typing import Any

import httpx

from common import ConfigError, parse_cookie_header
from protocol_diagnostics import failed_response_metadata, response_metadata, safe_api_code
from protocol_signer_config import build_signer_config

API_ORIGIN = "https://edith.xiaohongshu.com"
WEB_ORIGIN = "https://www.xiaohongshu.com"
IDENTITY_PATH = "/api/sns/web/v2/user/me"
SEARCH_PATH = "/api/sns/web/v1/search/notes"
DETAIL_PATH = "/api/sns/web/v1/feed"
READ_OPERATIONS = {("GET", IDENTITY_PATH), ("POST", SEARCH_PATH), ("POST", DETAIL_PATH)}
SIGNER_VERSION = "0.2.0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_REQUESTS = 3
COOKIE_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$")


class ProtocolError(ConfigError):
    """Only fixed classification codes, never upstream messages or response bodies."""


def cookie_fields(header: str) -> dict[str, str]:
    if not isinstance(header, str) or any(ord(char) < 0x20 or ord(char) == 0x7F for char in header):
        raise ProtocolError("COOKIE_FIELDS_INVALID")
    fields = {item["name"]: item["value"] for item in parse_cookie_header(header)}
    if not fields.get("a1") or not fields.get("web_session"):
        raise ProtocolError("COOKIE_FIELDS_MISSING")
    if any(
        not COOKIE_NAME.fullmatch(name)
        or any(ord(char) < 0x21 or ord(char) > 0x7E for char in value)
        for name, value in fields.items()
    ):
        raise ProtocolError("COOKIE_FIELDS_INVALID")
    return fields


class LocalSigner:
    def _operation_allowed(self, method: str, path: str) -> bool:
        return (method, path) in READ_OPERATIONS

    def __init__(self, user_agent: str = "") -> None:
        from xhshow import SessionManager, Xhshow

        if version("xhshow") != SIGNER_VERSION:
            raise ProtocolError("SIGNER_VERSION_MISMATCH")
        try:
            config = build_signer_config(user_agent)
        except ValueError as exc:
            reason = str(exc)
            if reason not in {"SIGNER_UA_INVALID", "SIGNER_UA_UNSUPPORTED", "SIGNER_UA_PLATFORM_CONFLICT"}:
                reason = "SIGNER_UA_INVALID"
            raise ProtocolError(reason) from None
        self.user_agent = config.PUBLIC_USERAGENT
        self._signer = Xhshow(config)
        self._session = SessionManager(config)

    def headers(self, method: str, path: str, cookies: dict[str, str], payload: Any) -> dict[str, str]:
        if not self._operation_allowed(method, path):
            raise ProtocolError("REQUEST_NOT_ALLOWED")
        try:
            if method == "GET":
                headers = self._signer.sign_headers_get(
                    path, cookies, session=self._session, sign_format="xys"
                )
            else:
                headers = self._signer.sign_headers_post(
                    path, cookies, payload=payload, session=self._session,
                    sign_format="xys", x_rap=True,
                )
        except Exception:
            raise ProtocolError("SIGNING_FAILED") from None
        if not all(headers.get(key) for key in ("x-s", "x-t", "x-s-common")):
            raise ProtocolError("SIGNATURE_HEADERS_MISSING")
        return headers


def api_data(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProtocolError("API_SCHEMA_UNRECOGNIZED")
    code = payload.get("code")
    if code is not None and type(code) is not int:
        raise ProtocolError("API_SCHEMA_UNRECOGNIZED")
    if code == -100:
        raise ProtocolError("SESSION_EXPIRED")
    if code == 300015:
        raise ProtocolError("SIGNATURE_REJECTED")
    if code == 300012:
        raise ProtocolError("IP_BLOCKED")
    # Inspect only error/challenge metadata, not user-generated note text.
    message = str(payload.get("msg", payload.get("message", ""))).lower()
    if any(word in message for word in ("captcha", "验证码", "安全验证", "设备验证", "访问频繁")):
        raise ProtocolError("CHALLENGE_REQUIRED")
    if payload.get("success") is not True or code not in (None, 0):
        raise ProtocolError("API_REJECTED")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ProtocolError("API_SCHEMA_UNRECOGNIZED")
    return data


def authenticated_digest(data: dict[str, Any]) -> str:
    if data.get("guest") is True:
        raise ProtocolError("GUEST_SESSION")
    if data.get("guest") is not False:
        raise ProtocolError("IDENTITY_UNCONFIRMED")
    provided_ids = [data[key] for key in ("user_id", "userId") if key in data]
    if len(provided_ids) == 2 and provided_ids[0] != provided_ids[1]:
        raise ProtocolError("IDENTITY_CONFLICT")
    user_id = data.get("user_id") or data.get("userId")
    if (
        not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in user_id)
    ):
        raise ProtocolError("IDENTITY_UNCONFIRMED")
    return hashlib.sha256(user_id.strip().encode("utf-8")).hexdigest()


class ProtocolSession:
    def _operation_allowed(self, method: str, path: str) -> bool:
        return (method, path) in READ_OPERATIONS

    def __init__(
        self, account: dict[str, Any], policy: dict[str, Any], *,
        transport: httpx.BaseTransport | None = None, signer: Any = None,
    ) -> None:
        self._cookie_header = account.get("cookie", "")
        self._cookies = cookie_fields(self._cookie_header)
        self._signer = signer or LocalSigner(account.get("user_agent") or "")
        self._policy = policy
        self._http = httpx.Client(
            timeout=float(policy["default_timeout_seconds"]), follow_redirects=False,
            trust_env=False, transport=transport, verify=True,
        )
        self.events: list[dict[str, Any]] = []
        self._stopped = False
        self._identity_verified = False
        self._search_data: dict[str, Any] | None = None

    def close(self) -> None:
        self._http.close()
        self._cookies.clear()
        self._cookie_header = ""
        self._stopped = True

    def _request(self, method: str, path: str, payload: Any = None) -> dict[str, Any]:
        if self._stopped:
            raise ProtocolError("SESSION_STOPPED")
        if not self._operation_allowed(method, path) or (method == "GET" and payload is not None):
            self._stopped = True
            raise ProtocolError("REQUEST_NOT_ALLOWED")
        if len(self.events) >= MAX_REQUESTS:
            self._stopped = True
            raise ProtocolError("REQUEST_BUDGET_EXHAUSTED")
        # Query parameters can contain identity or access material in a probe.
        event: dict[str, Any] = {"method": method, "path": path.split("?", 1)[0], "result": "PENDING"}
        stop_reason = None
        try:
            time.sleep(random.uniform(
                self._policy["min_delay_seconds"], self._policy["max_delay_seconds"]
            ))
            signed = self._signer.headers(method, path, dict(self._cookies), payload)
            headers = {
                **signed,
                "Cookie": self._cookie_header,
                "User-Agent": self._signer.user_agent,
                "Origin": WEB_ORIGIN, "Referer": WEB_ORIGIN + "/",
                "Accept": "application/json", "Accept-Encoding": "identity",
                "Content-Type": "application/json;charset=UTF-8",
            }
            body = None if payload is None else json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            self.events.append(event)
            with self._http.stream(method, API_ORIGIN + path, headers=headers, content=body) as response:
                event["http_status"] = response.status_code
                if response.status_code in (403, 429, 461, 471):
                    stop_reason = "HTTP_RISK_STOP"
                elif response.status_code == 401:
                    stop_reason = "AUTH_REQUIRED"
                elif 300 <= response.status_code < 400:
                    stop_reason = "REDIRECT_REFUSED"
                elif not 200 <= response.status_code < 300:
                    stop_reason = "HTTP_ERROR"
                elif "verifytype" in response.headers or "verifyuuid" in response.headers:
                    stop_reason = "CHALLENGE_REQUIRED"
                if stop_reason:
                    # Stop before inspecting evidence; never dispatch another request.
                    self._stopped = True
                    event.update(response_metadata(response, "read_error"))
                    event.update(failed_response_metadata(response, float(self._policy["default_timeout_seconds"])))
                    raise ProtocolError(stop_reason)
                if "json" not in response.headers.get("content-type", "").lower():
                    event.update(response_metadata(response, "non_json"))
                    raise ProtocolError("NON_JSON_RESPONSE")
                content = bytearray()
                deadline = time.monotonic() + float(self._policy["default_timeout_seconds"])
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        event.update(response_metadata(response, "timeout"))
                        raise ProtocolError("RESPONSE_TIMEOUT")
                    if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                        event.update(response_metadata(response, "too_large"))
                        raise ProtocolError("RESPONSE_TOO_LARGE")
                    content.extend(chunk)
                try:
                    result = json.loads(content)
                except (ValueError, UnicodeError, RecursionError):
                    event.update(response_metadata(response, "invalid_json"))
                    raise ProtocolError("NON_JSON_RESPONSE") from None
                code = safe_api_code(result)
                if code is not None:
                    event["api_code"] = code
                try:
                    data = api_data(result)
                except ProtocolError:
                    event.update(response_metadata(response, "json_object" if isinstance(result, dict)
                                                   else "non_object_json", result))
                    raise
                event["result"] = "OK"
                return data
        except ProtocolError as exc:
            self._stopped = True
            event["result"] = stop_reason or str(exc)
            if stop_reason:
                raise ProtocolError(stop_reason) from None
            raise
        except Exception:
            self._stopped = True
            event["result"] = stop_reason or "TRANSPORT_ERROR"
            raise ProtocolError(event["result"]) from None
        finally:
            # Frozen input: do not silently incorporate Set-Cookie into this experiment.
            self._http.cookies.clear()

    def identity(self) -> str:
        if self.events:
            raise ProtocolError("IDENTITY_ALREADY_ATTEMPTED")
        try:
            digest = authenticated_digest(self._request("GET", IDENTITY_PATH))
        except ProtocolError:
            self._stopped = True
            raise
        self._identity_verified = True
        return digest

    def search(self, keyword: str) -> dict[str, Any]:
        if not self._identity_verified or len(self.events) != 1:
            raise ProtocolError("IDENTITY_REQUIRED_OR_SEARCH_ALREADY_ATTEMPTED")
        number = (int(time.time() * 1000) << 64) + random.getrandbits(31)
        search_id = ""
        while number:
            number, digit = divmod(number, 36)
            search_id = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[digit] + search_id
        self._search_data = self._request("POST", SEARCH_PATH, {
            "keyword": keyword, "page": 1, "page_size": 20, "search_id": search_id,
            "sort": "general", "note_type": 0, "ext_flags": [], "geo": "",
            "filters": [
                {"tags": ["general"], "type": "sort_type"},
                {"tags": ["不限"], "type": "filter_note_type"},
                {"tags": ["不限"], "type": "filter_note_time"},
                {"tags": ["不限"], "type": "filter_note_range"},
                {"tags": ["不限"], "type": "filter_pos_distance"},
            ],
            "image_formats": ["jpg", "webp", "avif"],
        })
        return self._search_data

    def detail(self, material: dict[str, str]) -> dict[str, Any]:
        if not self._identity_verified or self._search_data is None or len(self.events) != 2:
            raise ProtocolError("SEARCH_REQUIRED_OR_DETAIL_ALREADY_ATTEMPTED")
        if material != access_material(self._search_data, material["note_id"]):
            raise ProtocolError("ACCESS_MATERIAL_NOT_FROM_THIS_SEARCH")
        return self._request("POST", DETAIL_PATH, {
            "source_note_id": material["note_id"],
            "xsec_token": material["xsec_token"], "xsec_source": material["xsec_source"],
            "image_formats": ["jpg", "webp", "avif"], "extra": {"need_body_topic": "1"},
        })


def access_material(data: dict[str, Any], note_id: str) -> dict[str, str]:
    items = data.get("items")
    if not isinstance(items, list):
        raise ProtocolError("SEARCH_SCHEMA_UNRECOGNIZED")
    matches: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        card = item.get("note_card", {})
        if not isinstance(card, dict):
            continue
        ids = {node[key] for node in (item, card) for key in ("id", "note_id")
               if isinstance(node.get(key), str) and node[key]}
        if note_id not in ids:
            continue
        if ids != {note_id}:
            raise ProtocolError("SEARCH_ID_CONFLICT")
        tokens = {node[key] for node in (item, card) for key in ("xsec_token", "xsecToken")
                  if isinstance(node.get(key), str) and node[key]}
        sources = {node[key] for node in (item, card) for key in ("xsec_source", "xsecSource")
                   if isinstance(node.get(key), str) and node[key]}
        if len(tokens) != 1 or len(sources) > 1:
            raise ProtocolError("ACCESS_MATERIAL_INCOMPLETE_OR_CONFLICTING")
        token = tokens.pop()
        source = next(iter(sources), "pc_search")
        if len(token) > 4096 or len(source) > 128 or any(
            ord(char) < 0x21 or ord(char) > 0x7E for char in token + source
        ):
            raise ProtocolError("ACCESS_MATERIAL_INVALID")
        matches.append({
            "note_id": note_id, "xsec_token": token, "xsec_source": source,
            "source_origin": "response" if sources else "search_context",
        })
    if not matches:
        raise ProtocolError("NOT_DISCOVERABLE_FIRST_PAGE")
    if any(item != matches[0] for item in matches[1:]):
        raise ProtocolError("ACCESS_MATERIAL_CONFLICT")
    return matches[0]


def require_detail(data: dict[str, Any], note_id: str) -> None:
    items = data.get("items")
    if not isinstance(items, list):
        raise ProtocolError("DETAIL_UNCONFIRMED")
    for item in items:
        if not isinstance(item, dict):
            continue
        card = item.get("note_card")
        if not isinstance(card, dict) or card.get("note_id") != note_id:
            continue
        if item.get("id", note_id) != note_id:
            raise ProtocolError("DETAIL_ID_MISMATCH")
        if card.get("type") not in {"normal", "video"}:
            continue
        has_text = isinstance(card.get("desc"), str) and bool(card["desc"].strip())
        images = card.get("image_list")
        has_media = (
            isinstance(images, list) and any(isinstance(item, dict) and item for item in images)
        ) or (isinstance(card.get("video"), dict) and bool(card["video"]))
        if has_text or has_media:
            return
    raise ProtocolError("DETAIL_UNCONFIRMED")
