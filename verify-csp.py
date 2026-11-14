#!/usr/bin/env python3
"""Verify (or re-apply) the CSP hashes and security invariants for the offline app.

Usage:
    python verify-csp.py           # verify 实验提醒.html and index.html
    python verify-csp.py --apply   # recompute hashes in the source, then sync index.html

No third-party packages; Python standard library only.

The verification core is exposed as pure functions (`verify_html`, `verify_bytes`,
`apply_hashes_to_html`) so build-html.py can validate the assembled page *before*
anything is written to disk.
"""
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
# index.html 是唯一真源（GitHub Pages 直接托管它）；实验提醒.html 只是同步副本。
DEPLOY = BASE / "index.html"
SOURCE = BASE / "实验提醒.html"

META_RE = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">')
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
    if script_count != 2 or style_count != 2:
        raise ValueError(
            "expected 2 script-src and 2 style-src hashes, replaced %d/%d"
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

    if re.search(r"<script\b[^>]*\bsrc\s*=", html, re.I):
        err("external <script src> present")
    if re.search(r"<link\b", html, re.I):
        err("<link> present")
    if re.search(r"<img\b", html, re.I):
        err("<img> present")
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


def verify_bytes(raw: bytes, name: str) -> list:
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
    return errors + verify_html(html, name, check_newlines=False)


def write_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file + replace so a crash never leaves a half-written page."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def describe(path: Path) -> str:
    try:
        style, script = extract(path.read_bytes().decode("utf-8"))
        return "script=%s style=%s" % (digest(script), digest(style))
    except Exception:
        return "(unparseable)"


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if "--apply" in argv:
        target = DEPLOY if DEPLOY.exists() else SOURCE
        try:
            html = target.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
            new_html, script_hash, style_hash = apply_hashes_to_html(html)
        except ValueError as exc:
            print("APPLY FAILED: %s: %s" % (target.name, exc))
            return 1
        encoded = new_html.encode("utf-8")
        write_atomic(target, encoded)
        print("updated %s: script=%s style=%s" % (target.name, script_hash, style_hash))
        if target == DEPLOY:
            write_atomic(SOURCE, encoded)
            print("synced 实验提醒.html from index.html")

    paths = [p for p in (SOURCE, DEPLOY) if p.exists()]
    if not paths:
        print("no HTML files found")
        return 1
    if len(paths) == 2 and paths[0].read_bytes() != paths[1].read_bytes():
        print("FAIL: 实验提醒.html and index.html differ; run --apply")
        return 1

    errors = []
    for path in paths:
        file_errors = verify_bytes(path.read_bytes(), path.name)
        status = "PASS" if not file_errors else "FAIL"
        print("[%s] %s: %s" % (status, path.name, describe(path)))
        errors.extend(file_errors)
    if errors:
        for error in errors:
            print(" - " + error)
        return 1
    print("OK: CSP hashes and restrictions verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
