#!/usr/bin/env python3
"""构建前的数据体检：把 data/*.xlsx 与 data/设置.json 的问题一次列全，说人话。

用法：
    python validate-data.py          # 只检查，不修改任何文件
    python validate-data.py --quiet  # 只在有问题时输出

与 build-html.py 的区别：build 遇到第一个错误就退出，适合"确定要构建"；
本脚本把所有能查的问题都收集起来，适合"改完 Excel 先看一眼"。
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import date
from pathlib import Path

from openpyxl import load_workbook

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
SETTINGS = DATA_DIR / "设置.json"
META_SHEET = "班级信息"
MIN_PERIOD, MAX_PERIOD = 1, 14
MAX_NAME, MAX_PLACE, MAX_NOTE = 200, 200, 500


def load_build_module():
    """复用 build-html.py 的解析逻辑，保证两边口径一致。"""
    spec = importlib.util.spec_from_file_location("crsecue_build", BASE / "build-html.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load_build_module()


def text_of(value):
    if value is None:
        return ""
    return str(value).replace("\u3000", " ").strip()


def check_settings(errors, warnings):
    if not SETTINGS.exists():
        errors.append("找不到 data/设置.json")
        return
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        errors.append("data/设置.json 不是有效 JSON：%s" % exc)
        return
    if not isinstance(data, dict) or data.get("version") != 1:
        errors.append("data/设置.json 的 version 必须是 1")
    week1 = data.get("week1")
    if not isinstance(week1, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week1):
        errors.append("data/设置.json 的 week1 必须是 YYYY-MM-DD")
    else:
        try:
            parsed = date.fromisoformat(week1)
        except ValueError:
            errors.append("data/设置.json 的 week1 不是有效日期：%s" % week1)
        else:
            if parsed.weekday() != 0:
                errors.append("data/设置.json 的 week1 必须是星期一（现在是星期%s）"
                              % "一二三四五六日"[parsed.weekday()])
    updated = data.get("updatedAt")
    if updated is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(updated)):
        errors.append("data/设置.json 的 updatedAt 必须是 YYYY-MM-DD")
    times = data.get("periodTimes")
    if times is not None:
        try:
            BUILD.parse_period_times(times, "data/设置.json")
        except SystemExit as exc:
            errors.append(str(exc))


def read_meta(path, errors):
    """读班级信息页；返回 dict。任何格式问题记到 errors。"""
    meta = {}
    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except Exception as exc:
        errors.append("%s 无法读取：%s" % (path.name, exc))
        return meta
    try:
        if META_SHEET not in wb.sheetnames:
            return meta
        for row in wb[META_SHEET].iter_rows(values_only=True):
            values = list(row) if row else []
            if not values:
                continue
            key = text_of(values[0])
            if not key:
                continue
            meta[key] = text_of(values[1]) if len(values) > 1 else ""
        return meta
    finally:
        wb.close()


def check_class(path, errors, warnings):
    class_id = path.stem
    if not re.fullmatch(r"[\w\u4e00-\u9fa5 .\-]{1,40}", class_id):
        errors.append("%s：文件名不像班级名（允许中英文、数字、空格、点、连字符，最长 40）" % path.name)

    meta = read_meta(path, errors)
    meta_class = meta.get("班级", "")
    if meta_class and meta_class != class_id:
        errors.append("%s：班级信息写的是「%s」，与文件名不一致" % (path.name, meta_class))
    week1 = meta.get("week1", "")
    if week1:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week1):
            errors.append("%s：班级信息 week1 必须是 YYYY-MM-DD" % path.name)
        else:
            try:
                parsed = date.fromisoformat(week1)
            except ValueError:
                errors.append("%s：班级信息 week1 不是有效日期" % path.name)
            else:
                if parsed.weekday() != 0:
                    errors.append("%s：班级信息 week1 必须是星期一" % path.name)
    if meta.get("periodTimes"):
        try:
            BUILD.parse_period_times(meta["periodTimes"], "%s 的班级信息" % path.name)
        except SystemExit as exc:
            errors.append(str(exc))

    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except Exception as exc:
        errors.append("%s 无法读取：%s" % (path.name, exc))
        return 0
    try:
        ws = wb["实验安排"] if "实验安排" in wb.sheetnames else wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
    finally:
        wb.close()
    if not rows:
        errors.append("%s：实验安排是空工作表" % path.name)
        return 0

    header = [text_of(cell) for cell in rows[0]]
    if not header or all(not cell for cell in header):
        errors.append("%s：第一行必须是表头" % path.name)
        return 0
    col = {name: i for i, name in enumerate(header) if name}
    for needed in ("实验名称",):
        if needed not in col:
            errors.append("%s：表头缺少「%s」列" % (path.name, needed))
    if "日期" not in col and not ("周次" in col and "星期" in col):
        errors.append("%s：表头需要「日期」列，或「周次」+「星期」两列" % path.name)

    seen = {}
    counted = 0
    for index, row in enumerate(rows[1:], start=2):
        values = list(row) if row else []
        def cell(name):
            pos = col.get(name)
            return text_of(values[pos]) if pos is not None and pos < len(values) else ""

        name = cell("实验名称")
        period = cell("节次")
        date_text = cell("日期")
        week_text = cell("周次")
        weekday_text = cell("星期")
        if not any([name, period, date_text, week_text, weekday_text]):
            continue
        counted += 1

        if not name:
            errors.append("%s 第 %d 行：实验名称为空" % (path.name, index))
        elif len(name) > MAX_NAME:
            errors.append("%s 第 %d 行：实验名称超过 %d 字" % (path.name, index, MAX_NAME))

        if not period:
            errors.append("%s 第 %d 行：节次为空" % (path.name, index))
        else:
            ranges = BUILD.parse_period_ranges(period)
            if not ranges:
                errors.append("%s 第 %d 行：节次「%s」看不懂（示例：第3-4节）" % (path.name, index, period))
            else:
                low = min(r[0] for r in ranges)
                high = max(r[1] for r in ranges)
                if low < MIN_PERIOD or high > MAX_PERIOD:
                    errors.append("%s 第 %d 行：节次「%s」超出 %d-%d 的范围"
                                  % (path.name, index, period, MIN_PERIOD, MAX_PERIOD))

        if date_text:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                errors.append("%s 第 %d 行：日期「%s」必须是 YYYY-MM-DD" % (path.name, index, date_text))
            else:
                try:
                    date.fromisoformat(date_text)
                except ValueError:
                    errors.append("%s 第 %d 行：日期「%s」不存在" % (path.name, index, date_text))
        elif not (week_text and weekday_text):
            errors.append("%s 第 %d 行：日期为空，且周次/星期也没填全" % (path.name, index))

        for label, value, limit in (("实验地点", cell("实验地点"), MAX_PLACE), ("备注", cell("备注"), MAX_NOTE)):
            if len(value) > limit:
                errors.append("%s 第 %d 行：%s超过 %d 字" % (path.name, index, label, limit))

        if name and period and date_text:
            key = (date_text, BUILD.norm_key_text(period), BUILD.norm_key_text(name))
            if key in seen:
                warnings.append("%s：第 %d 行与第 %d 行疑似重复（%s %s %s）"
                                % (path.name, index, seen[key], date_text, period, name))
            else:
                seen[key] = index
    return counted


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    quiet = "--quiet" in argv

    errors, warnings = [], []
    check_settings(errors, warnings)

    files = sorted(p for p in DATA_DIR.glob("*.xlsx") if not p.name.startswith("~$"))
    total = 0
    if not files:
        errors.append("data/ 下没有任何班级 xlsx")
    for path in files:
        total += check_class(path, errors, warnings)

    if not quiet or errors or warnings:
        print("检查 %d 个班级文件，共 %d 条实验" % (len(files), total))
        for item in warnings:
            print("  [!] " + item)
        for item in errors:
            print("  [x] " + item)

    if errors:
        print("\n发现 %d 个问题，修完再构建。" % len(errors))
        return 1
    if warnings:
        print("\n没有错误；%d 条提醒建议人工确认。" % len(warnings))
    else:
        print("\n数据检查通过，没有发现问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
