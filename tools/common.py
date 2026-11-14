"""三个工具脚本（build / verify / validate_data）共用的小工具。

放在这里的目的只有一个：把原先三份重复的路径、原子写入和动态导入逻辑收成一份。
本模块不做任何 I/O 副作用，导入它就只是拿到几个函数和常量。
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

# 仓库根目录（index.html / data/ 所在处）。tools/ 的上一层。
REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
DATA_DIR = REPO_ROOT / "data"
SETTINGS = DATA_DIR / "设置.json"
INDEX = REPO_ROOT / "index.html"
CALENDARS_DIR = REPO_ROOT / "calendars"
PAGE_404 = REPO_ROOT / "404.html"

# 用于跨模块 import 时把仓库根放进 sys.path（工具脚本互相加载时会用到）。
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def write_atomic(path: Path, data: bytes) -> None:
    """先写临时文件再替换：中途失败不会留下半个页面。

    原先 build.py 和 verify.py 各抄了一份，实现完全一样。
    """
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def load_module(path: Path, name: str):
    """按文件路径导入一个脚本（文件名可能带连字符，不能直接 import）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 %s" % path.name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def latest_data_commit() -> str:
    """data/ 最后一次提交的日期（YYYY-MM-DD）；没有 git / 没有提交时返回空串。

    build.py 用它决定页面顶部"数据更新至"，validate_data.py 用它检查 updatedAt 是否滞后。
    """
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", "data"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()
