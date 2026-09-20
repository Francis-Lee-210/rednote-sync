"""Shared helpers for the xsec-token experiment harness.

This module only reads local configuration and sanitizes printed output.
It never sends platform requests by itself.
"""
from __future__ import annotations

import fcntl
import json
import math
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import yaml

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
WORKSPACE_DIR = EXPERIMENT_DIR.parents[4]
DEFAULT_ACCOUNTS_FILE = Path.home() / ".rednote_test_accounts" / "accounts.json"
ALLOWED_ACCOUNT_SOURCES = {"self_registered"}
COOKIE_ORIGIN = "https://www.xiaohongshu.com/"

CONFIG_DIR = EXPERIMENT_DIR / "config"
DATA_DIR = EXPERIMENT_DIR / "data"
PROFILES_DIR = EXPERIMENT_DIR / "profiles"


class ConfigError(RuntimeError):
    """Raised when a local config is missing or violates this experiment's boundaries."""


class AttemptLimitReached(ConfigError):
    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_HEX = re.compile(r"^[a-fA-F0-9]{64}$")
REQUEST_POLICY_DEFAULTS: dict[str, int | float] = {
    "min_delay_seconds": 5.0,
    "max_delay_seconds": 15.0,
    "max_login_attempts_per_account_per_day": 3,
    "max_capture_runs_per_account_per_day": 3,
    "max_search_scrolls_per_run": 3,
    "search_settle_seconds": 5.0,
    "default_timeout_seconds": 45.0,
}
REQUEST_POLICY_MAXIMUMS: dict[str, int | float] = {
    "min_delay_seconds": 15.0,
    "max_delay_seconds": 15.0,
    "max_login_attempts_per_account_per_day": 3,
    "max_capture_runs_per_account_per_day": 3,
    "max_search_scrolls_per_run": 3,
    "search_settle_seconds": 5.0,
    "default_timeout_seconds": 45.0,
}


class ExperimentLock:
    """Prevent concurrent online operations across all experiment accounts."""

    def __init__(self) -> None:
        self._file = None

    def __enter__(self) -> "ExperimentLock":
        ensure_local_dir(DATA_DIR, mode=0o700)
        lock_path = DATA_DIR / ".online-operation.lock"
        self._file = lock_path.open("a+", encoding="utf-8")
        lock_path.chmod(0o600)
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._file.close()
            self._file = None
            raise ConfigError("another experiment online operation is already running") from exc
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._file is None:
            return
        fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        self._file.close()
        self._file = None


def reserve_daily_attempt(account_id: str, category: str, maximum: int) -> int:
    """Atomically reserve a login/capture attempt in an append-only daily ledger."""
    if not SAFE_ID.fullmatch(account_id):
        raise ConfigError("invalid account id for attempt ledger")
    if category not in {"login", "capture"}:
        raise ConfigError("invalid attempt ledger category")
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
        raise ConfigError("attempt limit must be a positive integer")
    ledger_dir = ensure_local_dir(DATA_DIR / "attempts", mode=0o700)
    day = datetime.now().date().isoformat()
    ledger = ledger_dir / f"{day}_{account_id}_{category}.jsonl"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(ledger, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "r+", encoding="utf-8") as stream:
            descriptor = -1
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            records = []
            for line_no, line in enumerate(stream, 1):
                if not line.strip():
                    raise ConfigError(f"attempt ledger has an empty line at {line_no}")
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ConfigError(f"attempt ledger is invalid at line {line_no}") from exc
                if not isinstance(record, dict):
                    raise ConfigError(f"attempt ledger is invalid at line {line_no}")
                records.append(record)
            if len(records) >= maximum:
                raise AttemptLimitReached(
                    category,
                    f"daily {category} attempt limit reached for {account_id}: "
                    f"{len(records)}/{maximum}"
                )
            stream.seek(0, os.SEEK_END)
            stream.write(
                json.dumps(
                    {"ts": utc_now(), "account_id": account_id, "category": category},
                    ensure_ascii=False,
                )
                + "\n"
            )
            stream.flush()
            os.fsync(stream.fileno())
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            return len(records) + 1
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_ts() -> str:
    """Filesystem-safe local timestamp for output file names."""
    return datetime.now().strftime("%Y%m%dT%H%M%S")


def redact_url(value: Any) -> str:
    """Return a URL with the complete query string removed from printed output."""
    parts = urlsplit(str(value))
    suffix = "?<redacted>" if parts.query else ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")) + suffix


def sanitize_capture_url(value: Any, target_note_id: str | None = None) -> str:
    """Keep access material only when the URL is tied to the approved target."""
    parts = urlsplit(str(value))
    try:
        port = parts.port
    except ValueError:
        port = None
    netloc = parts.hostname or ""
    if port is not None:
        netloc += f":{port}"
    allowed = {"note_id", "xsec_source", "xsec_token", "xsec_version"}
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    path_parts = [part for part in parts.path.split("/") if part]
    associated = bool(
        target_note_id
        and (
            target_note_id in path_parts
            or any(key == "note_id" and item == target_note_id for key, item in pairs)
        )
    )
    query = urlencode(
        [
            (
                key,
                item
                if associated
                and key in allowed
                and (key != "note_id" or item == target_note_id)
                else "<redacted>",
            )
            for key, item in pairs
        ]
    )
    stable_paths = {
        "",
        "/",
        "/search_result",
        "/api/sns/web/v1/feed",
        "/api/sns/web/v1/search/notes",
        "/api/sns/web/v2/user/me",
    }
    target_path = f"/explore/{target_note_id}" if target_note_id else None
    path = parts.path if parts.path in stable_paths or parts.path == target_path else "/<redacted>"
    return urlunsplit((parts.scheme, netloc, path, query, ""))


def load_accounts_file(
    path: str | os.PathLike[str] | None = None, *, require_profile: bool = True
) -> list[dict[str, Any]]:
    """Load self-registered test accounts and enforce source boundaries."""
    account_path = Path(
        path
        or os.environ.get("XSEC_ACCOUNTS_FILE")
        or DEFAULT_ACCOUNTS_FILE
    )
    account_path = account_path.expanduser().resolve()
    if not account_path.exists():
        raise ConfigError(f"accounts file not found: {account_path}")
    if account_path == WORKSPACE_DIR or WORKSPACE_DIR in account_path.parents:
        raise ConfigError("real accounts file must be outside the Git workspace")
    try:
        permissions = stat.S_IMODE(account_path.stat().st_mode)
    except OSError as exc:
        raise ConfigError(f"cannot stat accounts file: {account_path}") from exc
    if permissions & 0o077:
        raise ConfigError("accounts file must be owner-only (chmod 600)")

    try:
        raw = json.loads(account_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigError(f"invalid accounts JSON: {account_path}") from exc

    accounts = raw["accounts"] if isinstance(raw, dict) and "accounts" in raw else raw
    if not isinstance(accounts, list) or not accounts:
        raise ConfigError(f"accounts file has no accounts: {account_path}")

    seen: set[str] = set()
    seen_profiles: set[Path] = set()
    allowed_account_fields = {
        "account_id",
        "label",
        "source",
        "cookie",
        "user_agent",
        "profile_dir",
        "expected_user_id_sha256",
    }
    for account in accounts:
        if not isinstance(account, dict):
            raise ConfigError(f"each account must be an object: {account_path}")
        unknown_fields = set(account) - allowed_account_fields
        if unknown_fields:
            raise ConfigError(f"unsupported account fields: {sorted(unknown_fields)}")
        account_id = str(account.get("account_id", "")).strip()
        if not account_id:
            raise ConfigError(f"account_id is required: {account_path}")
        if not SAFE_ID.fullmatch(account_id):
            raise ConfigError(
                f"account_id must use only letters, digits, dot, underscore, or dash: {account_id!r}"
            )
        if account_id in seen:
            raise ConfigError(f"duplicate account_id: {account_id}")
        seen.add(account_id)

        # Optional descriptive metadata; never used as an identity or path.
        if "label" in account:
            label = account["label"]
            if (
                not isinstance(label, str) or not label.strip() or len(label) > 64
                or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in label)
            ):
                raise ConfigError(
                    f"account {account_id}: label must be a non-empty string of at most 64 characters without controls"
                )

        source = str(account.get("source", "unknown")).lower()
        if source not in ALLOWED_ACCOUNT_SOURCES:
            raise ConfigError(
                f"account {account_id}: only source='self_registered' is allowed"
            )

        cookie = account.get("cookie")
        if cookie is not None and not isinstance(cookie, str):
            raise ConfigError(f"account {account_id}: cookie must be a string")
        if isinstance(cookie, str) and (
            len(cookie) > 65_536
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in cookie)
        ):
            raise ConfigError(f"account {account_id}: cookie is oversized or contains controls")
        user_agent = account.get("user_agent")
        if user_agent is not None and not isinstance(user_agent, str):
            raise ConfigError(f"account {account_id}: user_agent must be a string")
        if isinstance(user_agent, str) and (
            len(user_agent) > 512
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in user_agent)
        ):
            raise ConfigError(f"account {account_id}: user_agent is invalid")

        expected_digest = str(account.get("expected_user_id_sha256", "")).strip()
        if expected_digest and not SHA256_HEX.fullmatch(expected_digest):
            raise ConfigError(
                f"account {account_id}: expected_user_id_sha256 must be 64 hexadecimal characters"
            )
        account["expected_user_id_sha256"] = expected_digest.lower()

        profile_dir = account.get("profile_dir")
        if require_profile and (not isinstance(profile_dir, str) or not profile_dir.strip()):
            raise ConfigError(f"account {account_id}: profile_dir is required")
        if profile_dir is not None and not isinstance(profile_dir, str):
            raise ConfigError(f"account {account_id}: profile_dir must be a string")
        if profile_dir:
            profile_path = Path(profile_dir).expanduser()
            if not profile_path.is_absolute():
                profile_path = EXPERIMENT_DIR / profile_path
            profile_path = profile_path.resolve()
            if profile_path == PROFILES_DIR or PROFILES_DIR not in profile_path.parents:
                raise ConfigError(
                    f"account {account_id}: profile_dir must be below {PROFILES_DIR}"
                )
            if profile_path in seen_profiles:
                raise ConfigError(f"profile_dir is assigned to more than one account: {profile_path}")
            seen_profiles.add(profile_path)
            account["profile_dir"] = str(profile_path)

    return accounts


def find_account(accounts: list[dict[str, Any]], account_id: str) -> dict[str, Any]:
    for account in accounts:
        if account.get("account_id") == account_id:
            return account
    raise ConfigError(f"account not found: {account_id}")


def parse_cookie_header(cookie: str, url: str = COOKIE_ORIGIN) -> list[dict[str, str]]:
    """Convert a request Cookie header into exact-origin Playwright entries."""
    if cookie.lstrip().lower().startswith("cookie:"):
        raise ConfigError("cookie value must not include a Cookie: header prefix")
    parsed: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for part in cookie.split(";"):
        item = part.strip()
        if not item:
            continue
        if "=" not in item:
            raise ConfigError("cookie header contains a malformed field")
        name, _, value = item.partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            raise ConfigError("cookie header contains an empty name")
        if any(ord(char) < 0x20 or ord(char) == 0x7F for char in name + value):
            raise ConfigError("cookie header contains control characters")
        if name in seen_names:
            raise ConfigError(f"cookie header contains duplicate name: {name}")
        seen_names.add(name)
        parsed.append({"name": name, "value": value, "url": url, "secure": True})
    return parsed


def load_yaml_file(path: str | os.PathLike[str]) -> dict[str, Any]:
    yaml_path = Path(path)
    if not yaml_path.exists():
        raise ConfigError(f"yaml file not found: {yaml_path}")
    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ConfigError(f"invalid yaml file: {yaml_path}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"yaml root must be a mapping: {yaml_path}")
    return data


def load_policy() -> dict[str, Any]:
    path = CONFIG_DIR / "policy.yaml"
    if not path.exists():
        return {}
    return load_yaml_file(path)


def load_request_policy() -> dict[str, int | float]:
    """Load, strictly validate, and normalize every supported policy field."""
    raw = load_policy()
    unknown_root = set(raw) - {"request_policy"}
    if unknown_root:
        raise ConfigError(f"unsupported policy sections: {sorted(unknown_root)}")
    request = raw.get("request_policy", {})
    if not isinstance(request, dict):
        raise ConfigError("request_policy must be a mapping")
    unknown = set(request) - set(REQUEST_POLICY_DEFAULTS)
    if unknown:
        raise ConfigError(f"unsupported request_policy fields: {sorted(unknown)}")

    normalized: dict[str, int | float] = {}
    integer_fields = {
        "max_login_attempts_per_account_per_day",
        "max_capture_runs_per_account_per_day",
        "max_search_scrolls_per_run",
    }
    for key, default in REQUEST_POLICY_DEFAULTS.items():
        value = request.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"request_policy.{key} must be a numeric literal")
        if key in integer_fields:
            if not isinstance(value, int):
                raise ConfigError(f"request_policy.{key} must be an integer")
            normalized[key] = value
        else:
            numeric = float(value)
            if not math.isfinite(numeric):
                raise ConfigError(f"request_policy.{key} must be finite")
            normalized[key] = numeric

    if normalized["min_delay_seconds"] < 0:
        raise ConfigError("request_policy.min_delay_seconds must be non-negative")
    if normalized["max_delay_seconds"] < normalized["min_delay_seconds"]:
        raise ConfigError("request_policy.max_delay_seconds must be >= min_delay_seconds")
    if normalized["max_login_attempts_per_account_per_day"] < 1:
        raise ConfigError("request_policy.max_login_attempts_per_account_per_day must be >= 1")
    if normalized["max_capture_runs_per_account_per_day"] < 1:
        raise ConfigError("request_policy.max_capture_runs_per_account_per_day must be >= 1")
    if normalized["max_search_scrolls_per_run"] < 0:
        raise ConfigError("request_policy.max_search_scrolls_per_run must be non-negative")
    if normalized["search_settle_seconds"] < 0:
        raise ConfigError("request_policy.search_settle_seconds must be non-negative")
    if normalized["default_timeout_seconds"] <= 0:
        raise ConfigError("request_policy.default_timeout_seconds must be positive")
    for key, maximum in REQUEST_POLICY_MAXIMUMS.items():
        if normalized[key] > maximum:
            raise ConfigError(f"request_policy.{key} must be <= {maximum}")
    return normalized


def ensure_local_dir(path: Path, mode: int = 0o700) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(mode)
    except OSError:
        pass
    return path


def write_json_private(path: Path, data: dict[str, Any]) -> None:
    """Atomically replace a JSON file with an owner-only temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            pass
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def require_path_below(path: Path, root: Path, label: str) -> Path:
    """Resolve a path and reject attempts to escape its private runtime root."""
    resolved = path.expanduser().resolve()
    root_resolved = root.resolve()
    if resolved == root_resolved or root_resolved not in resolved.parents:
        raise ConfigError(f"{label} must be below {root_resolved}")
    return resolved


def sanitize_headers(
    headers: dict[str, Any],
    target_note_id: str | None = None,
) -> dict[str, str]:
    """Allowlist safe metadata and redact every unknown header value."""
    safe_names = {
        "accept",
        "cache-control",
        "content-length",
        "content-type",
        "expires",
        "pragma",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "vary",
    }
    url_names = {"referer", "location", "content-location"}
    sanitized: dict[str, str] = {}
    for key, value in headers.items():
        name = str(key)
        lowered = name.lower()
        if lowered in safe_names:
            sanitized[name] = str(value)
        elif lowered in url_names:
            sanitized[name] = sanitize_capture_url(value, target_note_id=target_note_id)
        else:
            sanitized[name] = "<redacted>"
    return sanitized
