#!/usr/bin/env python3
"""Verify (or re-apply) the CSP hashes and security invariants for the offline app.

Usage:
    python verify-csp.py           # verify 实验提醒.html and index.html
    python verify-csp.py --apply   # recompute hashes in the source, then sync index.html

No third-party packages; Python standard library only.
"""
import base64
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
SOURCE = BASE / "实验提醒.html"
DEPLOY = BASE / "index.html"

META_RE = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">')
STYLE_RE = re.compile(r"<style>([\s\S]*?)</style>")
SCRIPT_RE = re.compile(r"<script>([\s\S]*?)</script>")


def digest(text: str) -> str:
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def extract(html: str):
    styles = STYLE_RE.findall(html)
    scripts = SCRIPT_RE.findall(html)
    if len(styles) != 1 or len(scripts) != 1:
        raise SystemExit(
            "expected exactly one inline <style> and one inline <script>, got %d/%d"
            % (len(styles), len(scripts))
        )
    return styles[0], scripts[0]


def get_meta(html: str):
    match = META_RE.search(html)
    if not match:
        raise SystemExit("CSP meta not found")
    return match


def apply_hashes(path: Path) -> None:
    html = path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
    style, script = extract(html)
    script_hash = digest(script)
    style_hash = digest(style)
    match = get_meta(html)
    policy = match.group(1)
    policy = re.sub(
        r"(script-src(?:-elem)? 'sha256-)[^']+(')",
        lambda m: m.group(1) + script_hash + m.group(2),
        policy,
    )
    policy = re.sub(
        r"(style-src(?:-elem)? 'sha256-)[^']+(')",
        lambda m: m.group(1) + style_hash + m.group(2),
        policy,
    )
    html = html[: match.start(1)] + policy + html[match.end(1):]
    path.write_bytes(html.encode("utf-8"))
    print("updated %s: script=%s style=%s" % (path.name, script_hash, style_hash))


def verify(path: Path) -> list:
    errors = []
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        errors.append("file has UTF-8 BOM")
    if b"\r\n" in raw:
        errors.append("file has CRLF; CSP hashes must be computed on LF bytes")
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return ["not valid UTF-8: %s" % exc]

    style, script = extract(html)
    script_hash = digest(script)
    style_hash = digest(style)
    policy = get_meta(html).group(1)

    template_match = re.search(r'<template id="defaultData">([\s\S]*?)</template>', html)
    if not template_match:
        errors.append("defaultData template missing")
    else:
        try:
            payload = json.loads(template_match.group(1))
            if not isinstance(payload, dict):
                errors.append("defaultData template must be an object")
            elif payload.get("version") == 2:
                classes = payload.get("classes")
                if not isinstance(classes, list):
                    errors.append("defaultData classes must be an array")
                else:
                    for item in classes:
                        if (not isinstance(item, dict)
                                or not isinstance(item.get("id"), str)
                                or not item.get("id")
                                or not isinstance(item.get("experiments"), list)):
                            errors.append("defaultData contains an invalid class entry")
                            break
            elif not isinstance(payload.get("experiments"), list):
                errors.append("defaultData legacy experiments must be an array")
        except Exception as exc:
            errors.append("defaultData template is not valid JSON: %s" % exc)
    if "const DEFAULT_DATA" not in script or "const DEFAULT_CLASSES" not in script:
        errors.append("default data parser missing")

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
            errors.append("missing CSP %s" % label)

    for bad in ("'unsafe-inline'", "'unsafe-hashes'", "'unsafe-eval'"):
        if bad in policy:
            errors.append("CSP contains %s" % bad)

    if "frame-ancestors" in policy:
        errors.append("meta CSP contains frame-ancestors (browsers ignore it in meta)")
    if "report-uri" in policy:
        errors.append("meta CSP contains report-uri (browsers ignore it in meta)")

    if re.search(r"<script\b[^>]*\bsrc\s*=", html, re.I):
        errors.append("external <script src> present")
    if re.search(r"<link\b", html, re.I):
        errors.append("<link> present")
    if re.search(r"<img\b", html, re.I):
        errors.append("<img> present")
    if re.search(
        r"\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|eval\(|new Function",
        script,
    ):
        errors.append("dangerous DOM/code sink found in script")
    if "XML_POLICY_NAME" not in script or "'xlsx-xml'" not in script:
        errors.append("XML Trusted Types policy name not found in script")
    if "window.top !== window.self" in script or "window.top.location" in script:
        errors.append("top-level navigation/frame-buster present")

    status = "PASS" if not errors else "FAIL"
    print("[%s] %s: script=%s style=%s" % (status, path.name, script_hash, style_hash))
    return errors


def main() -> int:
    if "--apply" in sys.argv:
        target = SOURCE if SOURCE.exists() else DEPLOY
        apply_hashes(target)
        if target == SOURCE:
            shutil.copyfile(SOURCE, DEPLOY)
            print("synced index.html from 实验提醒.html")

    paths = [p for p in (SOURCE, DEPLOY) if p.exists()]
    if not paths:
        print("no HTML files found")
        return 1
    if len(paths) == 2 and paths[0].read_bytes() != paths[1].read_bytes():
        print("FAIL: 实验提醒.html and index.html differ; run --apply")
        return 1

    errors = []
    for path in paths:
        errors.extend(verify(path))
    if errors:
        for error in errors:
            print(" - " + error)
        return 1
    print("OK: CSP hashes and restrictions verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
