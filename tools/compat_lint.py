#!/usr/bin/env python3
"""兼容性体检：把"最低支持版本"钉死，防止以后写回高版本特性。

底线（见 docs/COMPATIBILITY.md）：
    Chrome / Edge 60+ · Safari 11.1+ · iOS 12+（不含 IE）

判定方式很朴素：扫 src/app.css 与 src/app.js，命中"超出底线的特性"就报错。
确有必要的例外，在那一行加 `compat-allow` 注释（并在 COMPATIBILITY.md 里说明理由）。

用法（仓库根目录）：
    python tools/compat_lint.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SRC = common.REPO_ROOT / "src"
ALLOW_MARK = "compat-allow"

# (说明, 正则, 需要的版本)
JS_RULES = [
    ("可选链 ?.", r"\?\s*\.", "Chrome 80 / Safari 13.1"),
    ("空值合并 ??", r"\?\?", "Chrome 80 / Safari 13.1"),
    ("replaceAll", r"\.replaceAll\(", "Chrome 85 / Safari 13.1"),
    ("Array.prototype.at", r"\.at\(\s*-?\d", "Chrome 92 / Safari 15.4"),
    ("Object.fromEntries", r"\bfromEntries\s*\(", "Chrome 73 / Safari 12.1"),
    ("structuredClone", r"\bstructuredClone\s*\(", "Chrome 98 / Safari 15.4"),
    ("ResizeObserver", r"\bResizeObserver\b", "Chrome 64 / Safari 13.1"),
    ("globalThis", r"\bglobalThis\b", "Chrome 71 / Safari 12.1"),
    ("Array.prototype.flat", r"\.flat\s*\(", "Chrome 69 / Safari 12"),
    ("String.matchAll", r"\.matchAll\s*\(", "Chrome 73 / Safari 13"),
    ("Object.hasOwn", r"Object\.hasOwn\s*\(", "Chrome 93 / Safari 15.4"),
    ("replaceChildren", r"\.replaceChildren\s*\(", "Chrome 86 / Safari 14"),
    ("Promise.any", r"Promise\.any\s*\(", "Chrome 85 / Safari 14"),
    ("私有字段 #x", r"(?<![\w$])#\w+\s*[=(;,)]", "Chrome 74 / Safari 14.1"),
    ("class static block", r"static\s*\{", "Chrome 94 / Safari 16.4"),
]

# 允许出现的现代特性（有 @supports 兜底或本来就够老）
JS_ALLOWED = ["padStart", "padEnd", "Object.entries", "Object.values", "async", "await", "=>", "...", "append("]

CSS_RULES = [
    ("inset 简写", r"(?<![\w-])inset\s*:", "Chrome 87 / Safari 14.1"),
    ("aspect-ratio", r"aspect-ratio\s*:", "Chrome 88 / Safari 15"),
    (":is()", r":is\(", "Chrome 88 / Safari 14"),
    (":where()", r":where\(", "Chrome 88 / Safari 14"),
    (":has()", r":has\(", "Chrome 105 / Safari 15.4"),
    ("clamp()", r"\bclamp\(", "Chrome 79 / Safari 13.1"),
    ("min()/max()", r"\b(?:min|max)\(", "Chrome 79 / Safari 11.1"),
    ("content-visibility", r"content-visibility\s*:", "Chrome 85 / Safari 18"),
    ("backdrop-filter", r"backdrop-filter\s*:", "Chrome 76 / Safari 9（需前缀）"),
    ("scrollbar-gutter", r"scrollbar-gutter\s*:", "Chrome 94 / Safari 18"),
    ("dvh/svh/lvh 单位", r"\b\d+(?:\.\d+)?(?:dvh|svh|lvh)\b", "Chrome 108 / Safari 15.4"),
    ("subgrid", r"subgrid", "Chrome 117 / Safari 16"),
]


def has_polyfill(js: str, name: str) -> bool:
    """源码里自己补了 polyfill（Element.prototype.replaceChildren = …）就不再拦。"""
    return ("prototype.%s" % name) in js or ("prototype['%s']" % name) in js


def scan(path: Path, rules, js_text: str = ""):
    problems = []
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return problems
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW_MARK in line:
            continue
        stripped = line.strip()
        if stripped.startswith("/*") and stripped.endswith("*/"):
            continue
        # 同一行先写老值再写新语法，视为带降级回退（如 92vh; min(92dvh,640px)）
        fallback_ahead = re.search(r";\s*[a-z-]+\s*:", stripped) is not None
        for label, pattern, need in rules:
            if not re.search(pattern, line):
                continue
            if label == "replaceChildren" and has_polyfill(js_text, "replaceChildren"):
                continue
            if label in ("min()/max()", "dvh/svh/lvh 单位") and fallback_ahead:
                continue
            problems.append("%s:%d  用了 %s（需要 %s）" % (path.name, lineno, label, need))
    return problems


def check_sticky_prefix(css_path: Path):
    css = css_path.read_text(encoding="utf-8") if css_path.exists() else ""
    problems = []
    for match in re.finditer(r"position\s*:\s*sticky", css):
        window = css[max(0, match.start() - 160):match.start()]
        if "-webkit-sticky" not in window:
            line = css[: match.start()].count("\n") + 1
            problems.append("%s:%d  position: sticky 缺少 -webkit-sticky 前缀（iOS 12 需要）" % (css_path.name, line))
    return problems


def main() -> int:
    problems = []
    js_text = (SRC / "app.js").read_text(encoding="utf-8") if (SRC / "app.js").exists() else ""
    problems += scan(SRC / "app.js", JS_RULES, js_text)
    styles_dir = SRC / "styles"
    css_files = sorted(styles_dir.glob("*.css")) if styles_dir.exists() else []
    for css_file in css_files:
        problems += scan(css_file, CSS_RULES, js_text)
    problems += scan(SRC / "index.template.html", CSS_RULES, js_text)
    for css_file in (sorted((SRC / "styles").glob("*.css")) if (SRC / "styles").exists() else []):
        problems += check_sticky_prefix(css_file)

    if problems:
        for item in problems:
            print(" - " + item)
        print("兼容性体检失败：%d 项超出底线（Chrome 60 / Safari 11.1 / iOS 12）" % len(problems))
        print("如确有必要，在该行加注释 %s 并更新 docs/COMPATIBILITY.md" % ALLOW_MARK)
        return 1
    print("OK: 兼容性体检通过（未使用超出 Chrome 60 / Safari 11.1 / iOS 12 的特性）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
