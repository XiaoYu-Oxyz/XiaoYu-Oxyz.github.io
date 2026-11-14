"""校验器回归：CSP 哈希、编码、结构不变量。

这些是"构建先校验后写盘"所依赖的判断逻辑；它们坏了，白屏产物就会重新上线。
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_csp", BASE / "verify-csp.py")
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)

HTML = (BASE / "index.html").read_text(encoding="utf-8")
PAGE_404 = (BASE / "404.html").read_text(encoding="utf-8")


def has(errors, needle):
    return any(needle in error for error in errors)


class VerifyHtmlTests(unittest.TestCase):
    def test_current_page_passes(self):
        self.assertEqual(VERIFY.verify_html(HTML, "index.html"), [])

    def test_stale_style_hash_is_caught(self):
        broken = HTML.replace("* { box-sizing: border-box; }", "*  { box-sizing: border-box; }", 1)
        self.assertNotEqual(broken, HTML, "测试前提：样式块必须能被改动")
        errors = VERIFY.verify_html(broken, "index.html")
        self.assertTrue(has(errors, "style-src hash"), errors)

    def test_missing_template_is_caught(self):
        broken = HTML.replace('<template id="defaultData">', '<template id="otherData">', 1)
        errors = VERIFY.verify_html(broken, "index.html")
        self.assertTrue(has(errors, "defaultData template missing"), errors)

    def test_dangerous_sink_is_caught(self):
        broken = HTML.replace("function pad2(n)", "function pad2(n) { el.innerHTML = ''; }\nfunction pad2Unused(n)", 1)
        errors = VERIFY.verify_html(broken, "index.html")
        self.assertTrue(has(errors, "dangerous DOM/code sink"), errors)

    def test_newlines_are_rejected(self):
        self.assertTrue(has(VERIFY.verify_html(HTML.replace("\n", "\r\n", 2), "index.html"), "CR"))

    def test_nul_is_rejected(self):
        self.assertTrue(has(VERIFY.verify_html(HTML + "\x00", "index.html"), "NUL"))


class VerifyBytesTests(unittest.TestCase):
    def test_crlf_bytes_are_caught(self):
        raw = HTML.replace("\n", "\r\n").encode("utf-8")
        self.assertTrue(has(VERIFY.verify_bytes(raw, "index.html"), "CRLF"))

    def test_bare_cr_bytes_are_caught(self):
        raw = HTML.encode("utf-8").replace(b"\n", b"\r", 3)
        self.assertTrue(has(VERIFY.verify_bytes(raw, "index.html"), "bare CR"))

    def test_bom_is_caught(self):
        raw = b"\xef\xbb\xbf" + HTML.encode("utf-8")
        self.assertTrue(has(VERIFY.verify_bytes(raw, "index.html"), "BOM"))

    def test_nul_bytes_are_caught(self):
        raw = HTML.encode("utf-8") + b"\x00"
        self.assertTrue(has(VERIFY.verify_bytes(raw, "index.html"), "NUL"))


class ApplyHashTests(unittest.TestCase):
    def test_apply_repairs_a_stale_hash(self):
        broken = HTML.replace("* { box-sizing: border-box; }", "*  { box-sizing: border-box; }", 1)
        self.assertTrue(VERIFY.verify_html(broken, "index.html"))

        fixed, script_hash, style_hash = VERIFY.apply_hashes_to_html(broken)
        self.assertEqual(VERIFY.verify_html(fixed, "index.html"), [])
        self.assertIn("script-src 'sha256-%s'" % script_hash, fixed)
        self.assertIn("style-src 'sha256-%s'" % style_hash, fixed)

    def test_apply_is_idempotent(self):
        once, script_hash, _ = VERIFY.apply_hashes_to_html(HTML)
        twice, script_hash_2, _ = VERIFY.apply_hashes_to_html(once)
        self.assertEqual(once, twice)
        self.assertEqual(script_hash, script_hash_2)


class StaticPageTests(unittest.TestCase):
    def test_404_passes(self):
        self.assertEqual(VERIFY.verify_static_page(PAGE_404, "404.html"), [])

    def test_404_without_csp_is_caught(self):
        broken = PAGE_404.replace('<meta http-equiv="Content-Security-Policy"', '<meta name="x"', 1)
        self.assertTrue(has(VERIFY.verify_static_page(broken, "404.html"), "CSP meta not found"))

    def test_404_inline_handler_is_caught(self):
        broken = PAGE_404.replace('<button class="btn btn-ghost" type="button" id="backBtn">',
                                  '<button class="btn btn-ghost" type="button" onclick="history.back()">', 1)
        self.assertTrue(has(VERIFY.verify_static_page(broken, "404.html"), "inline event handler"))

    def test_404_external_script_is_caught(self):
        broken = PAGE_404.replace("<script>", '<script src="app.js">', 1)
        self.assertTrue(has(VERIFY.verify_static_page(broken, "404.html"), "external <script src>"))


if __name__ == "__main__":
    unittest.main()
