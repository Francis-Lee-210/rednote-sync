"""Consistent browser metadata for the experiment's pinned xhshow 0.2.0.

This maps a supported, explicitly supplied desktop UA to the two existing
platform fields. It does not observe a browser or emulate its device state.
The caller retains the dependency-version gate and chooses the signing format.

macOS template spelling follows the fixed reference configuration:
https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/constants.py#L8-L18
https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/signing.py#L18-L43
All other fields, including SDK versions, remain xhshow defaults.
"""
from __future__ import annotations

import copy
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xhshow import CryptoConfig


# Only desktop Chrome/Edge metadata has an established mapping in this
# experiment. Unknown browser/OS combinations fail instead of borrowing a
# Windows fingerprint. This is a syntax/configuration check, not authenticity.
_DESKTOP_CHROMIUM_UA = re.compile(
    r"Mozilla/5\.0 \((?P<platform>[^()]+)\) "
    r"AppleWebKit/[0-9]+(?:\.[0-9]+)* \(KHTML, like Gecko\) "
    r"Chrome/[0-9]+(?:\.[0-9]+)* Safari/[0-9]+(?:\.[0-9]+)*"
    r"(?: Edg/[0-9]+(?:\.[0-9]+)*)?"
)
_WINDOWS = re.compile(
    r"Windows NT [0-9]+(?:\.[0-9]+)*(?:; (?:Win64|WOW64|x64|x86|ARM64))*"
)
_MAC = re.compile(r"Macintosh; (?:Intel|PPC) Mac OS X [0-9]+(?:[_.][0-9]+)*")
_UNSUPPORTED_OS = re.compile(
    r"\b(?:Android|iPhone|iPad|iPod|Mobile|Linux|X11|CrOS|FreeBSD|OpenBSD|NetBSD)\b",
    re.IGNORECASE,
)


def _platform_for(user_agent: str) -> str:
    if (
        not isinstance(user_agent, str)
        or not user_agent
        or len(user_agent) > 512
        or user_agent != user_agent.strip()
        or any(ord(char) < 0x20 or ord(char) > 0x7E for char in user_agent)
    ):
        raise ValueError("SIGNER_UA_INVALID")

    windows = bool(re.search(r"\bWindows\b", user_agent, re.IGNORECASE))
    mac = bool(re.search(r"\b(?:Macintosh|Mac OS X|macOS)\b", user_agent, re.IGNORECASE))
    if windows and mac:
        raise ValueError("SIGNER_UA_PLATFORM_CONFLICT")

    match = _DESKTOP_CHROMIUM_UA.fullmatch(user_agent)
    if not match or _UNSUPPORTED_OS.search(user_agent):
        raise ValueError("SIGNER_UA_UNSUPPORTED")
    platform = match.group("platform")
    if windows and _WINDOWS.fullmatch(platform):
        return "Windows"
    if mac and _MAC.fullmatch(platform):
        return "macOS"
    raise ValueError("SIGNER_UA_UNSUPPORTED")


def build_signer_config(user_agent: str = "") -> CryptoConfig:
    """Return a fresh default config, or a consistent supported-UA override.

    Fixed ValueError reasons are safe to report; no input metadata is included.
    An empty string keeps the library's existing Windows/Edge configuration.
    """
    from xhshow import CryptoConfig

    config = CryptoConfig()
    if user_agent == "":
        return config
    platform = _platform_for(user_agent)
    data_template = copy.deepcopy(config.SIGNATURE_DATA_TEMPLATE)
    common_template = copy.deepcopy(config.SIGNATURE_XSCOMMON_TEMPLATE)
    data_template["x2"] = platform
    common_template["x2"] = platform
    return config.with_overrides(
        PUBLIC_USERAGENT=user_agent,
        SIGNATURE_DATA_TEMPLATE=data_template,
        SIGNATURE_XSCOMMON_TEMPLATE=common_template,
    )
