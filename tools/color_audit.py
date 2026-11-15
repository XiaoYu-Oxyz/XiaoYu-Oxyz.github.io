#!/usr/bin/env python3
"""色值体系体检：raw token（--c-*）+ 语义别名（--page-bg 等）。

三层模型：
    :root { --c-ffe9e8: #ffe9e8; }                      ← 值 token：全站唯一的颜色字面量处
    :root { --row-today-cell-bg: var(--c-ffe9e8); }     ← 语义别名（浅色）
    @media (prefers-color-scheme: dark) { :root { --row-today-cell-bg: var(--c-3d1a1c); } }

规则（全部自动判定）：
1. `<style>` 里只有 `:root` 块允许出现颜色字面量，其余一律 `var(--c-…)` / `var(--语义名)`；
2. 每个 `var()` 引用的名字都必须有定义（拼错会让整条声明失效）；
3. 定义了的 token / 别名都必须被用到（不留死条目）；
4. `tools/palette.json` 必须与实现同步（tokens + aliases），`semantic` 指向存在的别名；
5. `<style>` 之外（内联 style、JS 字符串）也不许出现颜色字面量。

用法（仓库根目录）：
    python tools/color_audit.py            # 校验
    python tools/color_audit.py --write    # 按 index.html 重新生成 palette.json（保留 semantic）
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
TOKEN_RE = re.compile(r"(--c-[A-Za-z0-9._-]+)\s*:\s*([^;]+);")
ALIAS_RE = re.compile(r"(--(?!c-)[a-z][A-Za-z0-9-]*)\s*:\s*([^;]+);")
VAR_RE = re.compile(r"var\(\s*(--[A-Za-z0-9._-]+)")
DARK_MQ = "@media (prefers-color-scheme: dark)"

PALETTE = common.TOOLS_DIR / "palette.json"


def style_text(html: str) -> str:
    match = STYLE_RE.search(html)
    if not match:
        raise ValueError("找不到 <style> 块")
    return match.group(1)


def strip_comments(css: str) -> str:
    out, i, n = [], 0, len(css)
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


def strip_html_comments(text: str) -> str:
    return re.sub(r"<!--[\s\S]*?-->", lambda m: " " * len(m.group(0)), text)


def matching_block(text: str, open_index: int):
    """open_index 指向 '{'，返回 (内容, 结束 '}' 下标)。"""
    depth, i = 0, open_index
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_index + 1:i], i
        i += 1
    raise ValueError("块没有闭合")


def root_blocks(css: str):
    """返回 (浅色别名块, 深色别名块, 浅色块区间, 深色块区间)。"""
    light_match = re.search(r":root\s*\{", css)
    if not light_match:
        raise ValueError("找不到浅色 :root 块")
    light_body, light_end = matching_block(css, light_match.end() - 1)
    dark_body, dark_span = "", None
    dark_mq = css.find(DARK_MQ)
    if dark_mq != -1:
        inner = css.find(":root", dark_mq)
        if inner != -1:
            inner_brace = css.find("{", inner)
            dark_body, dark_end = matching_block(css, inner_brace)
            dark_span = (inner_brace, dark_end)
    return light_body, dark_body, (light_match.start(), light_end), dark_span


CUSTOM_PROP_RE = re.compile(r"(--[A-Za-z0-9._-]+)\s*:\s*([^;]+);")


def _split_colors(body: str):
    """把 :root 块拆成 (值 token, 语义别名)：别名只认"值是颜色"的自定义属性，
    布局类变量（--week-gap 之类）不参与色值体检。"""
    raw = {m.group(1): m.group(2).strip() for m in CUSTOM_PROP_RE.finditer(body)}
    tokens = {k: v for k, v in raw.items() if k.startswith("--c-")}
    aliases = {k: v for k, v in raw.items() if not k.startswith("--c-") and COLOR_RE.fullmatch(v)}
    return tokens, aliases


def parse(css: str):
    stripped = strip_comments(css)
    light_body, dark_body, light_span, dark_span = root_blocks(stripped)
    tokens, aliases_light = _split_colors(light_body)
    _, aliases_dark = _split_colors(dark_body)
    return stripped, tokens, aliases_light, aliases_dark, light_span, dark_span


def audit(html: str, palette_path: Path = PALETTE) -> list:
    errors = []
    try:
        css = style_text(html)
    except ValueError as exc:
        return [str(exc)]

    try:
        stripped, tokens, aliases_light, aliases_dark, light_span, dark_span = parse(css)
    except ValueError as exc:
        return [str(exc)]

    if not tokens:
        errors.append(":root 里没有任何 --c-* token")
    for name, value in tokens.items():
        if not COLOR_RE.fullmatch(value):
            errors.append("token %s 的值不是颜色字面量：%s" % (name, value))
    seen = {}
    for name, value in tokens.items():
        seen.setdefault(value.lower(), []).append(name)
    for value, names in seen.items():
        if len(names) > 1:
            errors.append("多个 token 值相同（%s）：%s —— 应合并成一个" % (value, ", ".join(sorted(names))))

    for name, value in {**aliases_light, **aliases_dark}.items():
        if not COLOR_RE.fullmatch(value):
            errors.append("别名 %s 的值不是颜色：%s" % (name, value))
        for ref in VAR_RE.findall(value):
            if ref not in tokens and ref not in aliases_light and ref not in aliases_dark:
                errors.append("别名 %s 引用了未定义的 %s" % (name, ref))

    masked = list(stripped)
    for span in (light_span, dark_span):
        if not span:
            continue
        for idx in range(span[0], span[1] + 1):
            masked[idx] = " "
    outside = "".join(masked)
    leftovers = COLOR_RE.findall(outside)
    if leftovers:
        unique = sorted(set(leftovers))
        errors.append(":root 之外还有 %d 处颜色字面量（%d 种）：%s —— 全部改用 var()"
                      % (len(leftovers), len(unique), ", ".join(unique[:6]) + ("…" if len(unique) > 6 else "")))

    refs = set(VAR_RE.findall(stripped))
    all_defined_names = set(m.group(1) for m in CUSTOM_PROP_RE.finditer(stripped))
    defined = set(tokens) | set(aliases_light) | set(aliases_dark)
    undefined = sorted(refs - all_defined_names)
    if undefined:
        errors.append("引用了未定义的变量：%s" % ", ".join(undefined[:8]))
    unused = sorted(defined - refs - set(aliases_dark))
    if unused:
        errors.append("定义了但没人使用的变量：%s" % ", ".join(unused[:8]))

    outside_style = html.replace(style_text(html), "")
    stray = COLOR_RE.findall(strip_html_comments(outside_style))
    if stray:
        errors.append("<style> 之外出现 %d 处颜色字面量：%s"
                      % (len(stray), ", ".join(sorted(set(stray))[:6])))

    if palette_path.exists():
        palette = json.loads(palette_path.read_text(encoding="utf-8"))
        file_tokens = {item["token"]: item["value"] for item in palette.get("tokens", [])}
        if file_tokens != tokens:
            detail = []
            if set(tokens) - set(file_tokens):
                detail.append("实现新增 " + ", ".join(sorted(set(tokens) - set(file_tokens))[:4]))
            if set(file_tokens) - set(tokens):
                detail.append("palette 多出 " + ", ".join(sorted(set(file_tokens) - set(tokens))[:4]))
            changed = [n for n in set(tokens) & set(file_tokens) if tokens[n] != file_tokens[n]]
            if changed:
                detail.append("改值 " + ", ".join(changed[:4]))
            errors.append("palette.json 的 tokens 与 :root 不同步（%s）；改完请跑 python tools/color_audit.py --write"
                          % ("；".join(detail) or "顺序不同"))

        file_aliases = palette.get("aliases") or {}
        for name in sorted(set(aliases_light) | set(aliases_dark)):
            if name not in file_aliases:
                errors.append("palette 缺少别名 %s" % name)
        for name, pair in file_aliases.items():
            for scheme, parsed in (("light", aliases_light), ("dark", aliases_dark)):
                want = pair.get(scheme)
                # 深色下没重新定义的别名，沿用浅色值
                got = parsed.get(name, aliases_light.get(name))
                if got is None and want is None:
                    continue
                if got is None:
                    errors.append("别名 %s 在 %s 下没有定义" % (name, scheme))
                elif want is None:
                    errors.append("palette 缺少别名 %s 的 %s 值" % (name, scheme))
                elif want.lower() != got.lower():
                    errors.append("别名 %s（%s）不一致：实现 %s / palette %s" % (name, scheme, got, want))

        semantic = {k: v for k, v in (palette.get("semantic") or {}).items() if isinstance(v, str)}
        for role, alias in semantic.items():
            if alias not in aliases_light and alias not in aliases_dark:
                errors.append("semantic.%s 指向不存在的别名：%s" % (role, alias))
    else:
        errors.append("找不到 %s" % palette_path)

    return errors


def write_palette(html: str, palette_path: Path = PALETTE) -> dict:
    _, tokens, aliases_light, aliases_dark, _, _ = parse(style_text(html))
    palette = {}
    if palette_path.exists():
        palette = json.loads(palette_path.read_text(encoding="utf-8"))
    palette["generatedFrom"] = "index.html"
    palette["tokens"] = [{"token": k, "value": v} for k, v in tokens.items()]
    palette["aliases"] = {
        name: {"light": aliases_light[name], "dark": aliases_dark.get(name, aliases_light[name])}
        for name in aliases_light
    }
    semantic = {k: v for k, v in (palette.get("semantic") or {}).items() if isinstance(v, str)}
    palette["semantic"] = semantic
    missing = sorted(set(semantic.values()) - set(aliases_light))
    if missing:
        raise SystemExit("semantic 引用了不存在的别名：%s" % ", ".join(missing))
    palette_path.write_text(json.dumps(palette, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
    return palette


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    html = common.INDEX.read_text(encoding="utf-8")
    if "--readme" in argv and "--write" not in argv:
        write_readme(PALETTE, README)
        print("README 色板已按 palette.json 更新")
        return 0
    if "--write" in argv:
        palette = write_palette(html, PALETTE)
        if "--readme" in argv:
            write_readme(PALETTE, README)
        print("palette.json 已更新：%d token / %d 别名 / %d 语义"
              % (len(palette["tokens"]), len(palette["aliases"]), len(palette.get("semantic") or {})))
        return 0
    errors = audit(html, PALETTE) + audit_readme(PALETTE, README)
    if errors:
        for error in errors:
            print(" - " + error)
        print("色值体系体检失败：%d 项" % len(errors))
        return 1
    _, tokens, aliases_light, _, _, _ = parse(style_text(html))
    print("OK: 色值体系体检通过（%d token / %d 别名；引用全部有定义，palette 同步）"
          % (len(tokens), len(aliases_light)))
    return 0



README = common.REPO_ROOT / "README.md"
README_START = "<!-- palette:start -->"
README_END = "<!-- palette:end -->"
ROLE_LABELS = {
    "pageBg": "页面底色", "textMain": "主文字", "rowPastBg": "已结束行",
    "rowTodayBg": "今天行", "rowTomorrowBg": "明天行", "rowNextBg": "下一次行",
    "conflictBorder": "冲突描边", "conflictBg": "冲突底色",
    "statusOkBg": "成功状态底", "statusOkText": "成功状态字",
}


def render_readme_block(palette: dict) -> str:
    aliases = palette.get("aliases") or {}
    semantic = palette.get("semantic") or {}
    rows = ["| 语义 | 别名 | 浅色 | 深色 |", "|---|---|---|---|"]
    for role, alias in semantic.items():
        pair = aliases.get(alias) or {}
        rows.append("| %s | `%s` | `%s` | `%s` |"
                    % (ROLE_LABELS.get(role, role), alias, pair.get("light", "—"), pair.get("dark", "—")))
    return "\n".join(rows)


def audit_readme(palette_path: Path = PALETTE, readme_path: Path = README) -> list:
    if not readme_path.exists():
        return []
    palette = json.loads(palette_path.read_text(encoding="utf-8")) if palette_path.exists() else {}
    text = readme_path.read_text(encoding="utf-8")
    if README_START not in text or README_END not in text:
        return ["README 缺少 %s / %s 标记" % (README_START, README_END)]
    current = text.split(README_START, 1)[1].split(README_END, 1)[0].strip()
    expected = render_readme_block(palette).strip()
    if current != expected:
        return ["README 色板与 palette.json 不同步；跑 python tools/color_audit.py --readme"]
    return []


def write_readme(palette_path: Path = PALETTE, readme_path: Path = README) -> None:
    palette = json.loads(palette_path.read_text(encoding="utf-8"))
    text = readme_path.read_text(encoding="utf-8")
    block = "\n%s\n%s\n%s\n" % (README_START, render_readme_block(palette), README_END)
    if README_START in text:
        head, rest = text.split(README_START, 1)
        tail = rest.split(README_END, 1)[1]
        text = head.rstrip() + "\n\n" + block.strip() + "\n" + tail.lstrip()
    else:
        text = text.rstrip() + "\n\n" + block
    readme_path.write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    sys.exit(main())
