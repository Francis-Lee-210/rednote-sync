"""Offline signer-configuration tests using only synthetic browser metadata."""
from __future__ import annotations

import copy
from dataclasses import asdict
import sys
import unittest
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

from xhshow import CryptoConfig, SessionManager, Xhshow

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import protocol_session as protocol
from protocol_signer_config import build_signer_config

MAC_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
)
WINDOWS_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)


class ProtocolSignerConfigTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(version("xhshow"), "0.2.0")
        for target in (
            "socket.socket.connect", "socket.socket.connect_ex", "socket.getaddrinfo",
        ):
            guard = patch(target, side_effect=AssertionError("network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def test_local_signer_mac_ua_matches_both_signature_platforms(self):
        # Wrap, rather than replace, the real installed signer constructor.
        with patch("xhshow.Xhshow", wraps=Xhshow) as constructor:
            signer = protocol.LocalSigner(MAC_UA)
        config = constructor.call_args.args[0]
        self.assertEqual(signer.user_agent, MAC_UA)
        self.assertEqual(config.SIGNATURE_DATA_TEMPLATE["x2"], "macOS")
        self.assertEqual(config.SIGNATURE_XSCOMMON_TEMPLATE["x2"], "macOS")

    def test_empty_override_preserves_all_pinned_library_defaults(self):
        self.assertEqual(asdict(build_signer_config()), asdict(CryptoConfig()))

    def test_platform_override_changes_only_ua_and_two_platform_fields(self):
        original = asdict(CryptoConfig())
        for user_agent, platform in ((MAC_UA, "macOS"), (WINDOWS_UA, "Windows")):
            with self.subTest(platform=platform):
                actual = asdict(build_signer_config(user_agent))
                expected = copy.deepcopy(original)
                expected["PUBLIC_USERAGENT"] = user_agent
                expected["SIGNATURE_DATA_TEMPLATE"]["x2"] = platform
                expected["SIGNATURE_XSCOMMON_TEMPLATE"]["x2"] = platform
                self.assertEqual(actual, expected)

    def test_instances_and_library_defaults_do_not_share_templates(self):
        original = asdict(CryptoConfig())
        mac = build_signer_config(MAC_UA)
        windows = build_signer_config(WINDOWS_UA)
        later_mac = build_signer_config(MAC_UA)
        mac.SIGNATURE_DATA_TEMPLATE["x2"] = "synthetic mutation"
        mac.SIGNATURE_XSCOMMON_TEMPLATE["x2"] = "synthetic mutation"
        self.assertEqual(windows.SIGNATURE_DATA_TEMPLATE["x2"], "Windows")
        self.assertEqual(windows.SIGNATURE_XSCOMMON_TEMPLATE["x2"], "Windows")
        self.assertEqual(later_mac.SIGNATURE_DATA_TEMPLATE["x2"], "macOS")
        self.assertEqual(later_mac.SIGNATURE_XSCOMMON_TEMPLATE["x2"], "macOS")
        self.assertEqual(asdict(CryptoConfig()), original)
        self.assertEqual(asdict(build_signer_config()), original)

    def test_invalid_header_values_fail_without_echoing_input(self):
        for user_agent in (None, False, 1, " ", " " + MAC_UA, MAC_UA + "\r\nsecret", "隐私", "x" * 513):
            with self.subTest(kind=type(user_agent).__name__):
                with self.assertRaisesRegex(ValueError, "^SIGNER_UA_INVALID$"):
                    build_signer_config(user_agent)

    def test_unknown_and_mobile_platforms_fail_instead_of_using_windows(self):
        for user_agent in (
            "synthetic-agent",
            MAC_UA.replace("Macintosh; Intel Mac OS X 10_15_7", "X11; Linux x86_64"),
            MAC_UA.replace("Macintosh; Intel Mac OS X 10_15_7", "Linux; Android 15"),
            MAC_UA.replace("Macintosh; Intel Mac OS X 10_15_7", "iPhone; CPU iPhone OS 18_0 like Mac OS X"),
            MAC_UA.replace("Chrome/142.0.0.0", "Version/18.0"),
            MAC_UA.replace("Macintosh; Intel Mac OS X 10_15_7", "unknown desktop"),
            WINDOWS_UA.replace("Windows NT 10.0", "Windows"),
            WINDOWS_UA.replace("Win64; x64", "unknown-platform"),
            MAC_UA.replace("Macintosh; Intel", "Macintosh; unknown; Intel"),
        ):
            with self.subTest(case=user_agent.split(" ", 1)[0]):
                with self.assertRaisesRegex(ValueError, "^SIGNER_UA_UNSUPPORTED$"):
                    build_signer_config(user_agent)

    def test_conflicting_desktop_os_markers_fail_without_guessing(self):
        for user_agent in (
            MAC_UA.replace("Macintosh;", "Windows NT 10.0; Macintosh;"),
            WINDOWS_UA + " macOS",
        ):
            with self.assertRaisesRegex(ValueError, "^SIGNER_UA_PLATFORM_CONFLICT$"):
                build_signer_config(user_agent)

    def test_real_signer_accepts_both_configs_offline_without_switching_format(self):
        cookies = {"a1": "a" * 52, "web_session": "synthetic-session"}
        for user_agent in (MAC_UA, WINDOWS_UA):
            with self.subTest(platform="macOS" if "Macintosh" in user_agent else "Windows"):
                config = build_signer_config(user_agent)
                signer = Xhshow(config)
                session = SessionManager(config)
                headers = signer.sign_headers_get(
                    protocol.IDENTITY_PATH, cookies, session=session, sign_format="xys",
                )
                post_headers = signer.sign_headers_post(
                    protocol.SEARCH_PATH, cookies, payload={"keyword": "synthetic 中文"},
                    session=session, sign_format="xys", x_rap=True,
                )
                self.assertTrue(headers["x-s"].startswith("XYS_"))
                self.assertTrue(post_headers["x-s"].startswith("XYS_"))
                self.assertTrue(post_headers.get("x-rap-param"))


if __name__ == "__main__":
    unittest.main()
