#!/usr/bin/env python3
"""色值 token 体检：index.html 的所有颜色都必须走 CSS 变量。

规则（三条，全部可自动判定）：
1. `<style>` 里只允许在开头那个 `:root {}` 块内出现颜色字面量，其余位置一律 `var(--c-…)`；
2. `tools/palette.json` 的 tokens 必须与 `:root` 完全一致（单向真源：改色 = 改 token + 跑 --write）；
3. 每个 `var(--c-…)` 引用都必须在 `:root` 里定义（变量名打错会导致整条声明失效，颜色退回默认值）。

用法（仓库根目录）：
    python tools/color_audit.py           # 校验，失败返回 1
    python tools/color_audit.py --write   # 按 index.html 重新生成 palette.json 的 tokens（保留 semantic）

只用标准库；`semantic` 段（语义名 → light/dark token）由人工维护，本脚本负责校验其引用的 token 存在且值一致。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
RGB_RE = re.compile(r"\brgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)")
COLOR_RE = re.compile(HEX_RE.pattern + "|" + RGB_RE.pattern)
STYLE_RE = re.compile(r"<style[^>]*>([\s\S]*?)</style>")
VAR_RE = re.compile(r"var\(\s*(--c-[A-Za-z0-9._-]+)")

PALETTE = common.TOOLS_DIR / "palette.json"


def style_text(html: str) -> str:
    match = STYLE_RE.search(html)
    if not match:
        raise ValueError("找不到 <style> 块")
    return match.group(1)


def strip_comments(css: str) -> str:
    """把注释替换成等长空白，保持索引稳定。"""
    out = []
    i = 0
    n = len(css)
    while i < n:
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            if end == -1:
                out.append(" " * (n - i))
                break
            out.append(" " * (end + 2 - i))
            i = end + 2
            continue
        out.append(css[i])
        i += 1
    return "".join(out)


def root_block(css: str):
    """返回 (block_text, start, end) —— 第一个 :root { … } 的位置。"""
    match = re.search(r":root\s*\{", css)
    if not match:
        raise ValueError("找不到 :root 块")
    start = match.end()
    depth = 1
    i = start
    while i < len(css):
        ch = css[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return css[start:i], match.start(), i
        i += 1
    raise ValueError(":root 块没有闭合")


def parse_tokens(block: str) -> dict:
    tokens = {}
    for match in re.finditer(r"(--c-[A-Za-z0-9._-]+)\s*:\s*([^;]+);", block):
        name = match.group(1).strip()
        value = match.group(2).strip()
        tokens[name] = value
    return tokens


def audit(html: str, palette_path: Path = PALETTE) -> list:
    """返回错误列表（空列表 = 通过）。"""
    errors = []
    try:
        css = style_text(html)
    except ValueError as exc:
        return [str(exc)]

    stripped = strip_comments(css)
    try:
        block, block_start, block_end = root_block(stripped)
    except ValueError as exc:
        return [str(exc)]

    tokens = parse_tokens(block)
    if not tokens:
        errors.append(":root 里没有任何 --c-* token")
    values = list(tokens.values())
    for name, value in tokens.items():
        if not COLOR_RE.fullmatch(value.strip()):
            errors.append("token %s 的值不是颜色字面量：%s" % (name, value))
    dupes = {v for v in values if values.count(v) > 1}
    for value in sorted(dupes):
        same = [n for n, v in tokens.items() if v == value]
        errors.append("多个 token 值相同（%s）：%s —— 应合并成一个" % (value, ", ".join(sorted(same))))

    outside = stripped[:block_start] + stripped[block_end + 1:]
    leftovers = COLOR_RE.findall(outside)
    if leftovers:
        unique = sorted({c for c in leftovers})
        errors.append(":root 之外还有 %d 处颜色字面量（%d 种）：%s —— 全部改用 var(--c-…)"
                      % (len(leftovers), len(unique), ", ".join(unique[:6]) + ("…" if len(unique) > 6 else "")))

    refs = set(VAR_RE.findall(stripped))
    undefined = sorted(refs - set(tokens))
    if undefined:
        errors.append("引用了未定义的 token：%s" % ", ".join(undefined[:8]))

    unused = sorted(set(tokens) - refs)
    if unused:
        errors.append("定义了但没人使用的 token：%s" % ", ".join(unused[:8]))

    if palette_path.exists():
        palette = json.loads(palette_path.read_text(encoding="utf-8"))
        palette_tokens = {item["token"]: item["value"] for item in palette.get("tokens", [])}
        if palette_tokens != tokens:
            only_file = sorted(set(tokens) - set(palette_tokens))
            only_palette = sorted(set(palette_tokens) - set(tokens))
            changed = sorted(n for n in set(tokens) & set(palette_tokens) if tokens[n] != palette_tokens[n])
            detail = []
            if only_file:
                detail.append("index.html 新增 %s" % ", ".join(only_file[:5]))
            if only_palette:
                detail.append("palette 多出 %s" % ", ".join(only_palette[:5]))
            if changed:
                detail.append("值不一致 %s" % ", ".join(
                    "%s: %s→%s" % (n, palette_tokens[n], tokens[n]) for n in changed[:5]))
            errors.append("tools/palette.json 与 :root 不同步（%s）；改完颜色请跑 python tools/color_audit.py --write"
                          % "；".join(detail))
        semantic = palette.get("semantic") or {}
        for name, pair in semantic.items():
            for scheme in ("light", "dark"):
                token = pair.get(scheme)
                if token is None:
                    errors.append("semantic.%s 缺少 %s" % (name, scheme))
                elif token not in tokens:
                    errors.append("semantic.%s.%s 指向不存在的 token：%s" % (name, scheme, token))
        for name, pair in semantic.items():
            light = tokens.get(pair.get("light", ""))
            dark = tokens.get(pair.get("dark", ""))
            if light and dark and light.lower() == dark.lower():
                errors.append("semantic.%s 的明暗两值是同一个颜色（%s），多半填错了" % (name, light))
    else:
        errors.append("找不到 %s" % palette_path)

    return errors


def write_palette(html: str, palette_path: Path = PALETTE) -> dict:
    css = strip_comments(style_text(html))
    block, _, _ = root_block(css)
    tokens = parse_tokens(block)
    palette = {}
    if palette_path.exists():
        palette = json.loads(palette_path.read_text(encoding="utf-8"))
    palette["generatedFrom"] = "index.html"
    palette["tokens"] = [{"token": name, "value": value} for name, value in tokens.items()]
    semantic = palette.get("semantic") or {}
    missing = sorted({pair.get(s) for pair in semantic.values() for s in ("light", "dark")} - set(tokens))
    if missing:
        raise SystemExit("semantic 引用了不存在的 token，先修 semantic：%s" % ", ".join(str(m) for m in missing))
    palette["semantic"] = semantic
    palette_path.write_text(json.dumps(palette, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
    return palette


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    html = common.INDEX.read_text(encoding="utf-8")
    if "--write" in argv:
        palette = write_palette(html, PALETTE)
        print("palette.json 已更新：%d 个 token，%d 个语义名"
              % (len(palette["tokens"]), len(palette.get("semantic") or {})))
        return 0
    errors = audit(html, PALETTE)
    if errors:
        for error in errors:
            print(" - " + error)
        print("色值 token 体检失败：%d 项" % len(errors))
        return 1
    count = len(parse_tokens(root_block(strip_comments(style_text(html)))[0]))
    print("OK: 色值 token 体检通过（%d 个 token，:root 之外无颜色字面量，引用全部有定义）" % count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
