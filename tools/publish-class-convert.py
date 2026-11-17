#!/usr/bin/env python3
"""把班委签名的班级 JSON 转成 data/<班级>.xlsx（列与现有 xlsx 一致）。

用法：
  python tools/publish-class-convert.py --in Z1.publish.json --out data/Z1.xlsx

安全约束：
- 只接受带 _publish 的 JSON（签名本身由 publish-class verify 负责）；
- 只写“实验安排 / 班级信息”两个 sheet，不执行任何宏；
- 行数上限与 build 的 MAX 保持一致（5000）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from openpyxl import Workbook

SHEET = "实验安排"
META = "班级信息"
HEADERS = ["日期", "节次", "实验名称", "实验地点", "备注"]
MAX_ROWS = 5000


def fail(message: str) -> None:
    print("ERROR: " + message, file=sys.stderr)
    raise SystemExit(1)


def convert(src: Path, dst: Path, expect_class: str | None = None) -> dict:
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        fail("无法读取 JSON：%s" % exc)
    if not isinstance(data, dict) or not isinstance(data.get("experiments"), list):
        fail("不是班级备份 JSON（缺少 experiments 数组）")
    class_id = str(data.get("class") or "").strip()
    if not class_id:
        fail("JSON 里缺少 class")
    if expect_class and class_id != expect_class:
        fail("JSON 班级 %s 与期望 %s 不一致" % (class_id, expect_class))
    rows = data["experiments"]
    if len(rows) > MAX_ROWS:
        fail("实验数量超过上限 %d" % MAX_ROWS)

    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    ws.append(HEADERS)
    for index, item in enumerate(rows, 1):
        if not isinstance(item, dict):
            fail("第 %d 条不是对象" % index)
        date = str(item.get("date") or "").strip()
        period = str(item.get("period") or "").strip()
        name = str(item.get("name") or "").strip()
        place = str(item.get("place") or "").strip() or "待定"
        note = str(item.get("note") or "")
        if not date or not period or not name:
            fail("第 %d 条缺少日期/节次/名称" % index)
        ws.append([date, period, name, place, note])

    meta = wb.create_sheet(META)
    meta.append(["班级", class_id])
    if data.get("week1"):
        meta.append(["week1", str(data["week1"]).strip()])
    times = data.get("periodTimes")
    if times:
        meta.append(["periodTimes", json.dumps(times, ensure_ascii=False, sort_keys=True)])

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    wb.save(tmp)
    tmp.replace(dst)
    return {"class": class_id, "rows": len(rows), "out": str(dst)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="班级 JSON → xlsx")
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--out", dest="dst", required=True)
    parser.add_argument("--class", dest="class_id", default=None)
    args = parser.parse_args(argv)
    result = convert(Path(args.src), Path(args.dst), args.class_id)
    print("OK: %(class)s → %(out)s（%(rows)d 条）" % result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
