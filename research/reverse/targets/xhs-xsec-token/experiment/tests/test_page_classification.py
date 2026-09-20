"""Exercise page-state probes on isolated synthetic HTML; all requests are blocked."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from playwright.sync_api import sync_playwright

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from capture_visit import (  # noqa: E402
    page_has_not_found_notice,
    page_has_risk_notice,
    detail_verdict,
)
from common import ConfigError  # noqa: E402
from session import (  # noqa: E402
    page_has_visible_challenge,
    page_has_visible_login_prompt,
)


class PageClassificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(channel="chrome", headless=True)
        except Exception:
            cls.playwright.stop()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self) -> None:
        self.context = self.browser.new_context(service_workers="block")
        self.context.route("**/*", lambda route: route.abort())
        self.page = self.context.new_page()

    def tearDown(self) -> None:
        self.context.close()

    def test_author_text_is_not_a_platform_challenge_login_or_missing_note(self) -> None:
        self.page.set_content("""
            <article><h1>验证码、安全验证与登录问题说明</h1>
            <p>访问频繁、账号异常、账号已被限制、登录已过期、请先登录。</p>
            <p>扫码登录、打开小红书App扫码登录、手机号登录。</p>
            <p>拖动滑块、请完成验证。</p>
            <p>当前笔记暂时无法浏览、笔记不存在、页面不见了、内容不存在。</p></article>
        """)
        for probe in (page_has_risk_notice, page_has_visible_challenge,
                      page_has_visible_login_prompt, page_has_not_found_notice):
            with self.subTest(probe=probe.__name__):
                self.assertFalse(probe(self.page))
        self.assertEqual(detail_verdict(
            "https://www.xiaohongshu.com/explore/synthetic-note", "synthetic-note",
            [200], True, page_has_not_found_notice(self.page),
        ), "OPENED")

    def test_visible_captcha_control_still_stops(self) -> None:
        self.page.set_content('<div id="redcaptcha"><button>拖动滑块</button></div>')
        self.assertTrue(page_has_visible_challenge(self.page))

    def test_hidden_captcha_and_author_discussion_do_not_stop(self) -> None:
        self.page.set_content('<div id="redcaptcha" style="display:none">验证码</div>'
                              '<article>作者讨论验证码及安全验证</article>')
        self.assertFalse(page_has_visible_challenge(self.page))

    def test_explicit_challenge_notices_require_visible_exact_messages(self) -> None:
        for role in ("alert", "alertdialog"):
            for message in ("验证码", "安全验证", "拖动滑块", "请完成验证"):
                with self.subTest(role=role, message=message):
                    self.page.set_content(f'<div role="{role}">{message}</div>')
                    self.assertTrue(page_has_visible_challenge(self.page))
                    self.page.set_content(f'<div role="{role}" style="display:none">{message}</div>')
                    self.assertFalse(page_has_visible_challenge(self.page))
                    self.page.set_content(f'<article>{message}</article>')
                    self.assertFalse(page_has_visible_challenge(self.page))
                    self.page.set_content(f'<div role="{role}">作者讨论{message}</div>')
                    self.assertFalse(page_has_visible_challenge(self.page))

    def test_visible_login_control_still_stops(self) -> None:
        self.page.set_content('<div role="dialog"><button>扫码登录</button>'
                              '<input type="tel" aria-label="手机号"></div>')
        self.assertTrue(page_has_visible_login_prompt(self.page))
        self.assertTrue(page_has_risk_notice(self.page))

    def test_hidden_login_control_and_quoted_dialog_text_do_not_stop(self) -> None:
        self.page.set_content('<button style="display:none">扫码登录</button>'
                              '<div role="dialog"><article>手机号登录</article></div>')
        self.assertFalse(page_has_visible_login_prompt(self.page))
        self.assertFalse(page_has_risk_notice(self.page))

    def test_visible_platform_notices_are_recognized(self) -> None:
        for message, probe in (("访问频繁", page_has_risk_notice),
                               ("笔记不存在", page_has_not_found_notice)):
            with self.subTest(message=message):
                self.page.set_content(f'<div role="alert">{message}</div>')
                self.assertTrue(probe(self.page))
                self.page.set_content(f'<div role="alert" style="display:none">{message}</div>')
                self.assertFalse(probe(self.page))

    def test_temporarily_unavailable_notice_is_not_a_missing_note(self) -> None:
        self.page.set_content('<div role="alert">当前笔记暂时无法浏览</div>')
        missing = page_has_not_found_notice(self.page)
        self.assertIsNone(missing)
        self.assertEqual(detail_verdict(
            "https://www.xiaohongshu.com/explore/synthetic-note", "synthetic-note",
            [200], True, missing,
        ), "DETAIL_UNCONFIRMED")

    def test_unreadable_page_is_unconfirmed_not_missing(self) -> None:
        def unavailable(*_args, **_kwargs):
            raise RuntimeError("synthetic page unavailable")

        page = SimpleNamespace(locator=unavailable, evaluate=unavailable)
        missing = page_has_not_found_notice(page)
        self.assertIsNone(missing)
        self.assertEqual(detail_verdict(
            "https://www.xiaohongshu.com/explore/synthetic-note", "synthetic-note",
            [200], True, missing,
        ), "DETAIL_UNCONFIRMED")
        for probe in (page_has_risk_notice, page_has_visible_challenge,
                      page_has_visible_login_prompt):
            with self.subTest(probe=probe.__name__), self.assertRaises(ConfigError):
                probe(page)


if __name__ == "__main__":
    unittest.main()
