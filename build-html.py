#!/usr/bin/env python3
"""Build the deployable HTML from data/*.xlsx + data/设置.json.

Usage:
    python build-html.py            # build with data/设置.json's updatedAt
    python build-html.py --stamp    # also set data/设置.json updatedAt = today

Rules:
  - class name = xlsx filename stem (data/Z1.xlsx -> Z1)
  - the worksheet named 实验安排 is used when present, otherwise the first worksheet
  - that worksheet's name is otherwise ignored
  - base headers: 节次 / 实验名称 / 实验地点
  - time: 日期, or 周次+星期; either group is enough, both allowed
  - per row: valid 周次+星期 wins, otherwise fall back to 日期
  - optional 备注 column (exported last); old 6-column files are accepted
  - shared week1 comes from data/设置.json

The default data is written into the inert <template id="defaultData"> JSON,
so changing data does NOT change the CSP hashes. Code changes still require
verify-csp.py --apply.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
SETTINGS = DATA_DIR / "设置.json"
DEPLOY = BASE / "index.html"
ICS_SUFFIX = ".ics"

TEMPLATE_RE = re.compile(r'(<template id="defaultData">)([\s\S]*?)(</template>)')
META_SHEET_NAME = "班级信息"
REQUIRED = ["节次", "实验名称", "实验地点"]
WEEKDAY_MAP = {
    "星期一": 1, "周一": 1, "礼拜一": 1, "一": 1, "1": 1,
    "星期二": 2, "周二": 2, "礼拜二": 2, "二": 2, "2": 2,
    "星期三": 3, "周三": 3, "礼拜三": 3, "三": 3, "3": 3,
    "星期四": 4, "周四": 4, "礼拜四": 4, "四": 4, "4": 4,
    "星期五": 5, "周五": 5, "礼拜五": 5, "五": 5, "5": 5,
    "星期六": 6, "周六": 6, "礼拜六": 6, "六": 6, "6": 6,
    "星期日": 7, "星期天": 7, "周日": 7, "周天": 7,
    "礼拜日": 7, "礼拜天": 7, "日": 7, "天": 7, "7": 7, "0": 7,
}

MAX_EXPERIMENTS = 5000
MAX_PERIOD_LEN = 100
MAX_NAME_LEN = 200
MAX_PLACE_LEN = 200
MAX_NOTE_LEN = 500


def fail(message):
    raise SystemExit("BUILD FAILED: " + message)


# ---------------------------------------------------------------------------
# 日历订阅（.ics）
#
# 页面里的「导出 .ics」由 JS 现场生成（离线可用）；这里生成的是**订阅文件**，
# 放在仓库根目录，同学用日历 App 的「订阅日历」填一次地址即可。
# 两边的事件规则必须完全一致，否则同一节课会出现两条：
#   UID = base36(hash(class|date|norm(period)|norm(name))) + "-" + YYYYMMDD + "@crsecue"
# 哈希算法刻意与 JS 的 `uid = uid * 31 + charCodeAt(i) >>> 0` 对齐（按 UTF-16 码元）。
# ---------------------------------------------------------------------------
PERIOD_TIME_SLOTS = [
    ((1, 2), (8, 0), (9, 40)),
    ((3, 4), (10, 0), (11, 40)),
    ((5, 6), (13, 30), (15, 10)),
    ((7, 8), (16, 0), (17, 40)),
    ((9, 10), (19, 0), (20, 40)),
]
# 默认节次时间（HH:MM）。下午第一节按班级实际情况前移 30 分钟。
DEFAULT_PERIOD_TIMES = {
    "1-2": ["08:00", "09:40"],
    "3-4": ["10:00", "11:40"],
    "5-6": ["13:30", "15:10"],
    "7-8": ["16:00", "17:40"],
    "9-10": ["19:00", "20:40"],
}
# 日历提醒提前量（分钟）：DESCRIPTION 与 VALARM TRIGGER 共用
REMINDER_MINUTES = 30
ICS_TZ_BLOCK = [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
]


def norm_key_text(value):
    """与前端 normKeyText 一致：NFKC、去空白、统一横线、小写。"""
    text = unicodedata.normalize("NFKC", "" if value is None else str(value))
    text = re.sub(r"[\s\u3000]+", "", text)
    text = re.sub(r"[\uFF0D\u2014\u2013\u2212\uFE63]", "-", text)
    return text.lower()


def base36(value):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = []
    while value:
        value, rem = divmod(value, 36)
        out.append(digits[rem])
    return "".join(reversed(out))


def event_uid(class_id, date_str, period, name):
    seed = "%s|%s|%s|%s" % (class_id, date_str, norm_key_text(period), norm_key_text(name))
    units = seed.encode("utf-16-le")
    uid = 0
    for i in range(0, len(units), 2):
        code_unit = units[i] | (units[i + 1] << 8)
        uid = (uid * 31 + code_unit) & 0xFFFFFFFF
    return "%s-%s@crsecue" % (base36(uid), date_str.replace("-", ""))


def ics_escape(value):
    text = "" if value is None else str(value)
    text = text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return re.sub(r"\r?\n", "\\n", text)


def ics_fold(line):
    """RFC 5545：内容行不超过 75 个八位组，超出用 CRLF + 空格折行。"""
    if len(line.encode("utf-8")) <= 75:
        return line
    out, current, used = [], [], 0
    for ch in line:
        size = len(ch.encode("utf-8"))
        if used + size > 73:
            out.append("".join(current))
            current, used = [], 0
        current.append(ch)
        used += size
    out.append("".join(current))
    return "\r\n ".join(out)


def parse_period_times(raw, label):
    """把 {"5-6": ["13:30","15:10"]} 解析并校验成同名结构；空值返回 {}。"""
    if raw in (None, "", {}):
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception as exc:
            fail("%s 的 periodTimes 不是有效 JSON：%s" % (label, exc))
    if not isinstance(raw, dict):
        fail("%s 的 periodTimes 必须是对象，形如 {\"5-6\": [\"13:30\",\"15:10\"]}" % label)
    parsed = {}
    for key, value in raw.items():
        name = str(key).strip()
        match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", name)
        if not match:
            fail("%s 的 periodTimes 键「%s」必须形如 5-6" % (label, name))
        first, last = int(match.group(1)), int(match.group(2))
        if first > last:
            first, last = last, first
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            fail("%s 的 periodTimes「%s」必须是 [开始, 结束]" % (label, name))
        times = []
        for moment in value:
            text = str(moment).strip()
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", text):
                fail("%s 的 periodTimes「%s」时间 %s 必须是 HH:MM" % (label, name, text))
            times.append(text)
        if times[0] >= times[1]:
            fail("%s 的 periodTimes「%s」开始时间必须早于结束时间" % (label, name))
        parsed["%d-%d" % (first, last)] = times
    return parsed


def merge_period_times(*layers):
    """后者覆盖前者：默认 < 设置.json < 班级文件。"""
    merged = {}
    for layer in layers:
        if layer:
            merged.update(layer)
    return {key: list(value) for key, value in sorted(merged.items(), key=lambda kv: int(kv[0].split("-")[0]))}


def period_time_table(times):
    """把 {key: [start, end]} 变成 "HH:MM" 的字符串表，注入页面后前端直接查表。"""
    return {key: [str(value[0]), str(value[1])] for key, value in times.items()}


def resolve_period_times(period, times=None):
    """按班级实际节次时间求 [开始, 结束]；没有对应时段返回 None。"""
    table = times or DEFAULT_PERIOD_TIMES
    ranges = parse_period_ranges(period)
    if not ranges:
        return None
    first = min(r[0] for r in ranges)
    last = max(r[1] for r in ranges)
    slots = []
    for key, value in table.items():
        start_text, end_text = value
        start_min = int(start_text[:2]) * 60 + int(start_text[3:])
        end_min = int(end_text[:2]) * 60 + int(end_text[3:])
        first_period, last_period = (int(part) for part in key.split("-"))
        slots.append((first_period, last_period, start_min, end_min, start_text, end_text))
    start = next((slot for slot in slots if slot[0] == first), None)
    end = next((slot for slot in slots if slot[1] == last), None)
    if not start or not end:
        return None
    return start[4], end[5]


def parse_period_ranges(value):
    """与前端 parsePeriodRanges 一致：把「第3-4节」「3、4节」解析成闭区间列表。"""
    text = norm_key_text(value).replace("节", "").replace("第", "")
    text = re.sub(r"[~\uFF5E\u81F3]", "-", text)
    if not text:
        return None
    parts = [part for part in re.split(r"[、,，;；/]", text) if part]
    if not parts:
        return None
    ranges = []
    for part in parts:
        match = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not match:
            return None
        start = int(match.group(1))
        end = start if match.group(2) is None else int(match.group(2))
        if start > end:
            start, end = end, start
        ranges.append((start, end))
    return ranges


def build_ics_text(class_id, experiments, stamp, times=None):
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CrseCue//实验课提醒//CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:" + ics_escape("实验课 " + class_id),
        "X-WR-TIMEZONE:Asia/Shanghai",
    ] + ICS_TZ_BLOCK

    for item in sorted(experiments, key=lambda e: e["date"]):
        ymd = item["date"].replace("-", "")
        slot = resolve_period_times(item["period"], times)
        lines.append("BEGIN:VEVENT")
        lines.append("UID:" + event_uid(class_id, item["date"], item["period"], item["name"]))
        lines.append("DTSTAMP:" + stamp)
        if slot:
            start, end = slot
            lines.append("DTSTART;TZID=Asia/Shanghai:%sT%s%s00" % (ymd, start[:2], start[3:]))
            lines.append("DTEND;TZID=Asia/Shanghai:%sT%s%s00" % (ymd, end[:2], end[3:]))
        else:
            day = date.fromisoformat(item["date"]) + timedelta(days=1)
            lines.append("DTSTART;VALUE=DATE:" + ymd)
            lines.append("DTEND;VALUE=DATE:" + day.strftime("%Y%m%d"))
        lines.append("SUMMARY:" + ics_escape(item["name"] or "实验课"))
        if item.get("place"):
            lines.append("LOCATION:" + ics_escape(item["place"]))
        desc = [d for d in (item["period"] and ("节次 " + item["period"]), item.get("note") and ("备注：" + item["note"])) if d]
        if desc:
            lines.append("DESCRIPTION:" + ics_escape("\n".join(desc)))
        lines += [
            "BEGIN:VALARM",
            "TRIGGER:-PT%dM" % REMINDER_MINUTES,
            "ACTION:DISPLAY",
            "DESCRIPTION:" + ics_escape("实验课提醒：" + (item["name"] or "实验课")),
            "END:VALARM",
            "END:VEVENT",
        ]

    lines.append("END:VCALENDAR")
    return "\r\n".join(ics_fold(line) for line in lines) + "\r\n"


def write_ics_files(classes, updated_at):
    """为每个班级写 <班级>.ics，并清理已经不存在班级的旧文件。"""
    stamp = (updated_at or "19700101").replace("-", "") + "T000000Z"
    written = []
    for item in classes:
        class_id = item["id"]
        text = build_ics_text(class_id, item["experiments"], stamp, item.get("periodTimes"))
        path = BASE / (class_id + ICS_SUFFIX)
        write_atomic(path, text.encode("utf-8"))
        written.append(path)
    keep = {path.name for path in written}
    for stale in BASE.glob("*" + ICS_SUFFIX):
        if stale.name not in keep:
            stale.unlink()
            print("removed stale %s" % stale.name)
    return written


def write_atomic(path: Path, data: bytes) -> None:
    """Write through a temp file + replace so an interrupted build leaves no half page."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def load_verifier():
    """Import verify-csp.py (hyphenated name) so the build can validate before writing."""
    spec = importlib.util.spec_from_file_location("verify_csp", BASE / "verify-csp.py")
    if spec is None or spec.loader is None:
        fail("无法加载 verify-csp.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def natural_key(name):
    key = []
    for part in re.split(r"(\d+)", name):
        if not part:
            continue
        key.append((0, int(part)) if part.isdigit() else (1, part.casefold()))
    return tuple(key)


def norm_header(value):
    return str(value).replace("\u3000", " ").strip()


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def cell_date(value, epoch):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        try:
            converted = from_excel(value, epoch)
            if isinstance(converted, datetime):
                return converted.date()
            if isinstance(converted, date):
                return converted
        except Exception:
            pass
    text = cell_text(value)
    match = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def parse_week(value):
    if isinstance(value, (int, float)) and float(value).is_integer():
        number = int(value)
        return number if 1 <= number <= 1000 else None
    text = cell_text(value).replace(" ", "")
    match = re.fullmatch(r"(?:第)?(\d+)周?", text)
    if not match:
        return None
    number = int(match.group(1))
    return number if 1 <= number <= 1000 else None


def parse_weekday(value):
    if isinstance(value, (int, float)) and float(value).is_integer():
        number = int(value)
        if number == 0:
            return 7
        return number if 1 <= number <= 7 else None
    text = cell_text(value).replace(" ", "")
    return WEEKDAY_MAP.get(text)


def clean_field(value, label, max_len, required=False, default=""):
    text = cell_text(value)
    if re.search(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F]", text):
        fail("%s 包含控制字符" % label)
    if required and not text:
        fail("%s 不能为空" % label)
    if len(text) > max_len:
        fail("%s 超过 %d 个字符" % (label, max_len))
    return text or default


def clean_note(value, label):
    text = cell_text(value).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F]", "", text)
    text = text.strip()
    if len(text) > MAX_NOTE_LEN:
        fail("%s 超过 %d 个字符" % (label, MAX_NOTE_LEN))
    return text


def read_settings():
    if not SETTINGS.exists():
        fail("找不到 %s" % SETTINGS)
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        fail("%s 不是有效 JSON：%s" % (SETTINGS.name, exc))
    if not isinstance(data, dict) or data.get("version") != 1:
        fail("%s 的 version 必须是 1" % SETTINGS.name)
    week1 = data.get("week1")
    if not isinstance(week1, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week1):
        fail("%s 的 week1 必须是 YYYY-MM-DD" % SETTINGS.name)
    try:
        parsed = date.fromisoformat(week1)
    except ValueError:
        fail("%s 的 week1 不是有效日期" % SETTINGS.name)
    if parsed.isoformat() != week1:
        fail("%s 的 week1 必须零填充且是有效日期" % SETTINGS.name)
    if parsed.weekday() != 0:
        fail("%s 的 week1 必须是星期一" % SETTINGS.name)

    # updatedAt 显式存进设置文件：否则本地构建（提交前）与 CI 构建（提交后）取到的
    # git 日期必然不同，verify.yml 的 `git diff --exit-code` 会稳定误报。
    updated_at = data.get("updatedAt")
    if updated_at is not None:
        if not isinstance(updated_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", updated_at):
            fail("%s 的 updatedAt 必须是 YYYY-MM-DD" % SETTINGS.name)
        try:
            stamped = date.fromisoformat(updated_at)
        except ValueError:
            fail("%s 的 updatedAt 不是有效日期" % SETTINGS.name)
        if stamped.isoformat() != updated_at:
            fail("%s 的 updatedAt 必须零填充且是有效日期" % SETTINGS.name)
    period_times = parse_period_times(data.get("periodTimes"), SETTINGS.name)
    return {"version": 1, "week1": week1, "updatedAt": updated_at, "periodTimes": period_times}


def stamp_settings(settings):
    """Pin updatedAt to today so local and CI builds agree byte for byte."""
    payload = {
        "version": 1,
        "week1": settings["week1"],
        "updatedAt": date.today().isoformat(),
    }
    # --stamp 不能顺手把节次时间抹掉
    if settings.get("periodTimes"):
        payload["periodTimes"] = settings["periodTimes"]
    write_atomic(SETTINGS, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print("stamped %s: updatedAt=%s" % (SETTINGS.name, payload["updatedAt"]))


def latest_data_commit_date():
    """Return the date of the latest commit touching data/, or empty string."""
    try:
        result = subprocess.run(
            ["git", "-C", str(BASE), "log", "-1", "--format=%cs", "--", "data"],
            capture_output=True, text=True, check=False
        )
    except OSError:
        return ""
    text = (result.stdout or "").strip()
    if result.returncode != 0 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return ""
    try:
        parsed = date.fromisoformat(text)
    except ValueError:
        return ""
    return parsed.isoformat() if parsed.isoformat() == text else ""


def read_class_meta(path, class_id):
    """Read optional 班级信息 sheet; return dict (empty when absent)."""
    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except Exception as exc:
        fail("%s 无法读取：%s" % (path.name, exc))
    try:
        if META_SHEET_NAME not in wb.sheetnames:
            return {}
        ws = wb[META_SHEET_NAME]
        meta = {}
        for row in ws.iter_rows(values_only=True):
            values = list(row)
            if not values:
                continue
            key = cell_text(values[0])
            if not key:
                continue
            value = cell_text(values[1]) if len(values) > 1 else ""
            meta[key] = value

        meta_class = meta.get("班级", "")
        if meta_class and meta_class != class_id:
            fail("%s 的班级信息为 %s，与文件名班级 %s 不一致，已阻止构建" % (path.name, meta_class, class_id))

        week1 = meta.get("week1", "")
        if week1:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week1):
                fail("%s 的班级信息 week1 必须是 YYYY-MM-DD" % path.name)
            try:
                parsed = date.fromisoformat(week1)
            except ValueError:
                fail("%s 的班级信息 week1 不是有效日期" % path.name)
            if parsed.isoformat() != week1:
                fail("%s 的班级信息 week1 必须零填充" % path.name)
            if parsed.weekday() != 0:
                fail("%s 的班级信息 week1 必须是星期一" % path.name)
        return meta
    finally:
        wb.close()


def read_class_file(path, class_id, week1_start):
    try:
        wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    except Exception as exc:
        fail("%s 无法读取：%s" % (path.name, exc))
    try:
        if not wb.worksheets:
            fail("%s 没有工作表" % path.name)
        ws = wb["实验安排"] if "实验安排" in wb.sheetnames else wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            fail("%s 是空工作表" % path.name)

        header_index = None
        header_map = {}
        for row_index, row in enumerate(rows[:20]):
            mapping = {}
            for col, value in enumerate(row):
                name = norm_header(value)
                if name and name not in mapping:
                    mapping[name] = col
            if all(name in mapping for name in REQUIRED):
                header_index = row_index
                header_map = mapping
                break
        if header_index is None:
            fail("%s 找不到表头（需要：%s）" % (path.name, "、".join(REQUIRED)))

        has_date = "日期" in header_map
        has_week = "周次" in header_map
        has_weekday = "星期" in header_map
        if not has_date and not (has_week and has_weekday):
            fail("%s 需要“日期”列，或同时有“周次”和“星期”列" % path.name)

        experiments = []
        for row_number, row in enumerate(rows[header_index + 1:], header_index + 2):
            values = list(row)
            if all(cell_text(v) == "" for v in values):
                continue

            def at(name):
                col = header_map.get(name)
                return values[col] if col is not None and col < len(values) else None

            d = None
            if has_date:
                d = cell_date(at("日期"), wb.epoch)

            # 周次+星期优先；不完整/无法识别时回退到日期。
            week = parse_week(at("周次")) if has_week else None
            weekday = parse_weekday(at("星期")) if has_weekday else None
            if week is not None and weekday is not None:
                d = week1_start + timedelta(days=(week - 1) * 7 + (weekday - 1))

            if d is None:
                fail("%s 第 %d 行：日期无法识别，且周次+星期不完整/无效" % (path.name, row_number))

            period = clean_field(at("节次"), "%s 第 %d 行节次" % (path.name, row_number), MAX_PERIOD_LEN, True)
            name = clean_field(at("实验名称"), "%s 第 %d 行实验名称" % (path.name, row_number), MAX_NAME_LEN, True)
            place = clean_field(at("实验地点"), "%s 第 %d 行实验地点" % (path.name, row_number), MAX_PLACE_LEN, False, "待定")
            note = clean_note(at("备注"), "%s 第 %d 行备注" % (path.name, row_number))

            experiments.append({
                "date": d.isoformat(),
                "period": period,
                "name": name,
                "place": place,
                "note": note,
            })
            if len(experiments) > MAX_EXPERIMENTS:
                fail("%s 的实验数量超过 %d" % (path.name, MAX_EXPERIMENTS))

        return experiments
    finally:
        wb.close()


def scan_class_files():
    if not DATA_DIR.exists():
        fail("找不到 data 目录")
    files = []
    seen = set()
    for path in DATA_DIR.iterdir():
        if not path.is_file():
            continue
        if path.name.startswith("~$") or path.name.startswith("."):
            continue
        if path.suffix.lower() != ".xlsx":
            continue
        class_id = path.stem
        if not class_id:
            fail("%s 没有班级名" % path.name)
        if class_id in seen:
            fail("班级名重复：%s" % class_id)
        seen.add(class_id)
        files.append((class_id, path))
    if not files:
        fail("data 目录下没有班级 xlsx")
    files.sort(key=lambda item: natural_key(item[0]))
    return files


def safe_json(data):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    text = text.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    text = text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return text


def resolve_updated_at(settings):
    if settings.get("updatedAt"):
        return settings["updatedAt"]
    fallback = latest_data_commit_date()
    if fallback:
        print(
            "WARN: %s 没有 updatedAt，回退到 git 提交日期 %s；"
            "建议固定它（python build-html.py --stamp）" % (SETTINGS.name, fallback),
            file=sys.stderr,
        )
    else:
        print(
            "WARN: 无法确定数据更新时间（git 不可用且 %s 没有 updatedAt）" % SETTINGS.name,
            file=sys.stderr,
        )
    return fallback


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    settings = read_settings()
    if "--stamp" in argv:
        stamp_settings(settings)
        settings = read_settings()

    classes = []
    for class_id, path in scan_class_files():
        meta = read_class_meta(path, class_id)
        class_week1 = meta.get("week1") or settings["week1"]
        experiments = read_class_file(path, class_id, date.fromisoformat(class_week1))
        # 节次时间：默认 < 设置.json < 班级文件（班级里留空就用设置）
        class_times = parse_period_times(meta.get("periodTimes"), "%s 的班级信息" % path.name)
        times = merge_period_times(DEFAULT_PERIOD_TIMES, settings.get("periodTimes"), class_times)
        classes.append({
            "id": class_id,
            "week1": class_week1,
            "experiments": experiments,
            "periodTimes": period_time_table(times),
        })

    updated_at = resolve_updated_at(settings)
    payload = {
        "version": 2,
        "week1": settings["week1"],
        "updatedAt": updated_at,
        "reminderMinutes": REMINDER_MINUTES,
        "classes": classes,
    }

    if not DEPLOY.exists():
        fail("找不到 %s" % DEPLOY.name)
    html = DEPLOY.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
    matches = list(TEMPLATE_RE.finditer(html))
    if len(matches) != 1:
        fail('源文件中必须恰好有一个 <template id="defaultData">...</template>')

    match = matches[0]
    html = html[: match.start(2)] + safe_json(payload) + html[match.end(2):]
    encoded = html.encode("utf-8")

    # 先校验内存里的产物，通过后才允许写盘：这样"哈希过期/模板坏掉/危险 sink"
    # 永远不会以半成品形式落到 index.html 上。
    verifier = load_verifier()
    errors = verifier.verify_html(html, DEPLOY.name)
    if errors:
        fail("产物未通过校验，未写入任何文件：\n  " + "\n  ".join(errors))

    write_atomic(DEPLOY, encoded)

    print("built %s: %d classes, %d experiments total" % (
        DEPLOY.name,
        len(classes),
        sum(len(c["experiments"]) for c in classes),
    ))
    for c in classes:
        print("  %s: %d 条" % (c["id"], len(c["experiments"])))

    errors = verifier.verify_bytes(encoded, DEPLOY.name)
    if errors:
        fail("写盘后自检失败：\n  " + "\n  ".join(errors))

    ics_files = write_ics_files(classes, updated_at)
    print("wrote %d ics files: %s" % (len(ics_files), ", ".join(p.name for p in ics_files)))
    print("OK: 产物已写入并通过 CSP/模板校验")
    return 0


if __name__ == "__main__":
    sys.exit(main())
