#!/usr/bin/env python3
"""Verify (or re-apply) the CSP hashes and security invariants for the offline app.

Usage (在仓库根目录执行):
    python tools/verify.py           # 校验 index.html、404.html 与构建期生成的 .ics
    python tools/verify.py --apply   # 重算哈希并写回 index.html / 404.html

No third-party packages; Python standard library only.

The verification core is exposed as pure functions (`verify_html`, `verify_bytes`,
`apply_hashes_to_html`) so tools/build.py can validate the assembled page *before*
anything is written to disk.
"""
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402  （tools/common.py：路径、原子写入）
import color_audit  # noqa: E402  （tools/color_audit.py：色值 token 体检）

BASE = common.REPO_ROOT
# index.html 是唯一页面文件；404.html 与构建期生成的 .ics 是附带产物。
DEPLOY = common.INDEX
# 独立页面：同样要求 CSP 哈希与外部资源禁令，但不跑应用专用的表格/模板检查。
EXTRA_PAGES = [common.PAGE_404]

META_RE = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*/?>')
STYLE_RE = re.compile(r"<style>([\s\S]*?)</style>")
SCRIPT_RE = re.compile(r"<script>([\s\S]*?)</script>")
TEMPLATE_RE = re.compile(r'<template id="defaultData">([\s\S]*?)</template>')
SCRIPT_HASH_RE = re.compile(r"(script-src(?:-elem)? 'sha256-)[^']+(')")
STYLE_HASH_RE = re.compile(r"(style-src(?:-elem)? 'sha256-)[^']+(')")
BARE_CR_RE = re.compile(rb"\r(?!\n)")
DANGEROUS_SINK_RE = re.compile(
    r"\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|eval\(|new Function"
)
HEADER_NAMES = ("日期", "周次", "星期", "节次", "实验名称", "实验地点")


def digest(text: str) -> str:
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def extract(html: str):
    styles = STYLE_RE.findall(html)
    scripts = SCRIPT_RE.findall(html)
    if len(styles) != 1 or len(scripts) != 1:
        raise ValueError(
            "expected exactly one inline <style> and one inline <script>, got %d/%d"
            % (len(styles), len(scripts))
        )
    return styles[0], scripts[0]


def find_policy(html: str):
    match = META_RE.search(html)
    if not match:
        raise ValueError("CSP meta not found")
    return match


def apply_hashes_to_html(html: str):
    """Return (html_with_fresh_hashes, script_hash, style_hash)."""
    style, script = extract(html)
    script_hash = digest(script)
    style_hash = digest(style)
    match = find_policy(html)
    policy = match.group(1)
    policy, script_count = SCRIPT_HASH_RE.subn(
        lambda m: m.group(1) + script_hash + m.group(2), policy
    )
    policy, style_count = STYLE_HASH_RE.subn(
        lambda m: m.group(1) + style_hash + m.group(2), policy
    )
    if script_count < 1 or style_count < 1:
        raise ValueError(
            "no sha256 placeholder found for script-src/style-src (%d/%d)"
            % (script_count, style_count)
        )
    return html[: match.start(1)] + policy + html[match.end(1):], script_hash, style_hash


def verify_html(html: str, name: str, check_newlines: bool = True) -> list:
    """Check one HTML document (already decoded). Returns a list of "name: reason"."""
    errors = []

    def err(reason: str) -> None:
        errors.append("%s: %s" % (name, reason))

    if check_newlines and "\r" in html:
        err("contains CR characters; CSP hashes must be computed on LF-only text")
    if "\x00" in html:
        err("contains NUL characters")
    # 外部资源检查放在最前：否则 <script src> 会先触发"内联脚本数量不对"这种更难懂的错误
    if re.search(r"<script\b[^>]*\bsrc\s*=", html, re.I):
        err("external <script src> present")
    if re.search(r"<link\b", html, re.I):
        err("<link> present")
    if re.search(r"<img\b", html, re.I):
        err("<img> present")

    try:
        style, script = extract(html)
    except ValueError as exc:
        err(str(exc))
        return errors

    script_hash = digest(script)
    style_hash = digest(style)
    try:
        policy = find_policy(html).group(1)
    except ValueError as exc:
        err(str(exc))
        return errors

    template_match = TEMPLATE_RE.search(html)
    if not template_match:
        err("defaultData template missing")
    else:
        try:
            payload = json.loads(template_match.group(1))
            if not isinstance(payload, dict):
                err("defaultData template must be an object")
            elif payload.get("version") == 2:
                classes = payload.get("classes")
                if not isinstance(classes, list):
                    err("defaultData classes must be an array")
                else:
                    for item in classes:
                        if (not isinstance(item, dict)
                                or not isinstance(item.get("id"), str)
                                or not item.get("id")
                                or not isinstance(item.get("experiments"), list)):
                            err("defaultData contains an invalid class entry")
                            break
            elif not isinstance(payload.get("experiments"), list):
                err("defaultData legacy experiments must be an array")
        except Exception as exc:  # json.JSONDecodeError and friends
            err("defaultData template is not valid JSON: %s" % exc)

    if name == DEPLOY.name:
        errors.extend("%s: %s" % (name, item) for item in color_audit.audit(html))

    if "const DEFAULT_DATA" not in script or "const DEFAULT_CLASSES" not in script:
        err("default data parser missing")

    checks = [
        ("script-src hash", "script-src 'sha256-%s'" % script_hash),
        ("script-src-elem hash", "script-src-elem 'sha256-%s'" % script_hash),
        ("style-src hash", "style-src 'sha256-%s'" % style_hash),
        ("style-src-elem hash", "style-src-elem 'sha256-%s'" % style_hash),
        ("default-src none", "default-src 'none'"),
        ("script-src-attr none", "script-src-attr 'none'"),
        ("style-src-attr none", "style-src-attr 'none'"),
        ("base-uri none", "base-uri 'none'"),
        ("form-action none", "form-action 'none'"),
        ("connect-src none", "connect-src 'none'"),
        ("trusted types enforced", "require-trusted-types-for 'script'"),
        ("only xlsx-xml policy", "trusted-types xlsx-xml"),
    ]
    for label, needle in checks:
        if needle not in policy:
            err("missing CSP %s" % label)

    for bad in ("'unsafe-inline'", "'unsafe-hashes'", "'unsafe-eval'"):
        if bad in policy:
            err("CSP contains %s" % bad)

    if "frame-ancestors" in policy:
        err("meta CSP contains frame-ancestors (browsers ignore it in meta)")
    if "report-uri" in policy:
        err("meta CSP contains report-uri (browsers ignore it in meta)")

    if DANGEROUS_SINK_RE.search(script):
        err("dangerous DOM/code sink found in script")
    if "XML_POLICY_NAME" not in script or "'xlsx-xml'" not in script:
        err("XML Trusted Types policy name not found in script")
    if "window.top !== window.self" in script or "window.top.location" in script:
        err("top-level navigation/frame-buster present")
    for header in HEADER_NAMES:
        if header not in html:
            err("table header %s missing" % header)

    return errors


def verify_static_page(html: str, name: str) -> list:
    """CSP + 外部资源检查，用于 404.html 这类独立页面（没有数据模板/表格）。"""
    errors = []

    def err(reason: str) -> None:
        errors.append("%s: %s" % (name, reason))

    # 先查外部资源：<script src> 必须先被识别为"外部脚本"，而不是"内联脚本数量不对"
    if re.search(r"<script\b[^>]*\bsrc\s*=", html, re.I):
        err("external <script src> present")
    if re.search(r"<link\b", html, re.I):
        err("<link> present")
    if re.search(r"<img\b", html, re.I):
        err("<img> present")
    if re.search(r"\son[a-z]+\s*=", html, re.I):
        err("inline event handler attribute present (needs 'unsafe-inline')")

    try:
        style, script = extract(html)
    except ValueError as exc:
        err(str(exc))
        return errors
    try:
        policy = find_policy(html).group(1)
    except ValueError as exc:
        err(str(exc))
        return errors
    checks = [
        ("script-src hash", "script-src 'sha256-%s'" % digest(script)),
        ("style-src hash", "style-src 'sha256-%s'" % digest(style)),
        ("default-src none", "default-src 'none'"),
        ("script-src-attr none", "script-src-attr 'none'"),
        ("style-src-attr none", "style-src-attr 'none'"),
        ("base-uri none", "base-uri 'none'"),
        ("form-action none", "form-action 'none'"),
        ("connect-src none", "connect-src 'none'"),
    ]
    for label, needle in checks:
        if needle not in policy:
            err("missing CSP %s" % label)

    for bad in ("'unsafe-inline'", "'unsafe-hashes'", "'unsafe-eval'"):
        if bad in policy:
            err("CSP contains %s" % bad)

    if DANGEROUS_SINK_RE.search(script):
        err("dangerous DOM/code sink found in script")
    return errors


def verify_bytes(raw: bytes, name: str, html_check=None) -> list:
    """Byte-level checks (BOM / CRLF / bare CR / NUL) plus the HTML-level checks."""
    errors = []
    if raw.startswith(b"\xef\xbb\xbf"):
        errors.append("%s: file has UTF-8 BOM" % name)
    if b"\r\n" in raw:
        errors.append("%s: file uses CRLF line endings; hashes must be computed on LF" % name)
    elif BARE_CR_RE.search(raw):
        errors.append("%s: file contains a bare CR character" % name)
    if b"\x00" in raw:
        errors.append("%s: file contains NUL bytes" % name)
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return errors + ["%s: not valid UTF-8: %s" % (name, exc)]
    if html_check is None:
        return errors + verify_html(html, name, check_newlines=False)
    return errors + html_check(html, name)



def describe(path: Path) -> str:
    try:
        style, script = extract(path.read_bytes().decode("utf-8"))
        return "script=%s style=%s" % (digest(script), digest(style))
    except Exception:
        return "(unparseable)"


def verify_ics_files() -> list:
    """构建期生成的日历订阅文件：结构、CRLF、折行，以及事件数必须大于 0。"""
    errors = []
    for path in sorted(common.CALENDARS_DIR.glob("*.ics")):
        name = path.name
        raw = path.read_bytes()
        if b"\r\n" not in raw:
            errors.append("%s: 缺少 CRLF 行尾" % name)
        if re.search(rb"(?<!\r)\n", raw):
            errors.append("%s: 含裸 LF（iCalendar 要求 CRLF）" % name)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            errors.append("%s: 不是有效 UTF-8：%s" % (name, exc))
            continue
        if not text.startswith("BEGIN:VCALENDAR\r\n"):
            errors.append("%s: 不是以 BEGIN:VCALENDAR 开头" % name)
        if not text.endswith("END:VCALENDAR\r\n"):
            errors.append("%s: 不是以 END:VCALENDAR 结尾" % name)
        if "BEGIN:VTIMEZONE" not in text or "TZID:Asia/Shanghai" not in text:
            errors.append("%s: 缺少 Asia/Shanghai 时区定义" % name)
        if "TRIGGER:-PT2H" not in text and "TRIGGER:-PT30M" not in text:
            errors.append("%s: 缺少提前提醒（-PT30M 或 -PT2H）" % name)
        events = text.count("BEGIN:VEVENT")
        alarms = text.count("BEGIN:VALARM")
        if events == 0:
            errors.append("%s: 没有任何事件" % name)
        if events != alarms:
            errors.append("%s: 事件数 %d 与提醒数 %d 不一致" % (name, events, alarms))
        for line in text.split("\r\n"):
            if len(line.encode("utf-8")) > 75:
                errors.append("%s: 有一行超过 75 字节：%s" % (name, line[:20]))
                break
            if len(line) > 76 and line == line.strip():
                pass
    return errors


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if "--apply" in argv:
        target = DEPLOY
        if not target.exists():
            print("APPLY FAILED: %s 不存在" % target.name)
            return 1
        try:
            html = target.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
            new_html, script_hash, style_hash = apply_hashes_to_html(html)
        except ValueError as exc:
            print("APPLY FAILED: %s: %s" % (target.name, exc))
            return 1
        encoded = new_html.encode("utf-8")
        common.write_atomic(target, encoded)
        print("updated %s: script=%s style=%s" % (target.name, script_hash, style_hash))
        for extra in EXTRA_PAGES:
            if not extra.exists():
                continue
            extra_html = extra.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
            extra_new, extra_script, extra_style = apply_hashes_to_html(extra_html)
            common.write_atomic(extra, extra_new.encode("utf-8"))
            print("updated %s: script=%s style=%s" % (extra.name, extra_script, extra_style))

    paths = [p for p in (DEPLOY,) if p.exists()]
    if not paths:
        print("no HTML files found")
        return 1

    errors = []
    for path in paths:
        file_errors = verify_bytes(path.read_bytes(), path.name)
        status = "PASS" if not file_errors else "FAIL"
        print("[%s] %s: %s" % (status, path.name, describe(path)))
        errors.extend(file_errors)
    for extra in EXTRA_PAGES:
        if not extra.exists():
            continue
        extra_errors = verify_bytes(extra.read_bytes(), extra.name, verify_static_page)
        status = "PASS" if not extra_errors else "FAIL"
        print("[%s] %s: %s" % (status, extra.name, describe(extra)))
        errors.extend(extra_errors)

    ics_files = sorted(common.CALENDARS_DIR.glob("*.ics"))
    ics_errors = verify_ics_files()
    print("[%s] %d 个 .ics 订阅文件" % ("PASS" if not ics_errors else "FAIL", len(ics_files)))
    errors.extend(ics_errors)
    if errors:
        for error in errors:
            print(" - " + error)
        return 1
    print("OK: CSP hashes and restrictions verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
