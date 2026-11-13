"""Focused regression tests for the xlsx build reader.

These tests cover the part of the build that is easiest to break when the
per-class week1 / 班级信息 metadata changes: worksheet selection, metadata
validation and week-based date conversion.
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from datetime import date
from pathlib import Path

from openpyxl import Workbook

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_html", BASE / "build-html.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def make_workbook(path: Path, headers, rows, meta=None, data_sheet="实验安排"):
    wb = Workbook()
    ws = wb.active
    ws.title = data_sheet
    ws.append(headers)
    for row in rows:
        ws.append(row)

    if meta is not None:
        ms = wb.create_sheet("班级信息")
        ms.append(["键", "值"])
        for key, value in meta.items():
            ms.append([key, value])

    wb.save(path)
    wb.close()


class BuildReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_class_week1_metadata(self):
        path = self.dir / "Z1.xlsx"
        make_workbook(
            path,
            ["周次", "星期", "节次", "实验名称", "实验地点", "备注"],
            [["第2周", "星期二", "第1-2节", "测试实验", "A101", "备注"]],
            {"备份格式版本": "1", "班级": "Z1", "week1": "2026-09-07"},
        )
        meta = BUILD.read_class_meta(path, "Z1")
        self.assertEqual(meta["week1"], "2026-09-07")

        rows = BUILD.read_class_file(path, "Z1", date(2026, 9, 7))
        self.assertEqual(rows[0]["date"], "2026-09-15")
        self.assertEqual(rows[0]["name"], "测试实验")

    def test_metadata_class_mismatch_stops_build(self):
        path = self.dir / "Z1.xlsx"
        make_workbook(
            path,
            ["日期", "节次", "实验名称", "实验地点"],
            [["2026-09-15", "第1-2节", "测试实验", "A101"]],
            {"班级": "Z9"},
        )
        with self.assertRaises(SystemExit):
            BUILD.read_class_meta(path, "Z1")

    def test_invalid_metadata_week1_stops_build(self):
        path = self.dir / "Z1.xlsx"
        make_workbook(
            path,
            ["日期", "节次", "实验名称", "实验地点"],
            [["2026-09-15", "第1-2节", "测试实验", "A101"]],
            {"班级": "Z1", "week1": "2026-13-01"},
        )
        with self.assertRaises(SystemExit):
            BUILD.read_class_meta(path, "Z1")

    def test_non_monday_metadata_week1_stops_build(self):
        path = self.dir / "Z1.xlsx"
        make_workbook(
            path,
            ["日期", "节次", "实验名称", "实验地点"],
            [["2026-09-15", "第1-2节", "测试实验", "A101"]],
            {"班级": "Z1", "week1": "2026-09-08"},
        )
        with self.assertRaises(SystemExit):
            BUILD.read_class_meta(path, "Z1")

    def test_old_seven_column_file_still_reads(self):
        path = self.dir / "Z2.xlsx"
        make_workbook(
            path,
            ["日期", "周次", "星期", "节次", "实验名称", "实验地点", "备注"],
            [["2026-10-12", "第7周", "星期一", "第5-6节", "旧实验", "218", ""]],
        )
        rows = BUILD.read_class_file(path, "Z2", date(2026, 8, 31))
        self.assertEqual(rows[0]["date"], "2026-10-12")
        self.assertEqual(rows[0]["note"], "")

    def test_data_sheet_is_preferred_over_first_sheet(self):
        path = self.dir / "Z1.xlsx"
        wb = Workbook()
        first = wb.active
        first.title = "说明"
        first.append(["不是数据"])
        data = wb.create_sheet("实验安排")
        data.append(["日期", "节次", "实验名称", "实验地点"])
        data.append(["2026-09-15", "第1-2节", "测试实验", "A101"])
        wb.save(path)
        wb.close()

        rows = BUILD.read_class_file(path, "Z1", date(2026, 9, 7))
        self.assertEqual(rows[0]["name"], "测试实验")


if __name__ == "__main__":
    unittest.main()
