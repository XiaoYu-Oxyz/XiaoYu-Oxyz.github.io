"""tools/validate_data.py 的回归测试。

它是"改完 Excel 先看一眼"的第一道关：报错要准、不能把合法数据判成错，
也不能对明显的坏数据沉默。测试通过临时目录 + 临时 xlsx 覆盖模块里的
DATA_DIR / SETTINGS，不碰仓库里的真实数据。
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook, load_workbook

BASE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("validate_data", BASE / "tools" / "validate_data.py")
VALIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATE)

HEADERS = ["日期", "周次", "星期", "节次", "实验名称", "实验地点", "备注"]
GOOD_ROW = ["2026-11-02", 10, "星期一", "第3-4节", "机械设计", "A114", ""]


def make_class_file(path: Path, rows, meta=None):
    wb = Workbook()
    ws = wb.active
    ws.title = "实验安排"
    ws.append(HEADERS)
    for row in rows:
        ws.append(row)
    if meta is not None:
        sheet = wb.create_sheet("班级信息")
        sheet.append(["键", "值"])
        for key, value in meta.items():
            sheet.append([key, value])
    wb.save(path)
    wb.close()


class ValidatorCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._old_data_dir = VALIDATE.DATA_DIR
        self._old_settings = VALIDATE.SETTINGS
        self._old_latest = VALIDATE.latest_data_commit
        VALIDATE.DATA_DIR = self.tmp
        VALIDATE.SETTINGS = self.tmp / "设置.json"
        # 不依赖真实仓库的 git 历史：默认当作"没有 git"
        VALIDATE.latest_data_commit = lambda: ""
        self.write_settings()

    def tearDown(self):
        VALIDATE.DATA_DIR = self._old_data_dir
        VALIDATE.SETTINGS = self._old_settings
        VALIDATE.latest_data_commit = self._old_latest
        self._tmp.cleanup()

    def write_settings(self, **overrides):
        payload = {"version": 1, "week1": "2026-08-31", "updatedAt": "2026-11-06"}
        payload.update(overrides)
        VALIDATE.SETTINGS.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def run_main(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = VALIDATE.main([])
        return code, buffer.getvalue()


class SettingsTests(ValidatorCase):
    def test_valid_settings_reports_nothing(self):
        errors, warnings = [], []
        VALIDATE.check_settings(errors, warnings)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_week1_must_be_monday(self):
        self.write_settings(week1="2026-08-30")  # 星期日
        errors, warnings = [], []
        VALIDATE.check_settings(errors, warnings)
        self.assertTrue(any("星期一" in item for item in errors), errors)

    def test_bad_period_times_is_reported(self):
        self.write_settings(periodTimes={"5-6": ["15:10", "13:30"]})
        errors, warnings = [], []
        VALIDATE.check_settings(errors, warnings)
        self.assertTrue(any("开始时间必须早于结束时间" in item for item in errors), errors)

    def test_bad_updated_at_format(self):
        self.write_settings(updatedAt="2026/11/06")
        errors, warnings = [], []
        VALIDATE.check_settings(errors, warnings)
        self.assertTrue(any("updatedAt" in item for item in errors), errors)


class ClassFileTests(ValidatorCase):
    def collect(self, rows, meta=None, name="Z1.xlsx"):
        path = self.tmp / name
        make_class_file(path, rows, meta)
        errors, warnings = [], []
        counted = VALIDATE.check_class(path, errors, warnings)
        return counted, errors, warnings

    def test_valid_class_has_no_issues(self):
        counted, errors, warnings = self.collect([GOOD_ROW], {"班级": "Z1"})
        self.assertEqual(counted, 1)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_class_name_must_match_file_name(self):
        _, errors, _ = self.collect([GOOD_ROW], {"班级": "Z2"})
        self.assertTrue(any("与文件名不一致" in item for item in errors), errors)

    def test_bad_date_format_and_impossible_date(self):
        _, errors, _ = self.collect([
            ["2026/11/09", "", "", "第3-4节", "机械设计", "A114", ""],
            ["2026-02-30", "", "", "第3-4节", "机械设计", "A114", ""],
        ], {"班级": "Z1"})
        self.assertTrue(any("必须是 YYYY-MM-DD" in item for item in errors), errors)
        self.assertTrue(any("不存在" in item for item in errors), errors)

    def test_period_out_of_range(self):
        _, errors, _ = self.collect([
            ["2026-11-09", "", "", "第99节", "机械设计", "A114", ""],
        ], {"班级": "Z1"})
        self.assertTrue(any("超出 1-14 的范围" in item for item in errors), errors)

    def test_empty_name_and_missing_time(self):
        _, errors, _ = self.collect([
            ["", "", "", "第3-4节", "", "A114", ""],
        ], {"班级": "Z1"})
        self.assertTrue(any("实验名称为空" in item for item in errors), errors)
        self.assertTrue(any("日期为空" in item for item in errors), errors)

    def test_duplicate_rows_are_warnings_not_errors(self):
        _, errors, warnings = self.collect([GOOD_ROW, GOOD_ROW], {"班级": "Z1"})
        self.assertEqual(errors, [])
        self.assertTrue(any("疑似重复" in item for item in warnings), warnings)

    def test_merged_cells_are_reported(self):
        # 合并单元格：左上角以外的行会读成空值，报错却是"第 N 行…为空"
        path = self.tmp / "Z1.xlsx"
        make_class_file(path, [GOOD_ROW, GOOD_ROW, GOOD_ROW], {"班级": "Z1"})
        wb = load_workbook(path)
        ws = wb["实验安排"]
        ws.merge_cells("E2:E3")
        wb.save(path)
        wb.close()
        errors, warnings = [], []
        VALIDATE.check_class(path, errors, warnings)
        # 合并后第 3 行的名称读成空 → 报错；警告要指出这是合并导致的
        self.assertTrue(any("实验名称为空" in item for item in errors), errors)
        self.assertTrue(any("合并单元格" in item for item in warnings), warnings)
        self.assertTrue(any("E2:E3" in item for item in warnings), warnings)


class MainExitCodeTests(ValidatorCase):
    def test_clean_data_exits_zero(self):
        make_class_file(self.tmp / "Z1.xlsx", [GOOD_ROW], {"班级": "Z1"})
        code, output = self.run_main()
        self.assertEqual(code, 0, output)
        self.assertIn("数据检查通过", output)

    def test_broken_data_exits_one_and_lists_problems(self):
        make_class_file(self.tmp / "Z1.xlsx", [
            ["2026/11/09", "", "", "第99节", "", "A114", ""],
        ], {"班级": "Z1"})
        code, output = self.run_main()
        self.assertEqual(code, 1, output)
        self.assertIn("个问题", output)
        self.assertIn("超出 1-14 的范围", output)

    def test_no_class_files_is_an_error(self):
        code, output = self.run_main()
        self.assertEqual(code, 1, output)
        self.assertIn("没有任何班级 xlsx", output)


if __name__ == "__main__":
    unittest.main()

