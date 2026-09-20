"""Cookie-seeded persistent-session helpers for the xsec-token experiment."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from common import SHA256_HEX, ConfigError, parse_cookie_header, utc_now, write_json_private

USER_ME_URL = "https://www.xiaohongshu.com/api/sns/web/v2/user/me"
HOME_URL = "https://www.xiaohongshu.com/"
ALLOWED_XHS_HOSTS = {"xiaohongshu.com", "www.xiaohongshu.com"}
INVALID_SESSION_CODES = {-100}
SESSION_TIMEOUT_MS = 45_000
SESSION_SETTLE_MS = 5_000
VISIBLE_CHALLENGE_PROBE = """
() => {
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  };
  const selectors = [
    'iframe[src*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="redcaptcha" i]',
    '[class*="redcaptcha" i]'
  ];
  if (selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(visible))) {
    return true;
  }
  const messages = new Set(['验证码', '安全验证', '拖动滑块', '请完成验证']);
  return Array.from(document.querySelectorAll('[role="alert"], [role="alertdialog"]'))
    .some((element) => visible(element) && messages.has(element.innerText.trim()));
}
"""
VISIBLE_LOGIN_PROMPT_PROBE = """
() => {
  const labels = new Set(['扫码登录', '打开小红书App扫码登录', '手机号登录']);
  return Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="submit"], input[type="button"]'
  )).some((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const text = (element.innerText || element.value || '').trim();
    return labels.has(text)
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  });
}
"""


class IdentityResponseUnavailable(ConfigError):
    """The response cannot prove an identity but is not an explicit rejection."""


def identity_digest(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def profile_marker(profile_dir: str | Path) -> Path:
    return Path(profile_dir) / "experiment-account.json"


def read_profile_marker(profile_dir: str | Path) -> dict[str, Any]:
    path = profile_marker(profile_dir)
    if not path.exists():
        return {}
    if path.is_symlink():
        raise ConfigError(f"profile marker must not be a symbolic link: {path}")
    try:
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise ConfigError(f"profile marker must be an owned regular file: {path}")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ConfigError(f"profile marker must be owner-only (chmod 600): {path}")
        value = json.loads(path.read_text(encoding="utf-8"))
    except ConfigError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"invalid profile marker: {path}") from exc
    if not isinstance(value, dict):
        raise ConfigError(f"invalid profile marker: {path}")
    return value


def validate_profile_marker(account: dict[str, Any]) -> dict[str, Any]:
    """Validate the local binding marker before any browser is launched."""
    marker = read_profile_marker(account["profile_dir"])
    if not marker:
        return marker
    allowed = {
        "account_id",
        "source",
        "identity_sha256",
        "validated_at",
        "login_method",
    }
    unknown = set(marker) - allowed
    if unknown:
        raise ConfigError(f"profile marker has unsupported fields: {sorted(unknown)}")
    if marker.get("account_id") != account.get("account_id"):
        raise ConfigError("profile marker belongs to a different account label")
    digest = marker.get("identity_sha256")
    if not isinstance(digest, str) or not SHA256_HEX.fullmatch(digest):
        raise ConfigError("profile marker has an invalid identity digest")
    return marker


def parse_user_me(response: Any) -> str:
    """Return the authenticated user id, failing closed on unknown responses."""
    status = int(response.status)
    if status in (403, 429):
        raise ConfigError(f"user/me blocked with HTTP {status}; stop this account")
    if not 200 <= status < 300:
        raise ConfigError(f"user/me returned HTTP {status}")
    try:
        payload = response.json()
    except Exception as exc:  # noqa: BLE001 - external JSON is untrusted
        raise IdentityResponseUnavailable(
            f"user/me JSON body unavailable ({type(exc).__name__})"
        ) from exc
    if not isinstance(payload, dict):
        raise IdentityResponseUnavailable("user/me returned an unexpected payload")

    code = payload.get("code")
    success = payload.get("success")
    if code in INVALID_SESSION_CODES or success is False:
        raise ConfigError("cookie session is invalid or expired")
    if success is not True or (code is not None and code != 0):
        raise ConfigError("user/me did not return an explicit success result")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ConfigError("cookie session is not an authenticated account")
    guest = data.get("guest")
    if guest is True:
        raise ConfigError("cookie session is not an authenticated account")
    if guest not in (None, False):
        raise ConfigError("user/me returned an invalid guest flag")
    user_id = data.get("user_id") or data.get("userId")
    if not isinstance(user_id, str) or not user_id.strip():
        raise IdentityResponseUnavailable(
            "user/me did not provide a stable authenticated user id"
        )
    return user_id.strip()


def select_identity_digest(responses: list[Any]) -> str:
    """Select one consistent identity without letting unreadable tails mask it."""
    digests: set[str] = set()
    unavailable: list[IdentityResponseUnavailable] = []
    last_semantic: tuple[str, str | ConfigError] | None = None
    for response in responses:
        try:
            digest = identity_digest(parse_user_me(response))
        except IdentityResponseUnavailable as exc:
            unavailable.append(exc)
        except ConfigError as exc:
            last_semantic = ("error", exc)
        else:
            digests.add(digest)
            last_semantic = ("valid", digest)
    if len(digests) > 1:
        raise ConfigError("user/me returned more than one authenticated identity")
    if last_semantic is not None:
        kind, value = last_semantic
        if kind == "error":
            raise value
        return str(value)
    if unavailable:
        raise unavailable[-1]
    raise ConfigError("page did not provide a usable signed user/me response")


def is_user_me_response(response: Any) -> bool:
    parts = urlsplit(str(response.url))
    expected = urlsplit(USER_ME_URL)
    return (
        parts.scheme == "https"
        and parts.hostname in ALLOWED_XHS_HOSTS
        and parts.port in (None, 443)
        and parts.path == expected.path
    )


def is_signed_identity_response(response: Any) -> bool:
    """Accept only the page's JSON GET response, excluding same-path HTML/empty traffic."""
    if not is_user_me_response(response):
        return False
    request = getattr(response, "request", None)
    if str(getattr(request, "method", "")).upper() != "GET":
        return False
    if str(getattr(request, "resource_type", "")) not in {"xhr", "fetch"}:
        return False
    request_headers = {
        str(key).lower(): value
        for key, value in getattr(request, "headers", {}).items()
    }
    if not all(request_headers.get(name) for name in ("x-s", "x-t")):
        return False
    headers = getattr(response, "headers", {})
    content_type = str(headers.get("content-type", "")).lower()
    return "json" in content_type


def is_session_risk_response(response: Any) -> bool:
    """Return true only for hard HTTP stop signals, not preloaded login resources."""
    parts = urlsplit(str(response.url))
    return (
        parts.scheme == "https"
        and parts.hostname in ALLOWED_XHS_HOSTS
        and parts.port in (None, 443)
        and int(response.status) in (403, 429, 461)
    )


def page_has_visible_challenge(page: Any) -> bool:
    """Detect a rendered CAPTCHA/challenge rather than a background resource load."""
    try:
        return bool(page.evaluate(VISIBLE_CHALLENGE_PROBE))
    except Exception as exc:  # noqa: BLE001 - inability to verify fails closed
        raise ConfigError("could not verify whether a CAPTCHA is visible") from exc


def page_has_visible_login_prompt(page: Any) -> bool:
    """Identify an interactive login prompt that would replace, not verify, the Cookie."""
    try:
        return bool(page.evaluate(VISIBLE_LOGIN_PROMPT_PROBE))
    except Exception as exc:  # noqa: BLE001 - inability to verify fails closed
        raise ConfigError("could not verify whether a login prompt is visible") from exc


def page_has_visible_notice(page: Any, messages: tuple[str, ...]) -> bool:
    """Match an explicit visible status notice, never text inside the whole page."""
    try:
        notices = page.locator('[role="alert"], [role="alertdialog"]')
        for index in range(notices.count()):
            notice = notices.nth(index)
            if notice.is_visible() and notice.inner_text(timeout=2_000).strip() in messages:
                return True
        return False
    except Exception as exc:  # noqa: BLE001 - inspection failure is not a page verdict
        raise ConfigError("could not inspect a platform status notice") from exc


def neutralize_existing_pages(context: Any) -> None:
    """Leave one inert tab so closing restored tabs cannot terminate persistent Chrome."""
    pages = list(context.pages)
    if not pages:
        return
    keeper = pages[0]
    try:
        keeper.goto("about:blank", wait_until="domcontentloaded", timeout=SESSION_TIMEOUT_MS)
        for extra_page in pages[1:]:
            extra_page.close()
    except Exception as exc:  # noqa: BLE001 - an unusable context must fail closed
        raise ConfigError("could not prepare the persistent browser window") from exc


def validate_profile_session(
    context: Any,
    account: dict[str, Any],
    page: Any | None = None,
    manual_challenge_timeout_seconds: int = 0,
) -> str:
    """Validate through the site's own signed user/me request and enforce binding."""
    active_page = page or context.new_page()
    identity_responses: list[Any] = []
    risk_responses: list[Any] = []

    def on_response(response: Any) -> None:
        if is_signed_identity_response(response):
            identity_responses.append(response)
        if is_session_risk_response(response):
            risk_responses.append(response)

    active_page.on("response", on_response)
    try:
        navigation = active_page.goto(
            HOME_URL,
            wait_until="domcontentloaded",
            timeout=SESSION_TIMEOUT_MS,
        )
        if navigation is not None and not 200 <= int(navigation.status) < 300:
            raise ConfigError(f"homepage returned HTTP {navigation.status}")
        final_url = str(getattr(active_page, "url", "") or getattr(navigation, "url", ""))
        final_parts = urlsplit(final_url)
        if not (
            final_parts.scheme == "https"
            and final_parts.hostname in ALLOWED_XHS_HOSTS
            and final_parts.port in (None, 443)
        ):
            raise ConfigError("homepage navigation left the approved origin")
        active_page.wait_for_timeout(SESSION_SETTLE_MS)
        if risk_responses:
            statuses = sorted({int(response.status) for response in risk_responses})
            raise ConfigError(f"hard login/risk response observed; statuses={statuses}")
        if page_has_visible_login_prompt(active_page):
            raise ConfigError("visible QR/login prompt observed; Cookie did not establish a session")
        if page_has_visible_challenge(active_page):
            if manual_challenge_timeout_seconds <= 0:
                raise ConfigError("visible CAPTCHA or security challenge observed")
            print(
                "manual verification required: complete the visible challenge in the "
                f"Chrome window within {manual_challenge_timeout_seconds}s",
                flush=True,
            )
            challenge_cleared = False
            for _ in range(manual_challenge_timeout_seconds):
                active_page.wait_for_timeout(1_000)
                if risk_responses:
                    statuses = sorted({int(response.status) for response in risk_responses})
                    raise ConfigError(
                        f"hard login/risk response observed; statuses={statuses}"
                    )
                if not page_has_visible_challenge(active_page):
                    challenge_cleared = True
                    break
            if not challenge_cleared:
                raise ConfigError("manual CAPTCHA/security verification timed out")

            print("manual verification cleared; revalidating signed identity", flush=True)
            identity_responses.clear()
            navigation = active_page.goto(
                HOME_URL,
                wait_until="domcontentloaded",
                timeout=SESSION_TIMEOUT_MS,
            )
            if navigation is not None and not 200 <= int(navigation.status) < 300:
                raise ConfigError(f"homepage returned HTTP {navigation.status}")
            active_page.wait_for_timeout(SESSION_SETTLE_MS)
            if risk_responses:
                statuses = sorted({int(response.status) for response in risk_responses})
                raise ConfigError(f"hard login/risk response observed; statuses={statuses}")
            if page_has_visible_login_prompt(active_page):
                raise ConfigError(
                    "visible QR/login prompt observed; Cookie did not establish a session"
                )
            if page_has_visible_challenge(active_page):
                raise ConfigError("visible CAPTCHA or security challenge remained after manual verification")
        if not identity_responses:
            raise ConfigError("page did not issue a signed JSON user/me response")
        digest = select_identity_digest(identity_responses)
        marker = validate_profile_marker(account)
        for expected in (
            marker.get("identity_sha256"),
            account.get("expected_user_id_sha256"),
        ):
            if expected and expected != digest:
                raise ConfigError("authenticated identity does not match this account profile")
        return digest
    finally:
        try:
            active_page.close()
        except Exception:  # noqa: BLE001 - browser may already have closed the page
            pass


def seed_cookie_and_validate(
    context: Any,
    account: dict[str, Any],
    *,
    manual_challenge_timeout_seconds: int = 0,
) -> str:
    """Bootstrap device state, overlay the complete Cookie header, and validate it."""
    cookie = account.get("cookie")
    if not isinstance(cookie, str) or not cookie.strip():
        raise ConfigError(f"account {account['account_id']}: a complete cookie is required")
    context.clear_cookies()
    parsed = parse_cookie_header(cookie)
    if not parsed:
        raise ConfigError(f"account {account['account_id']}: cookie contains no fields")
    page = context.new_page()
    page.goto(HOME_URL, wait_until="domcontentloaded", timeout=SESSION_TIMEOUT_MS)
    context.add_cookies(parsed)
    try:
        return validate_profile_session(
            context,
            account,
            page=page,
            manual_challenge_timeout_seconds=manual_challenge_timeout_seconds,
        )
    except Exception:
        context.clear_cookies()
        raise


def persist_profile_binding(account: dict[str, Any], digest: str) -> None:
    marker = validate_profile_marker(account)
    marker.update(
        {
            "account_id": account["account_id"],
            "source": account.get("source"),
            "identity_sha256": digest,
            "validated_at": utc_now(),
            "login_method": "cookie_injection",
        }
    )
    write_json_private(profile_marker(account["profile_dir"]), marker)
