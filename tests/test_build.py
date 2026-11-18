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
SPEC = importlib.util.spec_from_file_location("build_html", BASE / "tools" / "build.py")
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


class IcsUidStabilityTests(unittest.TestCase):
    """订阅端的去重靠 UID：UID 必须与构建时间无关、与输入顺序无关、互不重复。"""

    EVENTS = [
        {"date": "2026-11-20", "period": "第1-2节", "name": "机械设计", "place": "A114", "note": ""},
        {"date": "2026-11-30", "period": "第7-8节", "name": "形势与政策", "place": "三山楼106", "note": "带备注"},
        {"date": "2026-12-07", "period": "第3-4节", "name": "控制工程", "place": "", "note": ""},
    ]

    @staticmethod
    def uids(text):
        return [line for line in text.splitlines() if line.startswith("UID:")]

    def build(self, class_id="Z2", events=None, stamp="20261106T000000Z"):
        return BUILD.build_ics_text(class_id, events or self.EVENTS, stamp)

    def test_uid_does_not_depend_on_build_stamp(self):
        # 两次构建的 DTSTAMP 不同，UID 必须完全一致，否则订阅端会出现重复事件
        first = self.uids(self.build(stamp="20261106T000000Z"))
        second = self.uids(self.build(stamp="20271231T235959Z"))
        self.assertEqual(first, second)

    def test_uid_does_not_depend_on_input_order(self):
        forward = sorted(self.uids(self.build()))
        backward = sorted(self.uids(self.build(events=list(reversed(self.EVENTS)))))
        self.assertEqual(forward, backward)

    def test_uid_unique_within_one_calendar(self):
        uids = self.uids(self.build())
        self.assertEqual(len(uids), len(self.EVENTS))
        self.assertEqual(len(uids), len(set(uids)))

    def test_uid_differs_between_classes(self):
        # 同一个班同一节课若换班导出，UID 必须不同，否则两个班订阅后会互相覆盖
        z2 = self.uids(self.build(class_id="Z2"))
        z5 = self.uids(self.build(class_id="Z5"))
        self.assertEqual(len(set(z2) & set(z5)), 0)

    def test_ics_declares_vtimezone_and_tzid(self):
        """订阅端在别的时区也要换算正确：必须带 VTIMEZONE 块，且定时事件用 TZID 引用。"""
        text = self.build()
        self.assertIn("BEGIN:VTIMEZONE", text)
        self.assertIn("TZID:Asia/Shanghai", text)
        self.assertIn("TZOFFSETFROM:+0800", text)
        self.assertIn("TZOFFSETTO:+0800", text)
        self.assertIn("DTSTART;TZID=Asia/Shanghai:", text)
        # 时区块必须在事件之前（RFC 5545 要求先声明再引用）
        self.assertLess(text.index("BEGIN:VTIMEZONE"), text.index("BEGIN:VEVENT"))

    def test_timed_events_use_tzid_and_unparsable_events_fall_back_to_all_day(self):
        timed = self.build(events=[{"date": "2026-11-20", "period": "第1-2节", "name": "定时", "place": "", "note": ""}])
        self.assertIn("DTSTART;TZID=Asia/Shanghai:20261120T080000", timed)
        self.assertNotIn("VALUE=DATE", timed)

        all_day = self.build(events=[{"date": "2026-11-20", "period": "待定", "name": "全天", "place": "", "note": ""}])
        self.assertIn("DTSTART;VALUE=DATE:20261120", all_day)
        self.assertNotIn("TZID=Asia/Shanghai:20261120", all_day)

    def test_uid_is_hash_not_timestamp(self):
        uids = self.uids(self.build())
        for uid in uids:
            self.assertNotIn("T000000Z", uid, "UID 不能包含构建时间戳")
            self.assertTrue(uid.endswith("@crsecue"), "UID 需要固定域后缀便于识别")


if __name__ == "__main__":
    unittest.main()


class IcsTextEscapingTests(unittest.TestCase):
    """RFC 5545 TEXT 里的换行必须是字面量 \\n，产物里不能出现裸 LF。"""

    def make_ics(self, note):
        return BUILD.build_ics_text(
            "Z1",
            [{"date": "2026-12-03", "period": "第3-4节", "name": "实验", "place": "A101", "note": note}],
            "20261120T000000Z",
            None,
        )

    def assert_no_bare_lf(self, text):
        bare = text.count("\n") - text.count("\r\n")
        self.assertEqual(bare, 0, "ICS 里出现裸 LF：%r" % text[:120])

    def test_note_newline_is_escaped(self):
        text = self.make_ics("机械楼东侧\n小楼梯上2楼")
        self.assert_no_bare_lf(text)
        self.assertIn("\\n", text)

    def test_note_crlf_is_escaped(self):
        text = self.make_ics("第一行\r\n第二行")
        self.assert_no_bare_lf(text)
        self.assertIn("\\n", text)


class IcsRefreshHintTests(unittest.TestCase):
    """订阅刷新提示 + 稳定 LAST-MODIFIED/SEQUENCE。"""

    EVENT = [{"date": "2026-12-03", "period": "第3-4节", "name": "实验", "place": "A101", "note": ""}]

    def make(self, stamp):
        return BUILD.build_ics_text("Z1", self.EVENT, stamp, None)

    def test_calendar_has_hourly_hints_once(self):
        text = self.make("20261120T000000Z")
        self.assertEqual(text.count("REFRESH-INTERVAL;VALUE=DURATION:PT1H"), 1)
        self.assertEqual(text.count("X-PUBLISHED-TTL:PT1H"), 1)

    def test_each_event_has_last_modified_and_sequence(self):
        text = self.make("20261120T000000Z")
        self.assertEqual(text.count("LAST-MODIFIED:20261120T000000Z"), 1)
        self.assertEqual(text.count("SEQUENCE:"), 1)

    def test_same_stamp_is_stable(self):
        self.assertEqual(self.make("20261120T000000Z"), self.make("20261120T000000Z"))

    def test_sequence_changes_when_updated_at_changes(self):
        a = self.make("20261120T000000Z")
        b = self.make("20261201T000000Z")
        self.assertIn("LAST-MODIFIED:20261201T000000Z", b)
        self.assertNotIn("SEQUENCE:" + a.split("SEQUENCE:")[1].split("\r\n")[0], b)
        self.assertNotEqual(a, b)

