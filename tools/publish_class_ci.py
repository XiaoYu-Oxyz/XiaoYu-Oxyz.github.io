#!/usr/bin/env python3
"""班级自助发布的构建/签名编排（替代 workflow 里的 shell 拼接）。

为什么要有这个脚本：workflow 里用 shell 计算 N、调 build/manifest/sign，
曾经出现 `index.html` 仍是旧 release/旧数据的问题（N 为空或被旧文件覆盖）。
这里全部用 Python 顺序执行并**硬校验**，任何一项不满足直接非零退出。

用法：
  python tools/publish_class_ci.py --class Z2 --publish /tmp/publish.json
  RELEASE_SIGNING_KEY_FILE=/tmp/release.pem python tools/publish_class_ci.py ...
  python tools/publish_class_ci.py --class Z2 --publish ... --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INDEX = BASE / "index.html"
LOG = BASE / "release" / "log.jsonl"
TEMPLATE_RE = re.compile(r'<template id="defaultData">([\s\S]*?)</template>')


def run(args):
    print("+ " + " ".join(str(a) for a in args), flush=True)
    subprocess.run(args, cwd=BASE, check=True)


def next_release() -> int:
    if not LOG.exists():
        return 1
    lines = [line for line in LOG.read_text(encoding="utf-8").splitlines() if line.strip()]
    return (json.loads(lines[-1])["n"] + 1) if lines else 1


def payload_experiments(path: Path) -> list:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("experiments")
    if not isinstance(rows, list):
        raise SystemExit("publish.json 缺少 experiments 数组")
    return rows


def index_payload() -> dict:
    html = INDEX.read_text(encoding="utf-8")
    match = TEMPLATE_RE.search(html)
    if not match:
        raise SystemExit("index.html 里找不到 defaultData 模板")
    return json.loads(match.group(1)), html


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--class", dest="cls", required=True)
    parser.add_argument("--publish", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    publish = Path(args.publish)
    rows = payload_experiments(publish)
    release = next_release()
    print("release = %d，实验 %d 条" % (release, len(rows)), flush=True)

    run([sys.executable, "tools/build.py", "--release", str(release)])

    payload, html = index_payload()
    if ("release %d ·" % release) not in html:
        raise SystemExit("FAIL: index.html 未包含 release %d" % release)
    classes = {item.get("id"): item for item in payload.get("classes", [])}
    got = classes.get(args.cls, {}).get("experiments", [])
    if len(got) != len(rows):
        raise SystemExit("FAIL: index.html 中 %s 有 %d 条，publish.json 有 %d 条" % (args.cls, len(got), len(rows)))

    if args.dry_run:
        print("dry-run OK：index 已更新到 release %d，%s %d 条" % (release, args.cls, len(rows)))
        return 0

    key_path = os.environ.get("RELEASE_SIGNING_KEY_FILE", "")
    if not key_path or not Path(key_path).exists():
        raise SystemExit("FAIL: 缺少 RELEASE_SIGNING_KEY_FILE（CI secret 未配置）")
    # Node CLI
    run(["node", "tools/release.mjs", "manifest", "--release", str(release), "--signer", "ci-release"])
    run(["node", "tools/release.mjs", "sign", "--key", key_path, "--signer", "ci-release"])
    run(["node", "tools/release.mjs", "verify"])

    status = subprocess.run(["git", "status", "--porcelain"], cwd=BASE, capture_output=True, text=True, check=True).stdout
    if "index.html" not in status:
        raise SystemExit("FAIL: git status 里没有 index.html，构建产物没有进入提交")
    print("OK: release %d，%s %d 条，index.html 已更新" % (release, args.cls, len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
