#!/usr/bin/env python3
"""文档链接体检：Markdown 里的相对链接必须指向真实存在的文件/目录。

跳过：http(s)、mailto、纯锚点（#xxx）、代码块里的示例。
用法（仓库根目录）：python tools/check_docs_links.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE_RE = re.compile(r"```[\s\S]*?```")
SKIP_PREFIX = ("http://", "https://", "mailto:", "#", "tel:")


def markdown_files():
    root = common.REPO_ROOT
    files = [root / "README.md", root / "SECURITY.md", root / "LICENSE"]
    files += sorted((root / "docs").glob("*.md"))
    return [p for p in files if p.exists()]


def check_file(path: Path):
    problems = []
    text = FENCE_RE.sub("", path.read_text(encoding="utf-8"))
    for match in LINK_RE.finditer(text):
        target = match.group(1).strip()
        if not target or target.startswith(SKIP_PREFIX):
            continue
        clean = target.split("#", 1)[0]
        if not clean:
            continue
        resolved = (path.parent / clean).resolve()
        if not resolved.exists():
            line = text[: match.start()].count("\n") + 1
            problems.append("%s:%d  链接指向不存在的路径：%s" % (path.name, line, target))
    return problems


def main() -> int:
    problems = []
    for path in markdown_files():
        problems += check_file(path)
    if problems:
        for item in problems:
            print(" - " + item)
        print("文档链接体检失败：%d 处" % len(problems))
        return 1
    print("OK: 文档相对链接全部有效（%d 个文件）" % len(markdown_files()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
