import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("publish_convert", ROOT / "tools" / "publish-class-convert.py")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["publish_convert"] = MODULE
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class PublishConvertTest(unittest.TestCase):
    def test_convert_writes_sheets_and_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "Z1.publish.json"
            dst = Path(tmp) / "data" / "Z1.xlsx"
            write_json(src, {
                "class": "Z1",
                "week1": "2026-08-31",
                "periodTimes": {"5-6": ["13:30", "15:10"]},
                "experiments": [
                    {"date": "2026-11-20", "period": "第5-6节", "name": "甲", "place": "A101", "note": ""},
                    {"date": "2026-11-27", "period": "第5-6节", "name": "乙", "place": "A102", "note": "带材料"},
                ],
            })
            result = MODULE.convert(src, dst, "Z1")
            self.assertEqual(result["rows"], 2)
            wb = load_workbook(dst)
            self.assertEqual(wb.sheetnames, ["实验安排", "班级信息"])
            rows = list(wb["实验安排"].iter_rows(values_only=True))
            self.assertEqual(list(rows[0]), ["日期", "节次", "实验名称", "实验地点", "备注"])
            self.assertEqual(rows[1][:4], ("2026-11-20", "第5-6节", "甲", "A101"))
            self.assertEqual(rows[2][4], "带材料")
            meta = dict(wb["班级信息"].iter_rows(values_only=True))
            self.assertEqual(meta["班级"], "Z1")
            self.assertEqual(meta["week1"], "2026-08-31")
            self.assertIn("5-6", meta["periodTimes"])
            wb.close()

    def test_class_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "Z1.json"
            dst = Path(tmp) / "Z1.xlsx"
            write_json(src, {"class": "Z2", "experiments": []})
            with self.assertRaises(SystemExit):
                MODULE.convert(src, dst, "Z1")

    def test_missing_experiments_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "Z1.json"
            dst = Path(tmp) / "Z1.xlsx"
            write_json(src, {"class": "Z1"})
            with self.assertRaises(SystemExit):
                MODULE.convert(src, dst, "Z1")

    def test_missing_required_field_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "Z1.json"
            dst = Path(tmp) / "Z1.xlsx"
            write_json(src, {"class": "Z1", "experiments": [{"date": "2026-11-20", "period": "第1-2节"}]})
            with self.assertRaises(SystemExit):
                MODULE.convert(src, dst, "Z1")


if __name__ == "__main__":
    unittest.main()
