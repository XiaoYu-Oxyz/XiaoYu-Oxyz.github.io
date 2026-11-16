
/* 说明：本页所有功能（包括 xlsx 导入/导出）均在本文件内实现，不加载任何网络资源，可完全离线运行。 */

/* 老设备兼容（如 2017 年的 vivo Y66i，WebView/Chrome 可能停在 60 左右）：
   replaceChildren 是 Chrome 86 才有的 API，缺了会让整页在渲染时抛错。 */
if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function replaceChildren() {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (let i = 0; i < arguments.length; i += 1) {
      const node = arguments[i];
      if (node == null) continue;
      this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
    }
  };
}
// 不在 iframe/预览中强制跳转顶层页面：GitHub Pages 没有 frame-ancestors，
// 但 JS frame-buster 在预览/嵌入环境可能把顶层导航到 404，且本身可被绕过。
// 点击劫持作为残余风险记录在 SECURITY.md，不再做客户端强制跳转。

/* 未捕获异常：白屏对使用者毫无信息量。
   记下现场 → 跳到 404 页面（那里能一键复制错误信息，也有返回入口）。 */
var fatalRedirected = false;
function redirectOnFatal(reason) {
  if (fatalRedirected) return;
  fatalRedirected = true;
  try {
    var detail = String(reason && reason.stack ? reason.stack : reason).slice(0, 1500);
    var report = [
      '【CrseCue · 页面异常】',
      '时间：' + new Date().toLocaleString('zh-CN'),
      '地址：' + location.href,
      '视口：' + window.innerWidth + '×' + window.innerHeight,
      'UA：' + navigator.userAgent,
      '详情：' + detail
    ].join('\n');
    sessionStorage.setItem('crsecue:lasterror', report);
  } catch (e) {}
  try { location.replace('404.html?from=error'); } catch (e2) {}
}
window.addEventListener('error', function (ev) { redirectOnFatal(ev.error || ev.message); });
window.addEventListener('unhandledrejection', function (ev) { redirectOnFatal(ev.reason); });
/* ============================================================
   1. 配置与常量
   ============================================================ */
const WEEK_NAMES = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
const BASE_REQUIRED = ['节次', '实验名称', '实验地点'];

const STORAGE_PREFIX = 'ghpages:zhizao2402:';
// 本地存储是否可用（无痕模式、禁用 Cookie、配额满都会让写入抛错）
const STORAGE_OK = (() => {
  try {
    const probe = STORAGE_PREFIX + '__selftest';
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return ok;
  } catch (e) {
    return false;
  }
})();
const WEEK1_START_KEY = STORAGE_PREFIX + 'week1:v1';
const LEGACY_WEEK1_KEY = 'zhizao2402_week1_start_v1';
const OLD_SINGLE_STORAGE_KEY = STORAGE_PREFIX + 'experiments:v1';
const LEGACY_STORAGE_KEY = 'zhizao2402_experiments_v1';
const CLASS_DATA_PREFIX = STORAGE_PREFIX + 'classdata:v1:';
const CLASS_VERSION_PREFIX = STORAGE_PREFIX + 'classversion:v1:';
const CLASS_WEEK1_PREFIX = STORAGE_PREFIX + 'classweek1:v1:';
const CLASS_SELECTED_KEY = STORAGE_PREFIX + 'selected-class:v1';
const CLASS_EXTRA_KEY = STORAGE_PREFIX + 'extra-classes:v1';
const CLASS_HIDDEN_KEY = STORAGE_PREFIX + 'hidden-built-classes:v1';
const CLASS_QUERY_PARAM = 'class';
// ?mode=ro：只读分享链接。班级里大多数同学只需要看，不需要（也不应该）改本机数据。
const MODE_QUERY_PARAM = 'mode';
const READ_ONLY = (() => {
  try {
    return new URLSearchParams(location.search).get(MODE_QUERY_PARAM) === 'ro';
  } catch (e) {
    return false;
  }
})();

// 首次访问：没有 ?class= 参数、也没存过班级选择——默认班可能不是"他的班"。
const FIRST_VISIT = (() => {
  try {
    if (new URLSearchParams(location.search).get(CLASS_QUERY_PARAM)) return false;
    return !localStorage.getItem(CLASS_SELECTED_KEY);
  } catch (e) {
    return false;
  }
})();
if (READ_ONLY) document.body.classList.add('readonly');
const MIGRATION_CLASS = 'Z2';
const DATE_CACHE_LIMIT = 4096;
// 日期字符串在 render/search/import 中反复解析；缓存 timestamp，返回克隆避免调用方改缓存。
const dateParseCache = new Map();

const DEFAULT_DATA = (() => {
  const el = document.getElementById('defaultData');
  if (!el || !el.content) return null;
  try {
    return JSON.parse(el.content.textContent);
  } catch (e) {
    return null;
  }
})();

const WEEK1_DEFAULT = (() => {
  const s = DEFAULT_DATA && typeof DEFAULT_DATA.week1 === 'string' ? DEFAULT_DATA.week1 : '';
  if (isValidDateStr(s)) return parseDate(s);
  return new Date(2026, 7, 31);
})();

const DATA_UPDATED_AT = (() => {
  const s = DEFAULT_DATA && typeof DEFAULT_DATA.updatedAt === 'string' ? DEFAULT_DATA.updatedAt : '';
  return isValidDateStr(s) ? s : '';
})();

const MAX_EXPERIMENTS = 5000;
const MAX_PERIOD_LEN  = 100;
const MAX_NAME_LEN    = 200;
const MAX_PLACE_LEN   = 200;
const MAX_NOTE_LEN    = 500;

// 模板里的班级数据。class id 来自 data/*.xlsx 的文件名。
const DEFAULT_CLASSES = (() => {
  const map = new Map();
  const week1Map = new Map();
  const order = [];
  const src = DEFAULT_DATA && Array.isArray(DEFAULT_DATA.classes) ? DEFAULT_DATA.classes : [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id || map.has(id)) continue;
    const clean = sanitizeStoredExperiments(Array.isArray(item.experiments) ? item.experiments : []);
    map.set(id, clean === null ? [] : clean);
    week1Map.set(id, isValidDateStr(item.week1) ? item.week1 : toDateStr(WEEK1_DEFAULT));
    order.push(id);
  }
  // 兼容旧模板（version 1 的 experiments 数组）以及尚未 build 的源文件
  if (!order.length && DEFAULT_DATA && Array.isArray(DEFAULT_DATA.experiments)) {
    map.set('Z1', []);
    map.set('Z2', sanitizeStoredExperiments(DEFAULT_DATA.experiments) || []);
    week1Map.set('Z1', toDateStr(WEEK1_DEFAULT));
    week1Map.set('Z2', toDateStr(WEEK1_DEFAULT));
    order.push('Z1', 'Z2');
  }
  if (!order.length) {
    map.set('Z1', []);
    map.set('Z2', []);
    week1Map.set('Z1', toDateStr(WEEK1_DEFAULT));
    week1Map.set('Z2', toDateStr(WEEK1_DEFAULT));
    order.push('Z1', 'Z2');
  }
  return { map, week1: week1Map, order };
})();

// 只接受 {"5-6": ["13:30","15:10"]} 这种形状，其余丢弃（也接受 JSON 字符串）
function sanitizePeriodTimes(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(String(key).trim());
    if (!match) continue;
    const value = raw[key];
    if (!Array.isArray(value) || value.length !== 2) continue;
    const start = String(value[0]).trim();
    const end = String(value[1]).trim();
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(start) || !hhmm.test(end) || start >= end) continue;
    out[`${Number(match[1])}-${Number(match[2])}`] = [start, end];
  }
  return Object.keys(out).length ? out : null;
}

// 构建期注入的班级节次时间（默认 < 设置.json < 班级已合并好）
const DEFAULT_CLASS_TIMES = (() => {
  const map = new Map();
  const src = DEFAULT_DATA && Array.isArray(DEFAULT_DATA.classes) ? DEFAULT_DATA.classes : [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) continue;
    const clean = sanitizePeriodTimes(item.periodTimes);
    if (clean) map.set(id, clean);
  }
  return map;
})();

function getDefaultClassExperiments(id) {
  const list = DEFAULT_CLASSES.map.get(id);
  return list ? list.map(e => ({ ...e })) : null;
}

function getDefaultClassWeek1(id) {
  const s = DEFAULT_CLASSES.week1.get(id);
  return isValidDateStr(s) ? s : toDateStr(WEEK1_DEFAULT);
}

function isBuiltClass(id) {
  return DEFAULT_CLASSES.map.has(id);
}

function isLocalClass(id) {
  return extraClasses.includes(id);
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }) ||
    (a < b ? -1 : a > b ? 1 : 0);
}

function loadExtraClasses() {
  try {
    const arr = JSON.parse(localStorage.getItem(CLASS_EXTRA_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const id of arr) {
      if (typeof id !== 'string' || !id) continue;
      if (DEFAULT_CLASSES.map.has(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 200) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

function saveExtraClasses() {
  try { localStorage.setItem(CLASS_EXTRA_KEY, JSON.stringify(extraClasses)); } catch (e) {}
}

let extraClasses = loadExtraClasses();

function loadHiddenBuiltClasses() {
  try {
    const arr = JSON.parse(localStorage.getItem(CLASS_HIDDEN_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const id of arr) {
      if (typeof id !== 'string' || !DEFAULT_CLASSES.map.has(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 200) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

function saveHiddenBuiltClasses() {
  try { localStorage.setItem(CLASS_HIDDEN_KEY, JSON.stringify(hiddenBuiltClasses)); } catch (e) {}
}

let hiddenBuiltClasses = loadHiddenBuiltClasses();

function getAllClassIds() {
  const ids = DEFAULT_CLASSES.order.filter(id => !hiddenBuiltClasses.includes(id));
  extraClasses.forEach(id => {
    if (!ids.includes(id)) ids.push(id);
  });
  return ids.sort(naturalCompare);
}

let classIds = getAllClassIds();

// 链接里的班级不存在（改名/删除/手打错）：直接跳 404，
// 否则页面会静默换成第一个班，让人对着别人班的课表而不自知。
const REQUESTED_CLASS = (() => {
  try {
    return new URLSearchParams(location.search).get(CLASS_QUERY_PARAM) || '';
  } catch (e) {
    return '';
  }
})();

const REQUESTED_CLASS_MISSING = !!REQUESTED_CLASS && !classIds.includes(REQUESTED_CLASS);

function readSelectedClass() {
  try {
    const requested = new URLSearchParams(location.search).get(CLASS_QUERY_PARAM);
    if (requested && classIds.includes(requested)) return requested;
  } catch (e) {}
  try {
    const saved = localStorage.getItem(CLASS_SELECTED_KEY);
    if (saved && classIds.includes(saved)) return saved;
  } catch (e) {}
  return classIds[0] || '';
}

let selectedClass = readSelectedClass();

function syncUrlClass() {
  try {
    const url = new URL(location.href);
    const current = url.searchParams.get(CLASS_QUERY_PARAM);
    if (selectedClass) {
      if (current === selectedClass) return;
      url.searchParams.set(CLASS_QUERY_PARAM, selectedClass);
    } else {
      if (!current) return;
      url.searchParams.delete(CLASS_QUERY_PARAM);
    }
    history.replaceState(null, '', url.href);
  } catch (e) {}
}

const EXPORT_SHEET_NAME = '实验安排';
const EXPORT_HEADERS    = ['日期', '周次', '星期', '节次', '实验名称', '实验地点', '备注'];
const EXPORT_COL_WIDTHS = [13, 8, 8, 10, 26, 14, 32];


/* ============================================================
   2. 工具函数
   ============================================================ */
function pad2(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDate(s) {
  if (typeof s !== 'string') return new Date(NaN);
  const cached = dateParseCache.get(s);
  if (cached !== undefined) return new Date(cached);

  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (!isNaN(dt.getTime()) && dateParseCache.size < DATE_CACHE_LIMIT) {
    dateParseCache.set(s, dt.getTime());
  }
  return dt;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeekMonday(d) {
  const x = startOfDay(d);
  const offset = (x.getDay() + 6) % 7; // 星期一 = 0
  x.setDate(x.getDate() - offset);
  return x;
}

function dayDiff(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
}

function weekNoOf(date) {
  const diff = dayDiff(date, week1Start);
  if (diff < 0) return null;
  return Math.floor(diff / 7) + 1;
}

function experimentA11ySummary(e, statusText) {
  const d = e && e._date instanceof Date && !isNaN(e._date.getTime()) ? e._date : parseDate(e.date);
  const wk = d && !isNaN(d.getTime()) ? weekNoOf(d) : null;
  const weekday = d && !isNaN(d.getTime()) ? WEEK_NAMES[d.getDay()] : '未知';
  const note = String(e.note || '').replace(/\s+/g, ' ').trim();
  const parts = [
    `日期 ${e.date}`,
    wk === null ? '周次 学期开始前' : `周次 第${wk}周`,
    `星期 ${weekday}`,
    `节次 ${e.period}`,
    `实验名称 ${e.name}`,
    `实验地点 ${e.place || '待定'}`,
    `备注 ${note || '无'}`
  ];
  if (statusText) parts.push(`状态 ${statusText}`);
  return parts.join('；');
}

function dateFromWeekWeekday(weekNo, weekday) {
  return dateFromWeekWeekdayBase(weekNo, weekday, week1Start);
}

function dateFromWeekWeekdayBase(weekNo, weekday, base) {
  const offset = (weekNo - 1) * 7 + (weekday - 1);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
}

function cleanText(v, maxLen) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, maxLen);
}

function cleanNote(v) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, MAX_NOTE_LEN);
}

function normalizeHeader(v) {
  return String(v == null ? '' : v).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

// 判重用的规整：全角转半角、去掉所有空白、统一各种横线、忽略大小写
// 例：「第３－４节」与「第3-4节」视为同一个节次
function normKeyText(v) {
  return String(v == null ? '' : v)
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[－—–−﹣]/g, '-')
    .toLowerCase();
}

// 判断两条实验是否为「同一条」：日期 + 节次 + 实验名称 都相同
function expIdentity(e) {
  return [e.date, normKeyText(e.period), normKeyText(e.name)].join('\u0001');
}

function parseWeekNo(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 ? v : null;
  const s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  const m = s.match(/^(?:第)?(\d+)周?$/);
  if (!m) return null;
  const n = +m[1];
  return n >= 1 ? n : null;
}

function parseWeekday(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return null;
    if (v === 0) return 7;
    if (v >= 1 && v <= 7) return v;
    return null;
  }
  const s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  const map = {
    '星期一': 1, '周一': 1, '礼拜一': 1, '一': 1, '1': 1,
    '星期二': 2, '周二': 2, '礼拜二': 2, '二': 2, '2': 2,
    '星期三': 3, '周三': 3, '礼拜三': 3, '三': 3, '3': 3,
    '星期四': 4, '周四': 4, '礼拜四': 4, '四': 4, '4': 4,
    '星期五': 5, '周五': 5, '礼拜五': 5, '五': 5, '5': 5,
    '星期六': 6, '周六': 6, '礼拜六': 6, '六': 6, '6': 6,
    '星期日': 7, '星期天': 7, '周日': 7, '周天': 7,
    '礼拜日': 7, '礼拜天': 7, '日': 7, '天': 7, '7': 7, '0': 7
  };
  return map[s] || null;
}


/* ============================================================
   2.1 时间冲突判定
   ------------------------------------------------------------
   规则：同一班级内，日期相同且节次范围有交集即算冲突；
   实验名称、地点不参与判断。节次无法解析时按规整后的文本比较。
   「第3-8节」与「第5-6节」算重叠。
   ============================================================ */

// 把「第3-4节」「3、4节」「第9-10节」解析成若干闭区间；无法解析返回 null。
function parsePeriodRanges(value) {
  const text = normKeyText(value)
    .replace(/节/g, '')
    .replace(/第/g, '')
    .replace(/[~～至]/g, '-');
  if (!text) return null;
  const parts = text.split(/[、,，;；/]/).filter(Boolean);
  if (!parts.length) return null;

  const ranges = [];
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    let start = Number(m[1]);
    let end = m[2] === undefined ? start : Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start > end) { const tmp = start; start = end; end = tmp; }
    ranges.push([start, end]);
  }
  return ranges;
}

function periodRangesOverlap(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (Math.max(x[0], y[0]) <= Math.min(x[1], y[1])) return true;
    }
  }
  return false;
}

// 返回 { groups, byIndex, totalRows }：
// groups 按日期/节次排序，id 从 1 开始；byIndex 是「原 experiments 下标 -> 组」的映射。
function computeConflictInfo(list) {
  const rows = [];
  (list || []).forEach((e, idx) => {
    if (!e || !isValidDateStr(e.date)) return;
    const ranges = parsePeriodRanges(e.period);
    const key = ranges ? null : normKeyText(e.period);
    if (!ranges && !key) return;
    rows.push({
      idx,
      date: e.date,
      ranges,
      key,
      period: String(e.period == null ? '' : e.period)
    });
  });

  const parent = new Map();
  rows.forEach(r => parent.set(r.idx, r.idx));

  function find(x) {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== x) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 固定让较小下标当根，结果稳定
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  const byDate = new Map();
  rows.forEach(r => {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  });

  byDate.forEach(bucket => {
    const segments = [];
    const unparsed = new Map();

    bucket.forEach(r => {
      if (!r.ranges) {
        if (!unparsed.has(r.key)) unparsed.set(r.key, []);
        unparsed.get(r.key).push(r.idx);
        return;
      }
      r.ranges.forEach(range => {
        segments.push({ idx: r.idx, start: range[0], end: range[1] });
      });
    });

    // 无法解析的节次：只有规整后文本完全相同才算重叠。
    unparsed.forEach(indices => {
      for (let i = 1; i < indices.length; i++) union(indices[0], indices[i]);
    });

    // 区间扫描；同一行的多个区间通过共享 idx 自然连成一组。
    segments.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.idx - b.idx));
    const active = [];
    for (const seg of segments) {
      const next = [];
      for (const prev of active) {
        if (prev.end >= seg.start) {
          next.push(prev);
          union(prev.idx, seg.idx);
        }
      }
      next.push(seg);
      active.length = 0;
      active.push(...next);
    }
  });

  const components = new Map();
  rows.forEach(r => {
    const root = find(r.idx);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(r);
  });

  const groups = [];
  components.forEach(items => {
    if (items.length < 2) return;
    const date = items[0].date;
    const periods = [];
    let start = null;
    items.forEach(it => {
      if (!periods.includes(it.period)) periods.push(it.period);
      if (it.ranges) {
        it.ranges.forEach(range => {
          if (start === null || range[0] < start) start = range[0];
        });
      }
    });
    groups.push({
      date,
      periods,
      start: start === null ? 0 : start,
      indices: items.map(it => it.idx).sort((a, b) => a - b)
    });
  });

  groups.sort((a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
    (a.start - b.start) ||
    (a.indices[0] - b.indices[0])
  );

  const byIndex = new Map();
  let totalRows = 0;
  groups.forEach((g, i) => {
    g.id = i + 1;
    g.size = g.indices.length;
    g.dateLabel = g.date.slice(5);
    g.periodLabel = g.periods.length <= 2 ? g.periods.join(' / ') : g.periods[0] + ' 等';
    totalRows += g.size;
    g.indices.forEach(idx => byIndex.set(idx, g));
  });

  return { groups, byIndex, totalRows };
}


/* ============================================================
   3. 第 1 周星期一
   ============================================================ */
function readStoredDate(key) {
  try {
    const s = localStorage.getItem(key);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = parseDate(s);
    if (isNaN(d.getTime()) || toDateStr(d) !== s) return null;
    return d;
  } catch (e) { return null; }
}

function loadWeek1Start() {
  return readClassWeek1(selectedClass);
}

function classWeek1Key(id) {
  return CLASS_WEEK1_PREFIX + encodeURIComponent(id);
}

function readClassWeek1(id) {
  const saved = readStoredDate(classWeek1Key(id));
  if (saved) return saved;
  return parseDate(getDefaultClassWeek1(id));
}

// 旧版只有一个全局 week1；首次升级时复制到所有班，保留用户原设置。
function migrateLegacyWeek1() {
  const legacy = readStoredDate(WEEK1_START_KEY) || readStoredDate(LEGACY_WEEK1_KEY);
  if (!legacy) return;
  classIds.forEach(id => {
    if (!readStoredDate(classWeek1Key(id))) {
      try { localStorage.setItem(classWeek1Key(id), toDateStr(legacy)); } catch (e) {}
    }
  });
  try { localStorage.removeItem(WEEK1_START_KEY); } catch (e) {}
  try { localStorage.removeItem(LEGACY_WEEK1_KEY); } catch (e) {}
}

migrateLegacyWeek1();

let week1Start = loadWeek1Start();

function saveClassWeek1Value(id, value) {
  try {
    localStorage.setItem(classWeek1Key(id), value);
    return true;
  } catch (e) {
    return false;
  }
}

function saveWeek1Start() {
  if (!selectedClass) return false;
  return saveClassWeek1Value(selectedClass, toDateStr(week1Start));
}


/* ============================================================
   4. 班级数据存储
   ============================================================ */
let experiments = [];
let usingSaved = false;
let savedDataVersion = '';
let lastImportUndo = null;
let lastClassUndo = null;

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDate(s);
  return !isNaN(d.getTime()) && toDateStr(d) === s;
}

function sanitizeStoredExperiments(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  const limit = Math.min(arr.length, MAX_EXPERIMENTS);
  for (let i = 0; i < limit; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') continue;
    if (!isValidDateStr(e.date)) continue;
    out.push({
      date: e.date,
      period: cleanText(e.period, MAX_PERIOD_LEN),
      name: cleanText(e.name, MAX_NAME_LEN),
      place: cleanText(e.place, MAX_PLACE_LEN) || '待定',
      note: cleanNote(e.note)
    });
  }
  if (arr.length && !out.length) return null;
  return out;
}

function readStoredExperiments(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return sanitizeStoredExperiments(JSON.parse(raw));
  } catch (e) { return null; }
}

function classDataKey(id) {
  return CLASS_DATA_PREFIX + encodeURIComponent(id);
}

function classVersionKey(id) {
  return CLASS_VERSION_PREFIX + encodeURIComponent(id);
}

function readClassStored(id) {
  try {
    const raw = localStorage.getItem(classDataKey(id));
    if (raw == null) return null;
    return sanitizeStoredExperiments(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

function saveClassStored(id, list) {
  try {
    localStorage.setItem(classDataKey(id), JSON.stringify(list));
    // 记下这份本机数据是基于哪个部署版本存的：页面数据更新后就能提示"你这份是旧的"
    if (DATA_UPDATED_AT) {
      try { localStorage.setItem(classVersionKey(id), DATA_UPDATED_AT); } catch (e) {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

function readClassVersion(id) {
  try {
    return localStorage.getItem(classVersionKey(id)) || '';
  } catch (e) {
    return '';
  }
}

function removeClassStored(id) {
  try { localStorage.removeItem(classDataKey(id)); } catch (e) {}
}

function loadClassState(id) {
  const own = readClassStored(id);
  if (own !== null) {
    return { list: own.map(e => ({ ...e })), saved: true };
  }

  // 本机同名的隐藏内置班副本默认是空的，不应加载内置默认实验。
  if (isLocalClass(id)) {
    return { list: [], saved: false };
  }

  // 旧单班数据（上一版 experiments:v1 与更早的旧键）迁移到 Z2
  if (id === MIGRATION_CLASS) {
    const oldNew = readStoredExperiments(OLD_SINGLE_STORAGE_KEY);
    const oldLegacy = oldNew === null ? readStoredExperiments(LEGACY_STORAGE_KEY) : null;
    const old = oldNew !== null ? oldNew : oldLegacy;
    if (old !== null) {
      const copied = old.map(e => ({ ...e }));
      const ok = saveClassStored(id, copied);
      if (ok) {
        try { localStorage.removeItem(OLD_SINGLE_STORAGE_KEY); } catch (e) {}
        try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) {}
      }
      return { list: copied, saved: true };
    }
  }

  const def = getDefaultClassExperiments(id);
  return { list: def || [], saved: false };
}

function setCurrentClassData(id) {
  if (!id) {
    experiments = [];
    usingSaved = false;
    savedDataVersion = '';
    return;
  }
  const state = loadClassState(id);
  experiments = state.list;
  usingSaved = state.saved;
  savedDataVersion = state.saved ? readClassVersion(id) : '';
}

function saveExperiments() {
  lastImportUndo = null;
  lastClassUndo = null;
  if (!selectedClass) return false;
  const ok = saveClassStored(selectedClass, experiments);
  if (ok) usingSaved = true;
  return ok;
}

setCurrentClassData(selectedClass);

function saveSelectedClass() {
  try {
    if (selectedClass) localStorage.setItem(CLASS_SELECTED_KEY, selectedClass);
    else localStorage.removeItem(CLASS_SELECTED_KEY);
  } catch (e) {}
}

function addExtraClass(id) {
  if (!id || classIds.includes(id)) return;
  if (isBuiltClass(id) && !hiddenBuiltClasses.includes(id)) return;
  extraClasses.push(id);
  saveExtraClasses();
  classIds = getAllClassIds();
}

function removeExtraClass(id) {
  const next = extraClasses.filter(x => x !== id);
  if (next.length === extraClasses.length) return;
  extraClasses = next;
  saveExtraClasses();
  classIds = getAllClassIds();
}

function syncClassTools() {
  const anyMode = deleteMode || editMode;
  const noClass = !selectedClass;
  newClassBtn.disabled = anyMode;
  renameClassBtn.disabled = anyMode || noClass;
  deleteClassBtn.disabled = anyMode || noClass;
  const built = !noClass && isBuiltClass(selectedClass) && !isLocalClass(selectedClass);
  const hasHidden = hiddenBuiltClasses.length > 0;
  restoreToolBtn.disabled = anyMode || (!built && !hasHidden);
  restoreToolBtn.title = built
    ? '恢复默认实验或已隐藏的内置班级'
    : (hasHidden ? '恢复已隐藏的内置班级' : '没有可恢复内容');
  renameClassBtn.title = noClass
    ? '先新建或恢复一个班级'
    : (built ? '重命名当前内置班级（会先警告）' : '重命名当前班级');
  deleteClassBtn.title = noClass
    ? '先新建或恢复一个班级'
    : (built ? '删除当前内置班级（会先警告）' : '删除当前本机班级');
}

function validateClassName(raw, excludeId) {
  const name = String(raw || '').trim();
  if (!name) return { error: '班级名称不能为空' };
  if (name.length > 80) return { error: '班级名称最多 80 个字符' };
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    return { error: '班级名称不能包含 < > : " / \\ | ? * 等文件名字符' };
  }
  if (/^\.|\.$/.test(name)) return { error: '班级名称不能以点开头或结尾' };
  const lower = name.toLocaleLowerCase('zh-CN');
  if (classIds.some(id => id !== excludeId && id.toLocaleLowerCase('zh-CN') === lower)) {
    return { error: `班级 ${name} 已存在` };
  }
  return { name };
}

function clearClassPromptError() {
  classPromptError.textContent = '';
  classPromptError.className = 'form-error';
  classPromptInput.setAttribute('aria-invalid', 'false');
}

function showClassPromptError(message) {
  classPromptError.textContent = message;
  classPromptError.className = 'form-error show';
  classPromptInput.setAttribute('aria-invalid', 'true');
  classPromptInput.focus();
}

const CLASS_UNDO_STORAGE = {
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
};

function captureClassUndo(oldId, newId) {
  return {
    oldId,
    newId,
    oldDataRaw: CLASS_UNDO_STORAGE.get(classDataKey(oldId)),
    oldWeek1Raw: CLASS_UNDO_STORAGE.get(classWeek1Key(oldId)),
    extraClasses: extraClasses.slice(),
    hiddenBuiltClasses: hiddenBuiltClasses.slice(),
    previousSelected: selectedClass
  };
}

function setClassUndo(snapshot, message, type) {
  lastClassUndo = snapshot;
  showStatus(type || 'ok', message, { label: '撤销', onClick: undoClassOperation });
}

function undoClassOperation() {
  const snapshot = lastClassUndo;
  if (!snapshot) return;
  if (deleteMode || editMode) {
    showStatus('warn', '请先完成编辑/删除模式，再撤销班级操作');
    return;
  }
  lastClassUndo = null;
  const { oldId, newId, oldDataRaw, oldWeek1Raw } = snapshot;

  if (newId && newId !== oldId) {
    removeClassStored(newId);
    try { localStorage.removeItem(classWeek1Key(newId)); } catch (e) {}
  }

  extraClasses = snapshot.extraClasses.slice();
  hiddenBuiltClasses = snapshot.hiddenBuiltClasses.slice();
  saveExtraClasses();
  saveHiddenBuiltClasses();
  classIds = getAllClassIds();

  try {
    if (oldDataRaw == null) removeClassStored(oldId);
    else localStorage.setItem(classDataKey(oldId), oldDataRaw);
  } catch (e) {}
  try {
    if (oldWeek1Raw == null) localStorage.removeItem(classWeek1Key(oldId));
    else localStorage.setItem(classWeek1Key(oldId), oldWeek1Raw);
  } catch (e) {}

  lastImportUndo = null;
  lastDeletedByClass.delete(oldId);
  lastEditedByClass.delete(oldId);
  selectedClass = oldId;
  saveSelectedClass();
  setCurrentClassData(oldId);
  week1Start = readClassWeek1(oldId);
  if (week1Input) week1Input.value = toDateStr(week1Start);
  clearSearchState(false);
  syncClassSelect();
  syncHeaderActions();
  syncUrlClass();
  render();
  updateClock();
  showStatus('ok', `已撤销班级操作，恢复到 ${oldId}`);
}

function restoreHiddenClass(id) {
  if (!hiddenBuiltClasses.includes(id)) return false;
  if (classIds.includes(id)) {
    restoreError.textContent = `本机已有同名班级 ${id}，请先删除该班，再恢复隐藏的内置班`;
    restoreError.className = 'form-error show';
    return false;
  }
  restoreError.textContent = '';
  restoreError.className = 'form-error';
  hiddenBuiltClasses = hiddenBuiltClasses.filter(x => x !== id);
  saveHiddenBuiltClasses();
  classIds = getAllClassIds();
  selectedClass = id;
  saveSelectedClass();
  setCurrentClassData(id);
  week1Start = readClassWeek1(id);
  if (week1Input) week1Input.value = toDateStr(week1Start);
  clearSearchState(false);
  syncClassSelect();
  syncHeaderActions();
  syncUrlClass();
  render();
  updateClock();
  showStatus('ok', `已恢复内置班级 ${id}`);
  return true;
}

function renderRestoreHiddenList() {
  restoreHiddenList.replaceChildren();
  if (!hiddenBuiltClasses.length) {
    const empty = document.createElement('span');
    empty.textContent = '暂无隐藏的内置班级';
    restoreHiddenList.appendChild(empty);
    return;
  }
  const label = document.createElement('span');
  label.textContent = '已隐藏：';
  restoreHiddenList.appendChild(label);
  hiddenBuiltClasses.forEach(id => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hidden-class-restore';
    btn.textContent = `恢复 ${id}`;
    btn.addEventListener('click', () => {
      if (restoreHiddenClass(id)) closeRestoreDialog();
    });
    restoreHiddenList.appendChild(btn);
  });
}

function closeRestoreDialog() {
  restoreMask.classList.remove('show');
  restoreModalFocus(restoreMask);
}

function openRestoreDialog() {
  const built = !!selectedClass && isBuiltClass(selectedClass) && !isLocalClass(selectedClass);
  restoreError.textContent = '';
  restoreError.className = 'form-error';
  restoreDefaultHint.textContent = built
    ? `把 ${selectedClass} 恢复为 data/ 构建时的默认实验；其它班和 week1 不受影响。`
    : (selectedClass ? '当前是本机班级，没有 data/ 默认实验可恢复。' : '当前没有班级。');
  restoreDefaultBtn.disabled = !built;
  renderRestoreHiddenList();
  restoreModalFocus(restoreMask, restoreToolBtn);
  restoreMask.classList.add('show');
  setTimeout(() => {
    try {
      if (built) restoreDefaultBtn.focus();
      else if (restoreHiddenList.querySelector('button')) restoreHiddenList.querySelector('button').focus();
      else restoreDone.focus();
    } catch (e) {}
  }, 0);
}

async function restoreCurrentClassDefaults() {
  if (!selectedClass || !isBuiltClass(selectedClass) || isLocalClass(selectedClass)) return;
  const ok = await askConfirm({
    title: `恢复 ${selectedClass} 的默认数据`,
    message: `确定把 ${selectedClass} 恢复为 data/ 构建时的默认数据吗？当前班已添加、导入、删除的结果都会被清除；其它班和第 1 周设置不受影响。`,
    okText: '恢复当前班'
  });
  if (!ok) return;

  const defaults = getDefaultClassExperiments(selectedClass) || [];
  experiments = defaults.map(e => ({ ...e }));
  usingSaved = false;
  lastDeletedByClass.delete(selectedClass);
  lastEditedByClass.delete(selectedClass);
  lastImportUndo = null;
  lastClassUndo = null;
  removeClassStored(selectedClass);
  if (selectedClass === MIGRATION_CLASS) {
    try { localStorage.removeItem(OLD_SINGLE_STORAGE_KEY); } catch (e) {}
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) {}
  }
  closeRestoreDialog();
  render();
  updateClock();
  syncClassSelect();
  syncHeaderActions();
  showStatus('ok', `已把 ${selectedClass} 恢复为默认数据，并清除了该班本机保存的数据`);
}

let classPromptMode = 'new';

function openClassPrompt(mode) {
  classPromptMode = mode;
  const isRename = mode === 'rename';
  const built = isRename && isBuiltClass(selectedClass) && !isLocalClass(selectedClass);
  classPromptTitle.textContent = isRename ? '重命名班级' : '新建班级';
  classPromptOk.textContent = isRename ? '保存名称' : '创建';
  classPromptHint.textContent = isRename
    ? (built
      ? '这是内置班级。重命名会在本机隐藏原班并创建副本；部署数据不变，可撤销。'
      : '只修改本机班级名；导出文件名也会使用新名称。')
    : '新建本机空班级；导出该班 xlsx 并 build 后才会成为部署默认。';
  classPromptInput.value = isRename ? selectedClass : '';
  clearClassPromptError();
  rememberModalFocus(classMask, isRename ? renameClassBtn : newClassBtn);
  classMask.classList.add('show');
  setTimeout(() => {
    try { classPromptInput.focus(); classPromptInput.select(); } catch (e) {}
  }, 0);
}

function closeClassPrompt() {
  classMask.classList.remove('show');
  restoreModalFocus(classMask);
}

async function submitClassPrompt() {
  const isRename = classPromptMode === 'rename';
  const result = validateClassName(classPromptInput.value, isRename ? selectedClass : null);
  if (result.error) {
    showClassPromptError(result.error);
    return;
  }
  const name = result.name;
  const hiddenName = hiddenBuiltClasses.some(id => id.toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'));

  if (hiddenName) {
    const ok = await askConfirm({
      title: '名称与隐藏班相同',
      message: `${name} 是本机已隐藏的内置班。`,
      detail: '允许同名，但之后恢复隐藏的内置班前，必须先删除这个同名班级。继续？',
      okText: '仍然使用'
    });
    if (!ok) return;
  }

  if (!isRename) {
    addExtraClass(name);
    if (!classIds.includes(name)) {
      showClassPromptError('无法创建该班级');
      return;
    }
    closeClassPrompt();
    switchClass(name);
    showStatus(
      hiddenName ? 'warn' : 'ok',
      hiddenName
        ? `已新建同名本机班级 ${name}；恢复隐藏的内置班前请先删除该班`
        : `已新建本机班级 ${name}；导出该班 xlsx 放入 data/ 并 build 后才会成为部署默认`
    );
    return;
  }

  const oldId = selectedClass;
  if (!oldId) {
    showClassPromptError('当前没有班级');
    return;
  }
  const oldWasBuilt = isBuiltClass(oldId) && !isLocalClass(oldId);
  const snapshot = captureClassUndo(oldId, name);
  const list = loadClassState(oldId).list.map(e => ({ ...e }));
  let oldWeek1Raw = null;
  try { oldWeek1Raw = localStorage.getItem(classWeek1Key(oldId)); } catch (e) {}
  if (!saveClassStored(name, list)) {
    showClassPromptError('本地保存失败，无法重命名');
    return;
  }
  try {
    if (oldWeek1Raw == null) localStorage.removeItem(classWeek1Key(name));
    else localStorage.setItem(classWeek1Key(name), oldWeek1Raw);
  } catch (e) {}
  try { localStorage.removeItem(classWeek1Key(oldId)); } catch (e) {}
  removeClassStored(oldId);

  if (oldWasBuilt) {
    if (!hiddenBuiltClasses.includes(oldId)) hiddenBuiltClasses.push(oldId);
    saveHiddenBuiltClasses();
    if (!extraClasses.includes(name)) extraClasses.push(name);
  } else {
    extraClasses = extraClasses.map(id => id === oldId ? name : id);
  }
  saveExtraClasses();
  classIds = getAllClassIds();
  selectedClass = name;
  saveSelectedClass();
  lastDeletedByClass.delete(oldId);
  lastEditedByClass.delete(oldId);
  lastImportUndo = null;
  setCurrentClassData(name);
  week1Start = readClassWeek1(name);
  if (week1Input) week1Input.value = toDateStr(week1Start);
  syncClassSelect();
  syncHeaderActions();
  syncUrlClass();
  render();
  updateClock();
  closeClassPrompt();
  setClassUndo(
    snapshot,
    `已将${oldWasBuilt ? '内置' : '本机'}班级 ${oldId} 重命名为 ${name}${oldWasBuilt ? '（原班已在本机隐藏）' : ''}${hiddenName ? '；恢复隐藏班前请先删除该班' : ''}`,
    hiddenName ? 'warn' : 'ok'
  );
}

function deleteCurrentClass() {
  const id = selectedClass;
  if (!id) return;
  const local = isLocalClass(id);
  const wasBuilt = isBuiltClass(id) && !local;
  askConfirm({
    title: wasBuilt ? '隐藏内置班级' : '删除本机班级',
    message: wasBuilt ? `确定在本机隐藏内置班级 ${id}？` : `确定删除本机班级 ${id}？`,
    detail: wasBuilt
      ? '原班来自 data/ 文件，部署数据不会改变；本机隐藏后可通过恢复图标找回。操作可撤销。'
      : (local && isBuiltClass(id)
        ? '这是与隐藏内置班同名的本机班级；删除后隐藏的内置班仍在，可再恢复。操作可撤销。'
        : '该班的本地实验、week1 和撤销记录都会删除；建议先导出备份。操作可撤销。'),
    okText: wasBuilt ? '隐藏班级' : '删除班级'
  }).then(ok => {
    if (!ok) return;
    const snapshot = captureClassUndo(id, null);
    if (wasBuilt) {
      if (!hiddenBuiltClasses.includes(id)) hiddenBuiltClasses.push(id);
      saveHiddenBuiltClasses();
    } else {
      removeExtraClass(id);
    }
    removeClassStored(id);
    try { localStorage.removeItem(classWeek1Key(id)); } catch (e) {}
    lastDeletedByClass.delete(id);
    lastEditedByClass.delete(id);
    lastImportUndo = null;
    classIds = getAllClassIds();

    const next = classIds[0] || '';
    selectedClass = next;
    saveSelectedClass();
    if (next) {
      setCurrentClassData(next);
      week1Start = readClassWeek1(next);
      if (week1Input) week1Input.value = toDateStr(week1Start);
    } else {
      experiments = [];
      usingSaved = false;
      week1Start = new Date(WEEK1_DEFAULT.getFullYear(), WEEK1_DEFAULT.getMonth(), WEEK1_DEFAULT.getDate());
      if (week1Input) week1Input.value = toDateStr(week1Start);
    }
    clearSearchState(false);
    syncClassSelect();
    syncHeaderActions();
    syncUrlClass();
    render();
    updateClock();
    setClassUndo(snapshot, wasBuilt ? `已在本机隐藏内置班级 ${id}` : `已删除本机班级 ${id}`);
  });
}

function switchClass(id) {
  if (deleteMode || editMode) {
    syncClassSelect();
    return false;
  }
  if (!id || !classIds.includes(id) || id === selectedClass) {
    syncClassSelect();
    return false;
  }
  selectedClass = id;
  saveSelectedClass();
  setCurrentClassData(id);
  week1Start = readClassWeek1(id);
  if (week1Input) week1Input.value = toDateStr(week1Start);
  clearSearchState(false);
  syncUrlClass();
  markedIndices.clear();
  render();
  updateClock();
  syncClassSelect();
  syncHeaderActions();
  showUndoForCurrentClass();
  return true;
}

function syncClassSelect() {
  classSelect.replaceChildren();
  if (!classIds.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（无班级）';
    option.selected = true;
    classSelect.appendChild(option);
    classSelect.disabled = true;
    classSelect.value = '';
    syncClassTools();
    return;
  }
  classIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    if (id === selectedClass) option.selected = true;
    classSelect.appendChild(option);
  });
  classSelect.disabled = deleteMode || editMode;
  classSelect.value = selectedClass;
  syncClassTools();
}


/* ============================================================
   5. 渲染表格
   ============================================================ */
let deleteMode = false;        // 是否处于删除模式
let editMode = false;          // 是否处于编辑模式
let recentOnly = true;         // 是否仅显示本周及以后（每次打开默认勾选）
let conflictOnly = false;      // 是否只看时间冲突（每次打开默认关闭）
let searchQuery = '';          // 操作菜单里的搜索词
let searchTerms = [];          // 搜索词按空白拆分后的数组
let filterBeforeMode = true;   // 进入编辑/删除模式前的筛选状态
let conflictBeforeMode = false;
let filterStateSaved = false;  // 是否已保存模式前的筛选状态
let conflictFilterStateSaved = false;
const markedIndices = new Set(); // 删除模式下，已标记待删除的实验下标

function updateRecentCount(visible, total) {
  if (recentCountEl) recentCountEl.textContent = `显示 ${visible} / 共 ${total}`;
}

/* ============================================================
   周视图（桌面 demo，≥1120px 才显示切换按钮）
   只读呈现"这一周哪天哪几节有课"，与列表共用同一套筛选（本周/只看冲突/搜索）。
   ============================================================ */
const WEEK_MIN_ROWS = 10;      // 至少 1…10 十个节次行
const WEEK_MAX_ROWS = 14;      // 上限：一条写错的节次不该把表格撑到几十行
const WEEK_VIEW_MIN_WIDTH = 1120;
const weekViewEl = document.getElementById('weekView');
const viewListBtn = document.getElementById('viewListBtn');
const viewWeekBtn = document.getElementById('viewWeekBtn');
const VIEW_STATE_KEY = STORAGE_PREFIX + 'view:v1';
let weekViewStart = startOfWeekMonday(startOfDay(new Date()));

// 一个节次一行：第3-8节占 6 行，第2-3节占 2 行，11 节起自动加行。
function periodRange(entry) {
  const ranges = parsePeriodRanges(entry.period);
  if (!ranges) return null;
  const first = Math.min.apply(null, ranges.map(range => range[0]));
  const last = Math.max.apply(null, ranges.map(range => range[1]));
  if (!Number.isFinite(first) || !Number.isFinite(last) || first < 1 || last < first) return null;
  return { start: first, end: last };
}

// 一列一天：同一天里时间段重叠的记录合并成"堆"，在同一个格子里上下分布。
function layoutWeek(entries) {
  const items = [];
  let maxPeriod = WEEK_MIN_ROWS;
  entries.forEach(entry => {
    const range = periodRange(entry);
    if (!range) return;
    items.push({
      entry,
      day: (entry._date.getDay() + 6) % 7,
      start: range.start,
      end: range.end
    });
    if (range.end > maxPeriod) maxPeriod = range.end;
  });
  const rowCount = Math.min(WEEK_MAX_ROWS, Math.max(WEEK_MIN_ROWS, maxPeriod));

  const stacks = [];
  for (let day = 0; day < 7; day += 1) {
    const dayItems = items
      .filter(item => item.day === day)
      .map(item => ({
        entry: item.entry,
        day,
        start: Math.min(item.start, rowCount),
        end: Math.min(item.end, rowCount),
        clipped: item.end > rowCount
      }))
      .sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let current = null;
    dayItems.forEach(item => {
      if (current && item.start <= current.end) {
        current.items.push(item);
        current.end = Math.max(current.end, item.end);
      } else {
        current = { day, start: item.start, end: item.end, items: [item] };
        stacks.push(current);
      }
    });
  }

  return { stacks, rowCount, skipped: entries.length - items.length };
}

function renderWeekView() {
  if (!weekViewEl || !document.body.classList.contains('view-week')) return;

  const start = weekViewStart;
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const conflictSet = computeConflictInfo(experiments).byIndex;
  // 课表已经限定在同一周，"已结束仅显示本周" 在这里没有意义（否则翻到过去几周永远是空的）；
  // "只看冲突" 与搜索仍然生效。
  const entries = getExperimentEntries()
    .filter(entry => entry._date >= start && entry._date < end)
    .filter(entry => !conflictOnly || conflictSet.has(entry._idx))
    .filter(matchesSearch);
  const today = startOfDay(new Date());
  const layout = layoutWeek(entries);

  const fragment = document.createDocumentFragment();

  const toolbar = document.createElement('div');
  toolbar.className = 'week-toolbar';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'ghost-btn';
  prevBtn.id = 'weekPrevBtn';
  prevBtn.textContent = '‹ 上一周';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'ghost-btn';
  nextBtn.id = 'weekNextBtn';
  nextBtn.textContent = '下一周 ›';
  const label = document.createElement('span');
  label.className = 'week-label';
  const weekNo = weekNoOf(start);
  label.textContent = `${toDateStr(start)} ~ ${toDateStr(days[6])}`
    + (weekNo === null ? '' : ` · 第 ${weekNo} 周`)
    + ` · ${entries.length} 条`;
  toolbar.append(prevBtn, label, nextBtn);
  // 翻远了以后一键回到当前周
  const thisWeekStart = startOfWeekMonday(today);
  if (start.getTime() !== thisWeekStart.getTime()) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ghost-btn';
    backBtn.id = 'weekTodayBtn';
    backBtn.textContent = '回到本周';
    backBtn.addEventListener('click', () => {
      weekViewStart = startOfWeekMonday(startOfDay(new Date()));
      renderWeekView();
    });
    toolbar.appendChild(backBtn);
  }
  fragment.appendChild(toolbar);

  const grid = document.createElement('div');
  grid.className = 'week-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', `本周课表：${toDateStr(start)} 至 ${toDateStr(days[6])}，共 ${entries.length} 条`);
  // 固定 8 列：1 列节次数字 + 7 天，一列一天
  grid.style.gridTemplateColumns = '44px repeat(7, minmax(0, 1fr))';

  const todayStart = startOfDay(new Date());
  const nextDate = (() => {
    let best = null;
    experiments.forEach(entry => {
      const date = parseDate(entry.date);
      if (isNaN(date.getTime()) || date < todayStart) return;
      if (!best || date < best) best = date;
    });
    return best;
  })();

  function stateClasses(entry) {
    const date = startOfDay(entry._date);
    const diff = dayDiff(date, todayStart);
    const classes = ['wg-item'];
    if (diff === 0) classes.push('st-today');
    else if (diff === 1) classes.push('st-tomorrow');
    else if (diff < 0) classes.push('st-past');
    else classes.push('st-future');
    if (nextDate && date.getTime() === nextDate.getTime()) classes.push('st-next');
    if (conflictSet.has(entry._idx)) classes.push('is-conflict');
    return classes.join(' ');
  }

  // 左上角只占位、不写字（保持日期列对齐）
  const corner = document.createElement('div');
  corner.className = 'wg-cell wg-head wg-corner';
  corner.setAttribute('aria-hidden', 'true');
  corner.style.gridRow = '1';
  corner.style.gridColumn = '1';
  grid.appendChild(corner);

  days.forEach((day, index) => {
    const cell = document.createElement('div');
    cell.className = 'wg-cell wg-head' + (dayDiff(day, today) === 0 ? ' is-today' : '');
    cell.textContent = `${WEEK_NAMES[day.getDay()].replace('星期', '周')} ${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
    cell.style.gridRow = '1';
    cell.style.gridColumn = String(index + 2);
    grid.appendChild(cell);
  });

  // 一个节次一行，行号就是节次本身（1、2、3 …），11 节起自动加行
  for (let period = 1; period <= layout.rowCount; period += 1) {
    const rowLabel = document.createElement('div');
    rowLabel.className = 'wg-cell wg-slot';
    rowLabel.textContent = String(period);
    rowLabel.style.gridRow = String(period + 1);
    rowLabel.style.gridColumn = '1';
    grid.appendChild(rowLabel);
    for (let day = 0; day < 7; day += 1) {
      const cell = document.createElement('div');
      cell.className = 'wg-cell wg-cell-add';
      cell.setAttribute('aria-hidden', 'true');
      cell.style.gridRow = String(period + 1);
      cell.style.gridColumn = String(day + 2);
      // 点空格直接添加：预填这天的日期与这个节次
      const dateStr = toDateStr(days[day]);
      cell.dataset.date = dateStr;
      cell.dataset.period = String(period);
      cell.title = READ_ONLY ? '' : `点击添加：${dateStr} 第 ${period} 节`;
      if (!READ_ONLY) {
        cell.addEventListener('click', () => {
          // 编辑/删除模式下点空格没有意义，别弹出添加窗口打断当前操作
          if (editMode || deleteMode) return;
          openModal({ date: dateStr, period: `第${period}节` });
        });
      }
      grid.appendChild(cell);
    }
  }

  // 同一天里时间段重叠的记录：横向分栏（按名称长度加权），纵向仍按各自节次
  layout.stacks.forEach(stack => {
    const span = `${stack.start + 1} / ${stack.end + 2}`;
    const column = String(stack.day + 2);
    const count = stack.items.length;
    const wrapper = count > 1 ? document.createElement('div') : null;
    if (wrapper) {
      wrapper.className = 'wg-stack';
      wrapper.style.gridRow = span;
      wrapper.style.gridColumn = column;
      grid.appendChild(wrapper);
    }
    const rows = stack.end - stack.start + 1;
    // 冲突时平分宽度（回到最简单可预期的规则；长名字靠折行解决）
    const share = 100 / count;
    let offset = 0;
    stack.items.forEach((item, index) => {
      const entry = item.entry;
      const block = document.createElement('div');
      block.className = stateClasses(entry);
      if (wrapper) {
        block.classList.add('wg-in-stack');
        block.style.left = `${offset}%`;
        block.style.width = `${share}%`;
        block.style.top = `${((item.start - stack.start) / rows) * 100}%`;
        block.style.height = `${((item.end - item.start + 1) / rows) * 100}%`;
        offset += share;
      } else {
        block.style.gridRow = span;
        block.style.gridColumn = column;
      }
      const clippedSuffix = item.clipped ? '（节次超出 ' + WEEK_MAX_ROWS + ' 节，显示已截断）' : '';
      block.title = [entry.name, entry.period, entry.place, entry.note].filter(Boolean).join(' · ') + clippedSuffix;
      block.dataset.idx = String(entry._idx);
      const name = document.createElement('b');
      name.textContent = entry.name;
      block.appendChild(name);
      if (entry.place) {
        const place = document.createElement('span');
        place.textContent = entry.place;
        block.appendChild(place);
      }
      // 节次超出上限被截断时明确标出来，不静默缩短
      if (item.clipped) {
        const clipped = document.createElement('span');
        clipped.className = 'wg-clipped';
        clipped.textContent = '…';
        clipped.setAttribute('aria-label', '节次超出显示范围，已截断');
        block.appendChild(clipped);
      }
      // 课表里直接操作：默认点击=编辑；删除模式下点击=标记待删除
      if (!READ_ONLY) {
        const summary = `${entry.date} ${entry.period} ${entry.name}`
          + (entry.place ? `，地点 ${entry.place}` : '');
        const marked = markedIndices.has(entry._idx);
        block.tabIndex = 0;
        block.setAttribute('role', 'button');
        block.classList.add('wg-clickable');
        if (deleteMode) {
          block.classList.toggle('is-marked', marked);
          block.setAttribute('aria-pressed', String(marked));
          block.setAttribute('aria-label', `${marked ? '取消删除标记' : '标记删除'}：${summary}`);
        } else {
          block.setAttribute('aria-label', `编辑：${summary}`);
          if (editMode) block.classList.add('wg-editing');
        }
        const activate = () => {
          if (deleteMode) { toggleWeekMark(entry._idx); return; }
          openEditModal(entry._idx, block);
        };
        block.addEventListener('click', activate);
        block.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        });
      }
      (wrapper || grid).appendChild(block);
    });
  });

  if (!entries.length) {
    const hint = document.createElement('p');
    hint.className = 'wg-empty';
    hint.textContent = '这一周没有实验。';
    fragment.appendChild(hint);
  } else {
    // 空周不画一整张空网格，只留提示
    fragment.appendChild(grid);
  }

  // 「其他」行已删除。当前数据里节次都是「第N-M节」，走不到这里；
  // 保留这行是为了将来导入非数字节次（如「上午」）时不至于静默消失。
  if (layout.skipped > 0) {
    const note = document.createElement('p');
    note.className = 'wg-empty';
    note.textContent = `另有 ${layout.skipped} 条节次无法排进课表，请切回列表视图查看。`;
    fragment.appendChild(note);
  }
  weekViewEl.replaceChildren(fragment);

  prevBtn.addEventListener('click', () => {
    weekViewStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    renderWeekView();
  });
  nextBtn.addEventListener('click', () => {
    weekViewStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    renderWeekView();
  });
}

function setView(view, persist) {
  const canWeek = window.matchMedia(`(min-width: ${WEEK_VIEW_MIN_WIDTH}px)`).matches;
  const isWeek = view === 'week' && canWeek;
  document.body.classList.toggle('view-week', isWeek);
  if (viewListBtn) viewListBtn.setAttribute('aria-pressed', String(!isWeek));
  if (viewWeekBtn) viewWeekBtn.setAttribute('aria-pressed', String(isWeek));
  syncWeekFilterState();
  if (persist) {
    try { sessionStorage.setItem(VIEW_STATE_KEY, isWeek ? 'week' : 'list'); } catch (e) {}
  }
  if (isWeek) renderWeekView();
}

// 课表按周浏览，忽略「已结束仅显示本周」：把复选框置灰并说明，避免"勾着却没生效"的错觉。
// 进入/退出编辑、删除模式会重置复选框状态，所以 render() 里也要再同步一次。
function syncWeekFilterState() {
  if (!recentFilter) return;
  const isWeek = document.body.classList.contains('view-week');
  recentFilter.disabled = isWeek;
  recentFilter.setAttribute('aria-disabled', String(isWeek));
  const label = recentFilter.closest('label');
  if (label) {
    label.classList.toggle('is-disabled', isWeek);
    label.title = isWeek
      ? '课表按周浏览，本选项在课表里不生效'
      : '隐藏本周一之前已结束的实验；今天及未来始终显示';
  }
}

function render() {
  syncModeBadge();
  syncCueBar();
  syncWeekFilterState();
  if (document.body.classList.contains('view-week')) renderWeekView();
  const today = startOfDay(new Date());
  const tbody = tbodyEl;
  const frag = document.createDocumentFragment();

  const conflictInfo = computeConflictInfo(experiments);
  document.body.classList.toggle('no-conflict', conflictInfo.groups.length === 0);
  if (!conflictInfo.groups.length && conflictOnly) {
    conflictOnly = false;
    conflictFilter.checked = false;
  }

  const allRows = experiments
    .map((e, i) => ({ ...e, _date: parseDate(e.date), _idx: i }))
    .sort((a, b) => (a._date - b._date) || (a._idx - b._idx));
  const weekStart = startOfWeekMonday(today);
  const rows = allRows
    .filter(e => !recentOnly || e._date >= weekStart)
    .filter(e => !conflictOnly || conflictInfo.byIndex.has(e._idx))
    .filter(matchesSearch);

  if (tableCaptionEl) {
    tableCaptionEl.textContent = selectedClass
      ? `班级 ${selectedClass} 实验安排，共 ${allRows.length} 条，当前显示 ${rows.length} 条`
      : '未选择班级';
  }
  if (printHead) {
    // 打印稿要能看出这是筛选后的结果，否则纸面上和"全部实验"没法区分
    const filterBits = [];
    if (conflictOnly) filterBits.push('只看冲突');
    const query = searchInput ? searchInput.value.trim() : '';
    if (query) filterBits.push(`搜索「${query}」`);
    if (recentOnly) filterBits.push('已结束仅显示本周');
    const filterText = filterBits.length ? ` · 筛选：${filterBits.join(' + ')}` : '';
    printHead.textContent = selectedClass
      ? `${selectedClass} 实验安排 · ${toDateStr(today)} · ${rows.length} 条${filterText}`
      : '未选择班级';
  }
  if (printMeta) {
    const stamp = new Date();
    const pad2 = v => String(v).padStart(2, '0');
    printMeta.textContent = `数据更新至 ${DATA_UPDATED_AT || '—'} · 打印于 ${stamp.getFullYear()}-${pad2(stamp.getMonth() + 1)}-${pad2(stamp.getDate())} ${pad2(stamp.getHours())}:${pad2(stamp.getMinutes())}`;
  }

  updateRecentCount(rows.length, allRows.length);

  const firstUpcoming = allRows.find(e => e._date >= today) || null;
  const nextDate = firstUpcoming ? firstUpcoming._date : null;
  const nextDays = nextDate ? dayDiff(nextDate, today) : null;
  const nextLabel = nextDate
    ? (nextDays === 0 ? '今天' : `${nextDays}天后`)
    : '';
  const nextTitle = nextDate
    ? `下一次实验：${toDateStr(nextDate)}，${nextDays === 0 ? '就是今天' : `还有 ${nextDays} 天`}`
    : '';
  // 「下一次」只服务于"还没到跟前"的那天：最近一次就是今天/明天时，
  // 行上已经有「今天 / 明天」标签，蓝框和"N天后"徽标都属于重复表达，一并让位。
  const nextIsImminent = nextDays === 0 || nextDays === 1;
  const nextHighlightable = !!nextDate && !nextIsImminent;
  if (nextLegend) nextLegend.hidden = !nextHighlightable;

  if (!selectedClass) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 8;
    td.appendChild(document.createTextNode('暂无班级 —— 点击班级右侧“＋”新建'));
    td.appendChild(document.createElement('br'));
    td.appendChild(document.createTextNode('如果之前隐藏过内置班级，可在新建弹窗中恢复'));
    tr.appendChild(td);
    frag.appendChild(tr);
    tbody.replaceChildren(frag);
    syncConflictFilter(conflictInfo);
    return;
  }

  if (!experiments.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 8;
    td.appendChild(document.createTextNode('暂无实验安排 —— 点击右上角「添加实验」，或「导入」批量导入'));
    td.appendChild(document.createElement('br'));
    td.appendChild(document.createTextNode('如需恢复初始数据，可点击「恢复默认数据」'));
    tr.appendChild(td);
    frag.appendChild(tr);
    tbody.replaceChildren(frag);
    syncConflictFilter(conflictInfo);
    return;
  }

  if (!rows.length) {
    const hidden = allRows.length;
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 8;
    const noConflict = conflictOnly;
    const noSearch = !!searchQuery;
    if (noSearch) {
      td.appendChild(document.createTextNode(
        `没有匹配“${searchQuery}”的实验；已隐藏 ${hidden} 条。`
      ));
      td.appendChild(document.createElement('br'));
      td.appendChild(document.createTextNode('在“操作”里清空搜索，或取消其他筛选后再看。'));
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'empty-clear';
      clearBtn.textContent = '清除搜索';
      clearBtn.addEventListener('click', () => {
        if (!searchInput) return;
        searchInput.value = '';
        // 复用搜索框自己的 input 处理（它负责更新 searchQuery 并重绘）
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.focus();
      });
      td.appendChild(document.createTextNode(' '));
      td.appendChild(clearBtn);
    } else {
      td.appendChild(document.createTextNode(
        noConflict
          ? `当前筛选下没有时间冲突；已隐藏 ${hidden} 条实验。`
          : `本周一及以后没有实验；已隐藏 ${hidden} 条更早记录。`
      ));
      td.appendChild(document.createElement('br'));
      td.appendChild(document.createTextNode(
        noConflict
          ? '取消「只看冲突」可查看全部实验；取消「已结束仅显示本周」可查看更早记录'
          : '取消勾选「已结束仅显示本周」可查看全部'
      ));
    }
    tr.appendChild(td);
    frag.appendChild(tr);
    tbody.replaceChildren(frag);
    syncConflictFilter(conflictInfo);
    return;
  }

  let lastWeekKey = null;
  rows.forEach((e, rowPos) => {
    const diff = dayDiff(e._date, today);
    const tr = document.createElement('tr');
    tr.dataset.idx = String(e._idx);

    // 同一周的实验连成一组，换周时打一条横线分隔（手机卡片同样生效）
    const weekKey = weekNoOf(e._date);
    if (lastWeekKey !== null && weekKey !== lastWeekKey) tr.classList.add('week-start');
    lastWeekKey = weekKey;

    let tagText = '', tagClass = '';
    if (diff === 0) {
      tr.classList.add('row-today');
      tagText = '今天';
      tagClass = 'tag tag-today';
    } else if (diff === 1) {
      tr.classList.add('row-tomorrow');
      tagText = '明天';
      tagClass = 'tag tag-tomorrow';
    } else if (diff < 0) {
      tr.classList.add('row-past');
      tagText = '已结束';
      tagClass = 'tag tag-past';
    }

    // 今天/明天那行不再叠加"下一次"（蓝框 + N天后徽标），状态只由今天/明天表达
    const isNext = nextHighlightable && e._date.getTime() === nextDate.getTime();
    if (isNext) {
      tr.classList.add('row-next');
      tr.dataset.next = '1';
    }

    const marked = deleteMode && markedIndices.has(e._idx);
    if (marked) tr.classList.add('row-marked');

    const conflict = conflictInfo.byIndex.get(e._idx);
    if (conflict) {
      tr.classList.add('row-conflict');
      tr.dataset.conflict = String(conflict.id);
      const prevGroup = rowPos > 0 ? conflictInfo.byIndex.get(rows[rowPos - 1]._idx) : null;
      const nextGroup = rowPos + 1 < rows.length ? conflictInfo.byIndex.get(rows[rowPos + 1]._idx) : null;
      if (prevGroup && prevGroup.id === conflict.id) tr.classList.add('conflict-join-top');
      if (nextGroup && nextGroup.id === conflict.id) tr.classList.add('conflict-join-next');
    }

    const markTd = document.createElement('td');
    markTd.className = 'cell-mark';
    markTd.headers = 'col-mark';
    markTd.setAttribute('aria-label', '操作');
    // 今天/明天的标签已经说了状态时，不再重复一遍"下一次实验 今天"
    const showNextBadge = isNext && nextLabel !== tagText;
    const a11yStatus = [
      tagText,
      showNextBadge ? `下一次实验 ${nextLabel}` : '',
      conflict ? '时间冲突' : ''
    ].filter(Boolean).join('；');
    const a11ySummary = experimentA11ySummary(e, a11yStatus);
    tr.tabIndex = -1;
    tr.dataset.a11yLabel = a11ySummary;
    tr.setAttribute('aria-label', a11ySummary);
    const markBtn = document.createElement('button');
    markBtn.type = 'button';
    markBtn.dataset.idx = String(e._idx);

    if (editMode) {
      markBtn.className = 'edit-row-btn';
      markBtn.dataset.action = 'edit';
      const pencil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pencil.setAttribute('viewBox', '0 0 24 24');
      pencil.setAttribute('aria-hidden', 'true');
      pencil.setAttribute('focusable', 'false');
      const pencilPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pencilPath.setAttribute('d', 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z');
      pencil.appendChild(pencilPath);
      markBtn.appendChild(pencil);
      markBtn.title = '编辑这条实验';
      markBtn.setAttribute('aria-label', `编辑实验：${a11ySummary}`);
    } else {
      markBtn.className = 'mark-btn' + (marked ? ' is-marked' : '');
      markBtn.dataset.action = 'mark';
      markBtn.setAttribute('aria-pressed', marked ? 'true' : 'false');
      const markTitle = marked ? '取消删除标记' : '标记为待删除';
      markBtn.title = markTitle;
      markBtn.setAttribute('aria-label', `${markTitle}：${a11ySummary}`);
    }

    markTd.appendChild(markBtn);
    tr.appendChild(markTd);

    const dateTd = document.createElement('td');
    dateTd.headers = 'col-date';
    appendHighlighted(dateTd, e.date);
    if (tagClass) {
      const tag = document.createElement('span');
      tag.className = tagClass;
      tag.textContent = tagText;
      dateTd.appendChild(tag);
    }
    if (showNextBadge) {
      const nextBadge = document.createElement('span');
      nextBadge.className = 'next-badge';
      nextBadge.textContent = nextLabel;
      nextBadge.title = nextTitle;
      nextBadge.setAttribute('aria-label', nextTitle);
      dateTd.appendChild(nextBadge);
    }
    if (conflict) {
      const conflictSr = document.createElement('span');
      conflictSr.className = 'sr-only';
      conflictSr.textContent = '时间冲突';
      dateTd.appendChild(conflictSr);
    }
    tr.appendChild(dateTd);

    const wk = weekNoOf(e._date);
    const weekTd = document.createElement('td');
    weekTd.headers = 'col-week';
    // wk 为 null 表示早于「第 1 周周一」（补课、周历设错）：显示「学期前」比「—」好懂
    appendHighlighted(weekTd, wk === null ? '学期前' : '第' + wk + '周');
    tr.appendChild(weekTd);

    const wdTd = document.createElement('td');
    wdTd.headers = 'col-weekday';
    appendHighlighted(wdTd, WEEK_NAMES[e._date.getDay()]);
    tr.appendChild(wdTd);

    const periodTd = document.createElement('td');
    periodTd.headers = 'col-period';
    appendHighlighted(periodTd, e.period);
    tr.appendChild(periodTd);

    const nameTd = document.createElement('td');
    nameTd.headers = 'col-name';
    appendHighlighted(nameTd, e.name);
    if (e.note) {
      const printNote = document.createElement('span');
      printNote.className = 'print-note';
      printNote.textContent = '备注：' + e.note;
      nameTd.appendChild(printNote);
    }
    tr.appendChild(nameTd);

    const placeTd = document.createElement('td');
    placeTd.headers = 'col-place';
    appendHighlighted(placeTd, e.place);
    tr.appendChild(placeTd);

    const mobileTd = document.createElement('td');
    mobileTd.className = 'cell-mobile';
    mobileTd.headers = 'col-date col-week col-weekday col-period col-name col-place';
    const mLine1 = document.createElement('div');
    mLine1.className = 'm-line1';
    const shortDate = e.date.slice(5);
    const shortWeek = wk === null ? '学期前' : `${wk}周`;
    const shortWeekday = WEEK_NAMES[e._date.getDay()].replace('星期', '周');
    const shortPeriod = e.period.replace(/^第/, '');
    appendHighlighted(mLine1, `${shortDate} · ${shortWeek} · ${shortWeekday} · ${shortPeriod}`);
    if (tagClass) {
      const mobileTag = document.createElement('span');
      mobileTag.className = tagClass;
      mobileTag.textContent = tagText;
      mLine1.appendChild(mobileTag);
    }
    if (showNextBadge) {
      const mobileNext = document.createElement('span');
      mobileNext.className = 'next-badge';
      mobileNext.textContent = nextLabel;
      mobileNext.title = nextTitle;
      mobileNext.setAttribute('aria-label', nextTitle);
      mLine1.appendChild(mobileNext);
    }
    const mLine2 = document.createElement('div');
    mLine2.className = 'm-line2';
    const mName = document.createElement('span');
    mName.className = 'm-name';
    appendHighlighted(mName, e.name);
    const mPlace = document.createElement('span');
    mPlace.className = 'm-place';
    // 手机端不再放定位图标：窄屏上图标+文字反而更挤，读屏也照读整段摘要
    appendHighlighted(mPlace, e.place);
    mLine2.appendChild(mName);
    mLine2.appendChild(mPlace);
    mobileTd.appendChild(mLine1);
    mobileTd.appendChild(mLine2);
    if (e.note) {
      const mNote = document.createElement('div');
      mNote.className = 'm-note';
      mNote.appendChild(document.createTextNode('备注：'));
      appendHighlighted(mNote, e.note);
      mobileTd.appendChild(mNote);
      // 长备注会把一张卡片撑满整屏：先折三行，"展开备注"放在下面
      if (e.note.length > 60) {
        mNote.classList.add('is-clamped');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'm-note-toggle';
        toggle.textContent = '展开备注';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          const clamped = mNote.classList.toggle('is-clamped');
          toggle.textContent = clamped ? '展开备注' : '收起备注';
          toggle.setAttribute('aria-expanded', String(!clamped));
        });
        mobileTd.appendChild(toggle);
      }
    }
    mobileTd.setAttribute('aria-label', [
      `日期 ${e.date}`,
      wk === null ? '周次未知' : `第${wk}周`,
      WEEK_NAMES[e._date.getDay()],
      e.period,
      e.name,
      `地点 ${e.place}`,
      e.note ? `备注 ${e.note}` : '',
      tagText ? `状态 ${tagText}` : '',
      isNext ? `下一次实验 ${nextLabel}` : '',
      conflict ? '时间冲突' : ''
    ].filter(Boolean).join('；'));
    tr.appendChild(mobileTd);

    frag.appendChild(tr);

    if (e.note) {
      const noteTr = document.createElement('tr');
      noteTr.className = 'note-row';
      if (isNext) noteTr.classList.add('row-next');
      if (conflict) noteTr.dataset.conflict = String(conflict.id);
      const noteTd = document.createElement('td');
      noteTd.colSpan = 8;
      noteTd.appendChild(document.createTextNode('备注：'));
      appendHighlighted(noteTd, e.note);
      noteTr.appendChild(noteTd);
      frag.appendChild(noteTr);
    }
  });

  tbody.replaceChildren(frag);
  syncRowFocusability();
  syncTableA11y();
  syncConflictFilter(conflictInfo);
  lastRenderedDay = toDateStr(today);
  scheduleConflictLinks(conflictInfo);
}

/* ---------- 冲突连线 ----------
   卡片布局（手机 / 两列）下，把同一冲突组的两张卡用"最短线段"连起来：
   取两张卡 4×4 个顶点里距离最近的一对，连一条琥珀色线。
   线段画在卡片下层（z-index 0），所以只在行距/列距里露出来，不会压住文字。 */
let conflictLinkRaf = 0;
let lastConflictInfo = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
const CONFLICT_LINE_WIDTH = 2; // 与 .conflict-link-line 的 stroke-width 保持一致

function scheduleConflictLinks(info) {
  lastConflictInfo = info || null;
  if (conflictLinkRaf) window.cancelAnimationFrame(conflictLinkRaf);
  // 等一次布局再量，避免刚 replaceChildren 时拿到旧几何
  conflictLinkRaf = window.requestAnimationFrame(() => {
    conflictLinkRaf = 0;
    drawConflictLinks();
  });
}

function cardCorners(rect, origin) {
  const left = rect.left - origin.left;
  const top = rect.top - origin.top;
  const right = left + rect.width;
  const bottom = top + rect.height;
  return [
    { x: left, y: top }, { x: right, y: top },
    { x: left, y: bottom }, { x: right, y: bottom }
  ];
}

function nearestCornerPair(trA, trB, origin) {
  const rectA = trA.getBoundingClientRect();
  const rectB = trB.getBoundingClientRect();
  const a = cardCorners(rectA, origin);
  const b = cardCorners(rectB, origin);
  let best = null;
  a.forEach(pa => b.forEach(pb => {
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    const dist = dx * dx + dy * dy;
    if (!best || dist < best.dist) best = { dist, pa, pb };
  }));
  if (!best) return best;
  // 端点往卡片中心收半个线宽：这样线段外侧正好压住卡片 2px 描边的中线，
  // 视觉上和左/上边框严丝合缝（否则线会有半像素错位）。
  const inset = CONFLICT_LINE_WIDTH / 2;
  const pullIn = (point, rect) => {
    const cx = rect.left + rect.width / 2 - origin.left;
    const cy = rect.top + rect.height / 2 - origin.top;
    return {
      x: point.x + (cx > point.x ? inset : -inset),
      y: point.y + (cy > point.y ? inset : -inset)
    };
  };
  best.pa = pullIn(best.pa, rectA);
  best.pb = pullIn(best.pb, rectB);
  return best;
}

function drawConflictLinks() {
  const layer = document.getElementById('conflictLinkLayer');
  if (!layer) return;
  const svg = layer.querySelector('svg');
  if (!svg) return;
  const cardsMode = window.matchMedia('(max-width: 940px)').matches
    && !document.body.classList.contains('view-week');
  const groups = lastConflictInfo && lastConflictInfo.groups ? lastConflictInfo.groups : [];
  if (!cardsMode || !groups.length) {
    layer.hidden = true;
    svg.replaceChildren();
    return;
  }

  // 只连"当前看得见"的行：筛选后组员可能只显示一条，那就没有线可画
  const byGroup = new Map();
  tbodyEl.querySelectorAll('tr[data-idx]').forEach(tr => {
    const group = lastConflictInfo.byIndex.get(Number(tr.dataset.idx));
    if (!group) return;
    if (!byGroup.has(group.id)) byGroup.set(group.id, []);
    byGroup.get(group.id).push(tr);
  });

  const wrap = layer.parentElement;
  const origin = wrap.getBoundingClientRect();
  const segments = [];
  byGroup.forEach(rows => {
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1];
      const b = rows[i];
      const pair = nearestCornerPair(a, b, origin);
      if (!pair) continue;
      // 连线颜色跟随这一对行的边框：同名重复是 peer，已结束是 past
      pair.peer = a.classList.contains('conflict-peer') && b.classList.contains('conflict-peer');
      pair.past = a.classList.contains('row-past') && b.classList.contains('row-past');
      segments.push(pair);
    }
  });

  if (!segments.length) {
    layer.hidden = true;
    svg.replaceChildren();
    return;
  }

  svg.setAttribute('viewBox', `0 0 ${Math.round(origin.width)} ${Math.round(origin.height)}`);
  const frag = document.createDocumentFragment();
  segments.forEach(({ pa, pb, peer, past }) => {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'conflict-link-line' + (peer ? ' is-peer' : '') + (past ? ' is-past' : ''));
    line.setAttribute('x1', pa.x.toFixed(1));
    line.setAttribute('y1', pa.y.toFixed(1));
    line.setAttribute('x2', pb.x.toFixed(1));
    line.setAttribute('y2', pb.y.toFixed(1));
    frag.appendChild(line);
  });
  svg.replaceChildren(frag);
  layer.hidden = false;
}

// 窗口尺寸变化会重排卡片，连线得跟着重算（防抖，避免拖动窗口时狂算）
let conflictLinkResize = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(conflictLinkResize);
  conflictLinkResize = window.setTimeout(drawConflictLinks, 150);
});
window.addEventListener('orientationchange', () => window.setTimeout(drawConflictLinks, 250));

/* 跨天刷新：页面挂一夜后，时钟已经跳到新的一天，
   但"今天/明天"标签、顶部提示条、课表的今天列都还停在昨天。
   30 秒心跳 + 回到前台各查一次（后台标签页的定时器会被浏览器节流）。 */
let lastRenderedDay = '';

function refreshIfDayChanged() {
  if (!lastRenderedDay) return false;
  if (toDateStr(new Date()) === lastRenderedDay) return false;
  render();
  updateClock();
  // 「数据 N 天前」也是按日期算的，跨天必须跟着重算（否则页面挂一夜会少算一天）
  updateDataUpdatedBadge();
  showStatus('ok', '日期已变化，列表已刷新到今天');
  return true;
}


/* ============================================================
   7. xlsx 读写（内置实现，完全离线，不依赖任何网络资源）
   ============================================================ */
const XML_NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML_NS_REL  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// 导入 xlsx 的安全上限，防止 ZIP bomb / XML 膨胀 / 超大表格
const XLSX_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  entries: 512,
  entryBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  ratio: 1000,
  xmlBytes: 12 * 1024 * 1024,
  rows: 5000,
  cols: 64,
  cellChars: 2000,
  sharedStrings: 20000,
  sharedChars: 5 * 1024 * 1024
};
const MAX_WEEK = 1000;

function xmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[c]);
}

function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndexFromRef(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!m) return -1;
  let n = 0;
  for (let i = 0; i < m[1].length; i++) {
    n = n * 26 + (m[1].toUpperCase().charCodeAt(i) - 64);
  }
  return n - 1;
}

/* ---------- ZIP 写入（store 方式，不压缩） ---------- */
const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipDosDateTime(d) {
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F),
    date: (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  };
}

function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  const dt = zipDosDateTime(new Date());
  let offset = 0;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = zipCrc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);   // 文件名使用 UTF-8
    lv.setUint16(8, 0, true);        // 不压缩
    lv.setUint16(10, dt.time, true);
    lv.setUint16(12, dt.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dt.time, true);
    cv.setUint16(14, dt.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  });

  const cdStart = offset;
  let cdSize = 0;
  central.forEach(c => { chunks.push(c); cdSize += c.length; });

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);

  let total = 0;
  chunks.forEach(c => { total += c.length; });
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach(c => { out.set(c, p); p += c.length; });
  return out;
}

/* ---------- 生成 xlsx ---------- */
function makeXlsxSheetXml(aoa, colWidths, highlightRows, tabSelected) {
  const width = aoa.reduce((m, row) => Math.max(m, row.length), 0);
  const colsXml = (colWidths || []).slice(0, width).map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
  ).join('');

  const rowsXml = aoa.map((row, r) => {
    let cells = '';
    const style = highlightRows && highlightRows.has(r) ? ' s="1"' : '';
    for (let c = 0; c < width; c++) {
      const raw = row[c] == null ? '' : row[c];
      const text = String(raw);
      const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
      cells += `<c r="${colName(c)}${r + 1}" t="inlineStr"${style}><is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
    }
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const lastRow = Math.max(1, aoa.length);
  const lastCol = colName(Math.max(0, width - 1));

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="${XML_NS_MAIN}">` +
      `<sheetViews><sheetView${tabSelected ? ' tabSelected="1"' : ''} workbookViewId="0">` +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (colsXml ? `<cols>${colsXml}</cols>` : '') +
      `<sheetData>${rowsXml}</sheetData>` +
      `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
    '</worksheet>';
}

function buildXlsxBlob(aoa, sheetName, colWidths, highlightRows, metaAoa) {
  const sheetXml = makeXlsxSheetXml(aoa, colWidths, highlightRows, true);
  const hasMeta = Array.isArray(metaAoa) && metaAoa.length > 0;
  const metaSheetXml = hasMeta ? makeXlsxSheetXml(metaAoa, [22, 36], null, false) : '';

  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<workbook xmlns="${XML_NS_MAIN}" xmlns:r="${XML_NS_REL}">` +
      `<sheets><sheet name="${xmlEscape(sheetName || '实验安排')}" sheetId="1" r:id="rId1"/>` +
      (hasMeta ? '<sheet name="班级信息" sheetId="2" r:id="rId2"/>' : '') +
      '</sheets>' +
    '</workbook>';

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<styleSheet xmlns="${XML_NS_MAIN}">` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1C2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      (hasMeta ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : '') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${XML_NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>';

  const stylesRelId = hasMeta ? 'rId3' : 'rId2';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${XML_NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      (hasMeta ? `<Relationship Id="rId2" Type="${XML_NS_REL}/worksheet" Target="worksheets/sheet2.xml"/>` : '') +
      `<Relationship Id="${stylesRelId}" Type="${XML_NS_REL}/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
  ];
  if (hasMeta) files.push({ name: 'xl/worksheets/sheet2.xml', data: metaSheetXml });

  const bytes = zipStore(files);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1500);
}

/* ---------- 读取 xlsx ---------- */
const XML_POLICY_NAME = 'xlsx-xml';
let xmlPolicy = null;

// DOMParser 在 Trusted Types 下需要 TrustedHTML；这里只开放一个受控策略，
// 仅用于解析已通过大小/DTD 校验的 xlsx XML，不做任何 HTML 渲染。
function asTrustedXml(text) {
  const s = String(text);
  if (typeof trustedTypes === 'undefined' || !trustedTypes.createPolicy) return s;
  if (!xmlPolicy) {
    xmlPolicy = trustedTypes.createPolicy(XML_POLICY_NAME, {
      createHTML: value => {
        const t = String(value);
        if (t.length > XLSX_LIMITS.xmlBytes) throw new Error('xlsx XML 过大');
        if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new Error('xlsx 包含不安全的 XML 声明');
        return t;
      }
    });
  }
  return xmlPolicy.createHTML(s);
}

function parseXml(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  if (s.length > XLSX_LIMITS.xmlBytes) throw new Error('xlsx XML 过大');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('xlsx 包含不安全的 XML 声明');
  const doc = new DOMParser().parseFromString(asTrustedXml(s), 'application/xml');
  if (!doc || doc.getElementsByTagName('parsererror').length) {
    throw new Error('文件内容不是有效的 XML');
  }
  return doc;
}

function firstChildByLocalName(el, name) {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n.localName || n.nodeName) === name) return n;
  }
  return null;
}

function collectTextRuns(el, out) {
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const ln = n.localName || n.nodeName;
    if (ln === 't') out.push(n.textContent == null ? '' : n.textContent);
    else if (ln !== 'rPh') collectTextRuns(n, out);
  }
  return out;
}

function stringItemText(el) {
  return collectTextRuns(el, []).join('');
}

function normalizeZipPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); }
    else out.push(part);
  }
  return out.join('/');
}

function resolveZipPath(baseDir, target) {
  const t = String(target || '').replace(/\\/g, '/');
  if (t.charAt(0) === '/') return normalizeZipPath(t.slice(1));
  return normalizeZipPath(baseDir + t);
}

function isAllowedEntryName(name) {
  return name === 'xl/workbook.xml'
    || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
}

async function inflateRaw(data, maxBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 xlsx，请使用新版 Edge 或 Chrome 打开');
  }
  let stream;
  try {
    stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch (e) {
    throw new Error('当前浏览器不支持 deflate 解压，请使用新版 Edge 或 Chrome 打开');
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        throw new Error('xlsx 解压数据超过安全上限');
      }
      chunks.push(step.value);
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22) throw new Error('不是有效的 xlsx 文件（文件过小）');
  const view = new DataView(buffer, 0, bytes.length);

  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 0xFFFF);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（zip 结构缺失）');

  const total = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  if (!total || off >= bytes.length) throw new Error('不是有效的 xlsx 文件（zip 目录为空）');
  if (total > XLSX_LIMITS.entries) throw new Error('xlsx ZIP 条目过多');

  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  let totalBytes = 0;

  for (let i = 0; i < total; i++) {
    if (off + 46 > bytes.length || view.getUint32(off, true) !== 0x02014b50) {
      throw new Error('不是有效的 xlsx 文件（zip 目录损坏）');
    }

    const flags = view.getUint16(off + 8, true);
    const method = view.getUint16(off + 10, true);
    const crc = view.getUint32(off + 16, true);
    const compSize = view.getUint32(off + 20, true);
    const uncompSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const nextOff = off + 46 + nameLen + extraLen + commentLen;

    if (nextOff > bytes.length) throw new Error('不是有效的 xlsx 文件（zip 目录损坏）');

    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    const normalized = normalizeZipPath(name);

    // 只读取必要的 XML；图片、主题等未知条目直接跳过，不解压
    if (!isAllowedEntryName(normalized)) {
      off = nextOff;
      continue;
    }
    if (entries.has(normalized)) throw new Error('xlsx ZIP 条目重复');

    if (flags & 1) throw new Error('文件已加密，无法导入');
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
      throw new Error('暂不支持 ZIP64 格式的 xlsx 文件');
    }
    if (uncompSize > XLSX_LIMITS.entryBytes || totalBytes + uncompSize > XLSX_LIMITS.totalBytes) {
      throw new Error('xlsx 数据超过安全上限');
    }
    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error('不是有效的 xlsx 文件（zip 数据头损坏）');
    }

    const lFlags = view.getUint16(localOff + 6, true);
    const lMethod = view.getUint16(localOff + 8, true);
    if (lFlags & 1) throw new Error('文件已加密，无法导入');
    if (lMethod !== method) throw new Error('xlsx ZIP 头不一致');

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) throw new Error('不是有效的 xlsx 文件（zip 数据不完整）');

    const raw = bytes.subarray(dataStart, dataEnd);
    const remaining = Math.min(XLSX_LIMITS.entryBytes, XLSX_LIMITS.totalBytes - totalBytes);
    let content;

    if (method === 0) {
      if (raw.length > remaining) throw new Error('xlsx 解压数据超过安全上限');
      content = raw;
    } else if (method === 8) {
      content = await inflateRaw(raw, remaining);
    } else {
      throw new Error('不支持的压缩方式（' + method + '）');
    }

    if (content.length > XLSX_LIMITS.entryBytes || totalBytes + content.length > XLSX_LIMITS.totalBytes) {
      throw new Error('xlsx 解压数据超过安全上限');
    }
    if (compSize > 0 && content.length > compSize * XLSX_LIMITS.ratio) {
      throw new Error('xlsx 压缩比异常');
    }
    if (zipCrc32(content) !== crc) throw new Error('xlsx 数据校验失败');

    totalBytes += content.length;
    entries.set(normalized, content);
    off = nextOff;
  }

  return entries;
}

function excelSerialToDate(serial, date1904) {
  let n = Number(serial);
  if (!isFinite(n) || n <= 0) return null;
  if (date1904) n += 1462;
  const utc = new Date(Math.round((n - 25569) * 86400000));
  if (isNaN(utc.getTime())) return null;
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

async function readXlsxRows(buffer) {
  const entries = await unzipEntries(buffer);
  const decoder = new TextDecoder('utf-8');
  const readText = name => {
    if (!entries.has(name)) return '';
    const bytes = entries.get(name);
    if (bytes.length > XLSX_LIMITS.xmlBytes) throw new Error('xlsx XML 过大');
    const text = decoder.decode(bytes);
    if (text.length > XLSX_LIMITS.xmlBytes) throw new Error('xlsx XML 过大');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('xlsx 包含不安全的 XML 声明');
    return text;
  };

  const workbookText = readText('xl/workbook.xml');
  if (!workbookText) throw new Error('不是有效的 xlsx 文件（缺少 workbook.xml）');

  const workbookDoc = parseXml(workbookText);
  let date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbookText);
  const prEl = workbookDoc.getElementsByTagNameNS('*', 'workbookPr')[0];
  if (prEl && /^(?:1|true)$/i.test(prEl.getAttribute('date1904') || '')) date1904 = true;

  const sheetEls = workbookDoc.getElementsByTagNameNS('*', 'sheet');
  if (sheetEls.length > XLSX_LIMITS.entries) throw new Error('xlsx 工作表数量异常');

  const rels = new Map();
  const relsText = readText('xl/_rels/workbook.xml.rels');
  if (relsText) {
    const relsDoc = parseXml(relsText);
    const relEls = relsDoc.getElementsByTagNameNS('*', 'Relationship');
    if (relEls.length > XLSX_LIMITS.entries) throw new Error('xlsx 关系数量异常');
    for (let i = 0; i < relEls.length; i++) {
      const id = relEls[i].getAttribute('Id');
      if (id) rels.set(id, {
        target: relEls[i].getAttribute('Target') || '',
        type: relEls[i].getAttribute('Type') || ''
      });
    }
  }

  const sheetInfos = [];
  for (let i = 0; i < sheetEls.length; i++) {
    const rid = sheetEls[i].getAttributeNS(XML_NS_REL, 'id') || sheetEls[i].getAttribute('r:id');
    const rel = rid ? rels.get(rid) : null;
    if (!rel || !rel.target) continue;
    const p = resolveZipPath('xl/', rel.target);
    sheetInfos.push({
      name: sheetEls[i].getAttribute('name') || '',
      path: p,
      type: rel.type || ''
    });
  }
  const worksheets = sheetInfos.filter(s => /\/worksheet$/i.test(s.type));
  const primaryInfo = worksheets.find(s => s.name === '实验安排') || worksheets[0] || sheetInfos[0] || null;
  const metaInfo = worksheets.find(s => s.name === '班级信息') || null;
  let sheetPath = primaryInfo ? primaryInfo.path : '';
  let metaPath = metaInfo ? metaInfo.path : '';

  if (!sheetPath || !entries.has(sheetPath)) {
    const candidates = [];
    entries.forEach((v, name) => {
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) candidates.push(name);
    });
    candidates.sort();
    if (!candidates.length) throw new Error('工作簿中没有工作表');
    sheetPath = candidates[0];
  }
  if (!metaPath || !entries.has(metaPath) || metaPath === sheetPath) metaPath = '';

  let shared = [];
  const sharedText = readText('xl/sharedStrings.xml');
  if (sharedText) {
    const sharedDoc = parseXml(sharedText);
    const sis = sharedDoc.getElementsByTagNameNS('*', 'si');
    if (sis.length > XLSX_LIMITS.sharedStrings) throw new Error('xlsx 共享字符串过多');
    let sharedChars = 0;
    for (let i = 0; i < sis.length; i++) {
      const text = stringItemText(sis[i]);
      if (text.length > XLSX_LIMITS.cellChars) throw new Error('xlsx 单元格文本过长');
      sharedChars += text.length;
      if (sharedChars > XLSX_LIMITS.sharedChars) throw new Error('xlsx 共享字符串过大');
      shared.push(text);
    }
  }

  function parseSheetRows(path) {
    const sheetDoc = parseXml(readText(path));
    const rowEls = sheetDoc.getElementsByTagNameNS('*', 'row');
    if (rowEls.length > XLSX_LIMITS.rows) throw new Error('xlsx 行数超过安全上限');
    const rows = [];
    let maxCol = 0;

    for (let i = 0; i < rowEls.length; i++) {
      const rowEl = rowEls[i];
      const rNum = parseInt(rowEl.getAttribute('r') || '', 10);
      if (rNum > XLSX_LIMITS.rows) throw new Error('xlsx 行号超过安全上限');
      const rowIndex = rNum > 0 ? rNum - 1 : rows.length;
      if (rowIndex >= XLSX_LIMITS.rows) throw new Error('xlsx 行数超过安全上限');
      const cells = [];
      let nextCol = 0;

      const cellEls = rowEl.getElementsByTagNameNS('*', 'c');
      if (cellEls.length > XLSX_LIMITS.cols) throw new Error('xlsx 列数超过安全上限');
      for (let j = 0; j < cellEls.length; j++) {
        const cEl = cellEls[j];
        let col = colIndexFromRef(cEl.getAttribute('r'));
        if (col < 0) col = nextCol;
        if (col >= XLSX_LIMITS.cols) throw new Error('xlsx 列数超过安全上限');
        nextCol = col + 1;

        const t = cEl.getAttribute('t') || 'n';
        const vEl = firstChildByLocalName(cEl, 'v');
        const isEl = firstChildByLocalName(cEl, 'is');
        const vText = vEl ? String(vEl.textContent == null ? '' : vEl.textContent) : '';
        if (vText.length > XLSX_LIMITS.cellChars) throw new Error('xlsx 单元格文本过长');
        let value = '';

        if (t === 's') {
          const idx = parseInt(vText, 10);
          value = (idx >= 0 && idx < shared.length) ? shared[idx] : '';
        } else if (t === 'inlineStr') {
          value = isEl ? stringItemText(isEl) : vText;
        } else if (t === 'str') {
          value = vText;
        } else if (t === 'b') {
          value = vText === '1';
        } else if (t === 'e') {
          value = '';
        } else if (t === 'd') {
          const d = vText ? new Date(vText) : null;
          value = (d && !isNaN(d.getTime())) ? d : vText;
        } else {
          const trimmed = vText.trim();
          if (trimmed !== '') {
            const num = Number(trimmed);
            value = isFinite(num) ? num : vText;
          }
        }

        if (typeof value === 'string' && value.length > XLSX_LIMITS.cellChars) {
          throw new Error('xlsx 单元格文本过长');
        }

        cells[col] = value;
        if (col + 1 > maxCol) maxCol = col + 1;
      }

      rows[rowIndex] = cells;
    }

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const src = rows[i] || [];
      const arr = new Array(maxCol);
      for (let j = 0; j < maxCol; j++) arr[j] = src[j] === undefined ? '' : src[j];
      out.push(arr);
    }
    return out;
  }

  const rows = parseSheetRows(sheetPath);
  const metaRows = metaPath ? parseSheetRows(metaPath) : null;
  return { rows, date1904, metaRows };
}

function cellToLocalDate(v, date1904) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const utcZero = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
    const locZero = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0;
    if (utcZero || !locZero) {
      return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
    }
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  if (typeof v === 'number' && isFinite(v)) {
    return excelSerialToDate(v, date1904);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  return null;
}

function isBlankRow(row) {
  if (!row || !row.length) return true;
  return row.every(c => String(c == null ? '' : c).trim() === '');
}

function formatSkipped(skipped) {
  const limit = 5;
  if (skipped.length <= limit) return skipped.join('\n');
  return skipped.slice(0, limit).join('\n') + `\n…另有 ${skipped.length - limit} 行未列出`;
}

function parseClassInfoRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const meta = {};
  rows.forEach(row => {
    if (!Array.isArray(row)) return;
    const key = normalizeHeader(row[0]);
    if (!key) return;
    const value = row[1] == null ? '' : String(row[1]).trim();
    if (!(key in meta)) meta[key] = value;
  });
  return Object.keys(meta).length ? meta : null;
}

async function importXlsx(file) {
  if (!file || typeof file.size !== 'number') throw new Error('无法读取文件');
  if (file.size > XLSX_LIMITS.fileBytes) {
    throw new Error('文件过大，最大支持 ' + Math.round(XLSX_LIMITS.fileBytes / 1024 / 1024) + 'MB');
  }

  const buf = await file.arrayBuffer();
  if (buf.byteLength < 4) throw new Error('不是有效的 xlsx 文件');
  const head = new Uint8Array(buf, 0, 4);
  if (head[0] !== 0x50 || head[1] !== 0x4B || head[2] !== 0x03 || head[3] !== 0x04) {
    throw new Error('不是有效的 xlsx 文件（ZIP 头不正确）');
  }

  let parsed;
  try {
    parsed = await readXlsxRows(buf);
  } catch (e) {
    throw new Error(e && e.message ? e.message : '文件解析失败，可能不是有效的 xlsx 文件');
  }

  const rows = parsed.rows;
  const meta = parseClassInfoRows(parsed.metaRows);
  let fileClass = classIdFromFileName(file.name);
  let exportScope = 'all';
  let importWeek1 = week1Start;
  if (meta) {
    const metaClass = cleanText(meta['班级'], 160).trim();
    fileClass = resolveImportFileClass(fileClass, metaClass);
    if (metaClass && fileClass && metaClass !== fileClass) {
      throw new Error(`班级信息为 ${metaClass}，与文件名班级 ${fileClass} 不一致，已阻止导入`);
    }
    const metaScope = cleanText(meta['导出范围'], 20).trim();
    if (metaScope.includes('筛选')) exportScope = 'filtered';
    const metaVersion = cleanText(meta['备份格式版本'], 20).trim();
    if (metaVersion && metaVersion !== '1') {
      throw new Error(`不支持的备份格式版本：${metaVersion}`);
    }
    const metaWeek1 = cleanText(meta['week1'], 20).trim();
    if (metaWeek1 && !isValidDateStr(metaWeek1)) {
      throw new Error('班级信息中的 week1 不是有效日期，已阻止导入');
    }
    if (metaWeek1 && parseDate(metaWeek1).getDay() !== 1) {
      throw new Error('班级信息中的 week1 不是星期一，已阻止导入');
    }
    if (metaWeek1) importWeek1 = parseDate(metaWeek1);
  }

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!isBlankRow(rows[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('工作表为空');

  const headerRow = rows[headerIdx].map(normalizeHeader);

  const colIdx = {};
  ['日期', '周次', '星期', '节次', '实验名称', '实验地点', '备注'].forEach(h => {
    const i = headerRow.indexOf(h);
    if (i >= 0) colIdx[h] = i;
  });

  const missingBase = BASE_REQUIRED.filter(h => !(h in colIdx));
  if (missingBase.length) {
    throw new Error('缺少表头【' + missingBase.join('】【') + '】');
  }

  const hasDateCol = '日期' in colIdx;
  const hasWeekCol = '周次' in colIdx;
  const hasWkdCol  = '星期' in colIdx;
  if (!hasDateCol && !(hasWeekCol && hasWkdCol)) {
    throw new Error('缺少【日期】列，或同时提供【周次】和【星期】列');
  }
  const timeMode = hasDateCol
    ? ((hasWeekCol || hasWkdCol) ? 'mixed' : 'date')
    : 'week';

  const list = [];
  const skipped = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    if (isBlankRow(row)) continue;
    if (list.length >= MAX_EXPERIMENTS) {
      skipped.push('实验数量超过上限');
      break;
    }

    let dt = null;

    if (hasDateCol) {
      dt = cellToLocalDate(row[colIdx['日期']], parsed.date1904);
    }

    // 周次+星期优先；不完整/无法识别时回退到日期。
    if (hasWeekCol && hasWkdCol) {
      const wk = parseWeekNo(row[colIdx['周次']]);
      const wd = parseWeekday(row[colIdx['星期']]);
      if (wk && wk <= MAX_WEEK && wd) {
        dt = dateFromWeekWeekdayBase(wk, wd, importWeek1);
      }
    }

    if (!dt) {
      throw new Error(`第 ${rowNo} 行：日期无法识别，且周次+星期不完整/无效`);
    }

    const rawName = String(row[colIdx['实验名称']] == null ? '' : row[colIdx['实验名称']]).trim();
    if (!rawName) { skipped.push(`第 ${rowNo} 行：实验名称为空`); continue; }
    if (rawName.length > MAX_NAME_LEN) { skipped.push(`第 ${rowNo} 行：实验名称过长`); continue; }
    const name = cleanText(rawName, MAX_NAME_LEN);
    if (!name) { skipped.push(`第 ${rowNo} 行：实验名称为空`); continue; }

    const rawPeriod = String(row[colIdx['节次']] == null ? '' : row[colIdx['节次']]).trim();
    if (!rawPeriod) { skipped.push(`第 ${rowNo} 行：节次为空`); continue; }
    if (rawPeriod.length > MAX_PERIOD_LEN) { skipped.push(`第 ${rowNo} 行：节次过长`); continue; }
    const period = cleanText(rawPeriod, MAX_PERIOD_LEN);
    if (!period) { skipped.push(`第 ${rowNo} 行：节次为空`); continue; }

    const rawPlace = String(row[colIdx['实验地点']] == null ? '' : row[colIdx['实验地点']]).trim();
    if (rawPlace.length > MAX_PLACE_LEN) { skipped.push(`第 ${rowNo} 行：实验地点过长`); continue; }
    const place = cleanText(rawPlace, MAX_PLACE_LEN) || '待定';

    const rawNote = '备注' in colIdx
      ? String(row[colIdx['备注']] == null ? '' : row[colIdx['备注']]).trim()
      : '';
    if (rawNote.length > MAX_NOTE_LEN) { skipped.push(`第 ${rowNo} 行：备注过长`); continue; }
    const note = cleanNote(rawNote);

    list.push({ date: toDateStr(dt), period, name, place, note });
  }

  if (!list.length) {
    throw new Error(
      skipped.length
        ? '没有可导入的有效数据（' + skipped[0] + '）'
        : '没有可导入的有效数据'
    );
  }

  return {
    list,
    skipped,
    timeMode,
    meta,
    fileClass,
    metaClass: meta ? cleanText(meta['班级'], 160).trim() : '',
    exportScope,
    week1: meta ? cleanText(meta['week1'], 20).trim() : '',
    periodTimes: sanitizePeriodTimes(meta ? meta['periodTimes'] : null)
  };
}

async function importJsonFile(file) {
  if (!file || typeof file.size !== 'number') throw new Error('无法读取文件');
  if (file.size > XLSX_LIMITS.fileBytes) {
    throw new Error('文件过大，最大支持 ' + Math.round(XLSX_LIMITS.fileBytes / 1024 / 1024) + 'MB');
  }

  let text = '';
  try {
    text = await file.text();
  } catch (e) {
    throw new Error('无法读取 JSON 文件');
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 不是有效格式');
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.experiments)) {
    throw new Error('JSON 缺少 experiments 数组');
  }
  if (obj.format && obj.format !== 'crsecue-class-backup') {
    throw new Error('不是 CrseCue 班级备份 JSON');
  }
  const version = Number(obj.version || 1);
  if (version !== 1 && version !== 2) {
    throw new Error(`不支持的 JSON 备份版本：${obj.version}`);
  }

  let fileClass = classIdFromFileName(file.name);
  const metaClass = cleanText(obj.class, 160).trim();
  fileClass = resolveImportFileClass(fileClass, metaClass);
  if (metaClass && fileClass && metaClass !== fileClass) {
    throw new Error(`备份班级为 ${metaClass}，与文件名班级 ${fileClass} 不一致，已阻止导入`);
  }
  const exportScope = String(obj.scope || 'all').toLowerCase() === 'filtered' ? 'filtered' : 'all';
  const week1 = cleanText(obj.week1, 20).trim();
  if (week1 && !isValidDateStr(week1)) {
    throw new Error('JSON 中的 week1 不是有效日期，已阻止导入');
  }
  if (week1 && parseDate(week1).getDay() !== 1) {
    throw new Error('JSON 中的 week1 不是星期一，已阻止导入');
  }

  const list = [];
  const skipped = [];
  const rows = obj.experiments;
  if (rows.length > MAX_EXPERIMENTS) {
    throw new Error(`JSON 实验数量超过上限 ${MAX_EXPERIMENTS}`);
  }
  rows.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      skipped.push(`第 ${i + 1} 条：不是对象`);
      return;
    }
    const dateStr = cleanText(raw.date, 20).trim();
    if (!isValidDateStr(dateStr)) {
      skipped.push(`第 ${i + 1} 条：日期无效`);
      return;
    }
    const period = cleanText(raw.period, MAX_PERIOD_LEN).trim();
    if (!period) {
      skipped.push(`第 ${i + 1} 条：节次为空`);
      return;
    }
    const name = cleanText(raw.name, MAX_NAME_LEN).trim();
    if (!name) {
      skipped.push(`第 ${i + 1} 条：实验名称为空`);
      return;
    }
    const place = cleanText(raw.place, MAX_PLACE_LEN).trim() || '待定';
    const rawNote = String(raw.note == null ? '' : raw.note);
    if (rawNote.length > MAX_NOTE_LEN) {
      skipped.push(`第 ${i + 1} 条：备注过长`);
      return;
    }
    const note = cleanNote(rawNote);
    list.push({ date: dateStr, period, name, place, note });
  });

  if (!list.length) {
    throw new Error(
      skipped.length
        ? '没有可导入的有效数据（' + skipped[0] + '）'
        : '没有可导入的有效数据'
    );
  }

  return {
    list,
    skipped,
    timeMode: 'date',
    source: 'json',
    meta: {
      '备份格式版本': String(version),
      '班级': metaClass,
      '记录数': String(obj.count == null ? list.length : obj.count),
      'week1': week1
    },
    metaClass,
    fileClass,
    exportScope,
    week1,
    periodTimes: sanitizePeriodTimes(obj.periodTimes)
  };
}



/* ============================================================
   8. DOM 引用 & 状态提示
   ============================================================ */
const importBtn  = document.getElementById('importBtn');
const exportBtn  = document.getElementById('exportBtn');
const classSelect = document.getElementById('classSelect');
const newClassBtn = document.getElementById('newClassBtn');
const renameClassBtn = document.getElementById('renameClassBtn');
const deleteClassBtn = document.getElementById('deleteClassBtn');
const classMask = document.getElementById('classMask');
const classPromptTitle = document.getElementById('classPromptTitle');
const classPromptInput = document.getElementById('classPromptInput');
const classPromptError = document.getElementById('classPromptError');
const classPromptHint = document.getElementById('classPromptHint');
const restoreToolBtn = document.getElementById('restoreToolBtn');
const restoreMask = document.getElementById('restoreMask');
const restoreClose = document.getElementById('restoreClose');
const restoreDone = document.getElementById('restoreDone');
const restoreDefaultBtn = document.getElementById('restoreDefaultBtn');
const restoreDefaultHint = document.getElementById('restoreDefaultHint');
const restoreHiddenList = document.getElementById('restoreHiddenList');
const restoreError = document.getElementById('restoreError');
const classPromptClose = document.getElementById('classPromptClose');
const classPromptCancel = document.getElementById('classPromptCancel');
const classPromptOk = document.getElementById('classPromptOk');
const copyMask = document.getElementById('copyMask');
const copyFallbackText = document.getElementById('copyFallbackText');
const copyFallbackSelect = document.getElementById('copyFallbackSelect');
const copyFallbackDone = document.getElementById('copyFallbackDone');
const copyFallbackClose = document.getElementById('copyFallbackClose');
const addBtn     = document.getElementById('addBtn');
const editModeBtn = document.getElementById('editModeBtn');
const deleteModeBtn = document.getElementById('deleteModeBtn');
const actionsToggle = document.getElementById('actionsToggle');
const actionPanel = document.getElementById('actionPanel');
const fileInput  = document.getElementById('fileInput');
const statusEl   = document.getElementById('importStatus');
const week1Input = document.getElementById('week1Input');
const recentFilter = document.getElementById('recentFilter');
const clockEl    = document.getElementById('clock');
const tbodyEl    = document.getElementById('tbody');
const tableCaptionEl = document.getElementById('tableCaption');
const scheduleTableEl = document.getElementById('scheduleTable');

function syncTableA11y() {
  // 行 label 始终保留：桌面 Tab 到行、手机触摸探索都读整行。
  document.querySelectorAll('#tbody tr:not(.note-row)').forEach(tr => {
    if (tr.dataset.a11yLabel) tr.setAttribute('aria-label', tr.dataset.a11yLabel);
  });

  // 手机端只读 cell-mobile 的 aria-label，避免内部两个 div 被拆成上下两段。
  document.querySelectorAll('#tbody td.cell-mobile').forEach(td => {
    Array.from(td.children).forEach(child => {
      child.setAttribute('aria-hidden', 'true');
    });
  });

  // 普通阅读时连表头一起隐藏操作列；进入编辑/删除模式后再暴露按钮。
  const actionVisible = editMode || deleteMode;
  document.querySelectorAll('#scheduleTable th.col-mark, #scheduleTable td.cell-mark').forEach(el => {
    if (actionVisible) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', 'true');
  });
}
const printHead = document.getElementById('printHead');
const printMeta = document.getElementById('printMeta');
const recentCountEl = document.getElementById('recentCount');
const modeBadgeEl = document.getElementById('modeBadge');
const firstRunEl = document.getElementById('firstRunHint');

// 首次访问提示：只出现一次。显示后立刻记住当前班，避免每次打开都打扰。
function showFirstRunHint() {
  if (!firstRunEl) return;
  if (!FIRST_VISIT || classIds.length < 2 || !selectedClass) {
    firstRunEl.hidden = true;
    return;
  }
  const text = document.createElement('span');
  text.textContent = `当前是 ${selectedClass}，不是你的班？在上方「班级」切换。`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'first-run-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭提示');
  close.addEventListener('click', () => {
    firstRunEl.hidden = true;
    saveSelectedClass();
  });
  firstRunEl.replaceChildren(text, close);
  firstRunEl.hidden = false;
  saveSelectedClass();
}

// 「本机数据 / 只读 / 本机数据已过期」徽标：不是装饰，是把"我改了但同学看不到"变成显式信息
function syncModeBadge() {
  if (!modeBadgeEl) return;
  if (READ_ONLY) {
    modeBadgeEl.hidden = false;
    modeBadgeEl.className = 'mode-badge is-readonly';
    modeBadgeEl.textContent = '只读';
    modeBadgeEl.title = '只读链接：不会写入本机数据';
    return;
  }
  if (usingSaved) {
    const stale = !!(savedDataVersion && DATA_UPDATED_AT && savedDataVersion !== DATA_UPDATED_AT);
    modeBadgeEl.hidden = false;
    modeBadgeEl.className = 'mode-badge is-local';
    modeBadgeEl.textContent = stale ? '本机数据较旧' : '本机数据';
    modeBadgeEl.title = stale
      ? `页面数据已更新到 ${DATA_UPDATED_AT}，你这份本机改动基于 ${savedDataVersion}；需要的话先导出备份，再点「恢复」重新载入`
      : '这些改动只存在这台设备，不会同步给同学；发布需要导出后重新 build';
    return;
  }
  modeBadgeEl.hidden = true;
}

/* ---------- 顶部「今天 / 下一节」提示条 ---------- */
const cueBarEl = document.getElementById('cueBar');
const cueTextEl = document.getElementById('cueText');
let cueBarDismissed = false;

function syncCueBar() {
  if (!cueBarEl || !cueTextEl) return;
  if (cueBarDismissed || !selectedClass) {
    cueBarEl.hidden = true;
    return;
  }
  const today = startOfDay(new Date());
  const list = getExperimentEntries();
  if (!list.length) {
    cueBarEl.hidden = true;
    return;
  }

  const times = currentPeriodTimes();
  const withTime = entry => {
    const slot = resolvePeriodTimes(entry.period, times);
    return `${entry.period}${slot ? `（${slot.start}–${slot.end}）` : ''} ${entry.name}`
      + (entry.place ? ' · ' + entry.place : '');
  };

  const todays = list.filter(entry => entry._date.getTime() === today.getTime());
  if (todays.length) {
    const detail = todays.length === 1 ? withTime(todays[0]) : todays.map(entry => withTime(entry)).join('；');
    cueTextEl.textContent = `今天 ${todays.length} 节：${detail}`;
    setCueTarget(todays[0]._idx);
    cueBarEl.classList.add('is-today');
    cueBarEl.hidden = false;
    return;
  }

  const next = list.find(entry => entry._date > today);
  cueBarEl.classList.remove('is-today');
  if (!next) {
    cueTextEl.textContent = '这门课暂时没有更多实验了';
    setCueTarget(null);
    cueBarEl.hidden = false;
    return;
  }
  const days = dayDiff(next._date, today);
  const dayName = WEEK_NAMES[next._date.getDay()].replace('星期', '周');
  cueTextEl.textContent = `下一节：${pad2(next._date.getMonth() + 1)}-${pad2(next._date.getDate())} ${dayName}`
    + ` ${withTime(next)}（${days} 天后）`;
  setCueTarget(next._idx);
  cueBarEl.hidden = false;
}

// 提示条上记住目标条目的下标：点一下就能跳过去并高亮
function setCueTarget(idx) {
  if (!cueTextEl) return;
  if (idx === null || idx === undefined) {
    delete cueTextEl.dataset.idx;
    cueTextEl.classList.remove('is-jumpable');
    cueTextEl.removeAttribute('role');
    cueTextEl.removeAttribute('tabindex');
    cueTextEl.removeAttribute('title');
    return;
  }
  cueTextEl.dataset.idx = String(idx);
  cueTextEl.classList.add('is-jumpable');
  cueTextEl.setAttribute('role', 'button');
  cueTextEl.tabIndex = 0;
  cueTextEl.title = '点击跳到这条实验';
}

function flashElement(el) {
  if (!el) return;
  el.classList.add('is-flash');
  window.setTimeout(() => el.classList.remove('is-flash'), 1600);
}

// 目标被筛选挡住时，先清掉筛选用它一次；返回是否真的清过
function clearFiltersHidingCue() {
  let changed = false;
  if (searchQuery || searchTerms.length || (searchInput && searchInput.value)) {
    searchQuery = '';
    searchTerms = [];
    if (searchInput) searchInput.value = '';
    changed = true;
  }
  if (conflictOnly) {
    conflictOnly = false;
    if (conflictFilter) conflictFilter.checked = false;
    changed = true;
  }
  return changed;
}

function cueTargetLabel(entry) {
  const weekday = WEEK_NAMES[parseDate(entry.date).getDay()] || '';
  return `${entry.date.slice(5)} ${weekday} ${entry.period}${entry.name ? ' ' + entry.name : ''}`;
}

function jumpToCueTarget() {
  const idx = Number(cueTextEl && cueTextEl.dataset.idx);
  if (!Number.isFinite(idx)) return;
  const entry = experiments[idx];
  if (!entry) return;
  const date = parseDate(entry.date);
  if (document.body.classList.contains('view-week')) {
    const weekStart = startOfWeekMonday(date);
    if (weekStart.getTime() !== weekViewStart.getTime()) {
      weekViewStart = weekStart;
      renderWeekView();
    }
    let block = weekViewEl && weekViewEl.querySelector(`.wg-item[data-idx="${idx}"]`);
    let cleared = false;
    if (!block) {
      cleared = clearFiltersHidingCue();
      if (cleared) {
        render();
        block = weekViewEl && weekViewEl.querySelector(`.wg-item[data-idx="${idx}"]`);
      }
    }
    if (!block) {
      showStatus('warn', '这条实验当前被筛选隐藏，清除筛选后仍找不到');
      return;
    }
    ensureElementVisible(block, true);
    flashElement(block);
    // 可见状态栏不再报"已定位到"；只有"顺手清了筛选"这种状态变化才播报给读屏
    if (cleared) announce('已清除筛选');
    return;
  }
  let row = tableBodyEl.querySelector(`tr[data-idx="${idx}"]`);
  let cleared = false;
  if (!row) {
    // 被搜索 / 只看冲突筛掉：清掉筛选再找一次，而不是点了没反应
    cleared = clearFiltersHidingCue();
    if (cleared) {
      render();
      row = tableBodyEl.querySelector(`tr[data-idx="${idx}"]`);
    }
  }
  if (!row) {
    showStatus('warn', '这条实验当前被筛选隐藏，清除筛选后仍找不到');
    return;
  }
  ensureElementVisible(row, true);
  flashElement(row);
  // 可见状态栏不再报"已定位到"；只有"顺手清了筛选"这种状态变化才播报给读屏
  if (cleared) announce('已清除筛选');
}

if (cueTextEl) {
  cueTextEl.addEventListener('click', jumpToCueTarget);
  cueTextEl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    jumpToCueTarget();
  });
}

const cueCloseBtn = document.getElementById('cueClose');
if (cueCloseBtn) {
  cueCloseBtn.addEventListener('click', () => {
    cueBarDismissed = true;
    if (cueBarEl) cueBarEl.hidden = true;
  });
}
const dataUpdatedEl = document.getElementById('dataUpdated');
const searchInput = document.getElementById('searchInput');
const copyWeekBtn = document.getElementById('copyWeekBtn');
const exportMask = document.getElementById('exportMask');
const exportXlsxChoice = document.getElementById('exportXlsxChoice');
const exportJsonChoice = document.getElementById('exportJsonChoice');
const exportScopeAll = document.getElementById('exportScopeAll');
const exportScopeFiltered = document.getElementById('exportScopeFiltered');
const exportAllCount = document.getElementById('exportAllCount');
const exportFilteredCount = document.getElementById('exportFilteredCount');
const exportClose = document.getElementById('exportClose');
const exportCancel = document.getElementById('exportCancel');

const liveStatusEl = document.getElementById('liveStatus');
const modalFocusOrigins = new WeakMap();

function rememberModalFocus(mask, fallback) {
  const active = document.activeElement;
  const origin = active && active !== document.body && active !== document.documentElement && active !== fileInput
    ? active
    : fallback;
  if (mask && (origin || fallback)) modalFocusOrigins.set(mask, { origin, fallback });
}

function restoreModalFocus(mask) {
  const entry = mask ? modalFocusOrigins.get(mask) : null;
  if (mask) modalFocusOrigins.delete(mask);
  if (!entry) return;
  const target = entry.origin && entry.origin.isConnected ? entry.origin : entry.fallback;
  if (!target || !target.isConnected) return;
  setTimeout(() => {
    try { target.focus({ preventScroll: true }); } catch (e) {}
  }, 0);
}

function topOpenModal() {
  const open = document.querySelectorAll('.modal-mask.show');
  return open.length ? open[open.length - 1] : null;
}

function focusableIn(mask) {
  if (!mask) return [];
  const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(mask.querySelectorAll(selector))
    .filter(el => el.getClientRects().length > 0);
}

document.addEventListener('keydown', ev => {
  if (ev.key !== 'Tab') return;
  const mask = topOpenModal();
  if (!mask) return;
  const focusables = focusableIn(mask);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey) {
    if (active === first || !mask.contains(active)) {
      ev.preventDefault();
      last.focus();
    }
  } else if (active === last || !mask.contains(active)) {
    ev.preventDefault();
    first.focus();
  }
});

/* 只写「数据更新至 2026-11-06」时，没人看得出这是一周前的快照。
   补一个按本机日期算的相对天数，让页面自己说出"这份安排可能旧了"，
   而不是等人去跑 validate_data.py 才发现。
   做成函数：跨天刷新时要重算，否则页面挂一夜，"9 天前"第二天还写着 9。 */
function updateDataUpdatedBadge() {
  if (!DATA_UPDATED_AT) return;
  let updatedLabel = `数据更新至 ${DATA_UPDATED_AT}`;
  const updatedDate = parseDate(DATA_UPDATED_AT);
  if (updatedDate && !isNaN(updatedDate.getTime())) {
    const daysAgo = dayDiff(startOfDay(new Date()), updatedDate);
    if (daysAgo === 0) updatedLabel += ' · 今天';
    else if (daysAgo > 0) updatedLabel += ` · ${daysAgo} 天前`;
  }
  dataUpdatedEl.textContent = updatedLabel;
  dataUpdatedEl.title = '部署数据快照的日期；「N 天前」按本机日期计算，换设备可能差一天';
  dataUpdatedEl.hidden = false;
}
updateDataUpdatedBadge();

const SEARCH_DEBOUNCE_MS = 60;
let searchDebounceTimer = 0;

function clearSearchState(focusInput) {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = 0;
  }
  searchQuery = '';
  searchTerms = [];
  if (searchInput) searchInput.value = '';
  if (focusInput && searchInput) searchInput.focus();
}

function applySearchInput() {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = 0;
  }
  const raw = String(searchInput.value || '').trim();
  searchQuery = raw;
  searchTerms = raw.toLowerCase().split(/\s+/).filter(Boolean);
  render();
}

function queueSearchInput() {
  const raw = String(searchInput.value || '').trim();
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(applySearchInput, SEARCH_DEBOUNCE_MS);
}

function matchesSearch(e) {
  if (!searchTerms.length) return true;
  const d = parseDate(e.date);
  const wk = weekNoOf(d);
  const haystack = [
    e.name, e.place, e.note || '', e.period, e.date,
    WEEK_NAMES[d.getDay()], wk === null ? '' : `第${wk}周`
  ].join(' ').toLowerCase();
  return searchTerms.every(term => haystack.includes(term));
}

function getExperimentEntries() {
  return experiments
    .map((e, i) => ({ ...e, _date: parseDate(e.date), _idx: i }))
    .sort((a, b) => (a._date - b._date) || (a._idx - b._idx));
}

function getFilteredExperimentEntries() {
  const conflictInfo = computeConflictInfo(experiments);
  const weekStart = startOfWeekMonday(startOfDay(new Date()));
  return getExperimentEntries()
    .filter(e => !recentOnly || e._date >= weekStart)
    .filter(e => !conflictOnly || conflictInfo.byIndex.has(e._idx))
    .filter(matchesSearch);
}

function getExportEntries() {
  return exportScopeFiltered.checked ? getFilteredExperimentEntries() : getExperimentEntries();
}

function getExportExperiments() {
  return getExportEntries().map(({ _date, _idx, ...e }) => ({ ...e }));
}

function refreshExportScopeCounts() {
  exportAllCount.textContent = String(experiments.length);
  exportFilteredCount.textContent = String(getFilteredExperimentEntries().length);
}

function appendHighlighted(parent, text) {
  const s = String(text == null ? '' : text);
  if (!searchTerms.length) {
    parent.appendChild(document.createTextNode(s));
    return;
  }
  const escaped = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'gi');
  let last = 0;
  let match;
  while ((match = pattern.exec(s)) !== null) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(s.slice(last, match.index)));
    }
    const mark = document.createElement('mark');
    mark.className = 'search-hit';
    mark.textContent = match[0];
    parent.appendChild(mark);
    last = match.index + match[0].length;
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
}

function buildWeekText() {
  const today = startOfDay(new Date());
  const weekStart = startOfWeekMonday(today);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const wk = weekNoOf(weekStart);
  const list = experiments
    .map((e, i) => ({ ...e, _date: parseDate(e.date), _idx: i }))
    .filter(e => e._date >= weekStart && e._date < weekEnd)
    .sort((a, b) => (a._date - b._date) || (a._idx - b._idx));

  const lines = [`【实验课提醒 · ${selectedClass} · ${wk === null ? '—' : '第' + wk + '周'}】`];
  if (!list.length) {
    lines.push('本周没有实验安排');
  } else {
    list.forEach(e => {
      const wd = WEEK_NAMES[e._date.getDay()].replace('星期', '周');
      lines.push(`${e.date.slice(5)} ${wd} ${e.period} ${e.name} ${e.place}`);
      if (e.note) {
        lines.push('备注：' + e.note.replace(/\r\n?/g, '\n').replace(/\n/g, '\n      '));
      }
    });
  }
  return lines.join('\n');
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.left = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}

function showCopyFallback(text, title) {
  const heading = document.getElementById('copyTitle');
  if (heading) heading.textContent = title || '复制本周安排';
  copyFallbackText.value = text;
  rememberModalFocus(copyMask, copyWeekBtn);
  copyMask.classList.add('show');
  setTimeout(() => {
    try {
      copyFallbackText.focus();
      copyFallbackText.select();
      copyFallbackText.setSelectionRange(0, copyFallbackText.value.length);
    } catch (e) {}
  }, 0);
}

function closeCopyFallback() {
  copyMask.classList.remove('show');
  restoreModalFocus(copyMask);
}

async function copyWeekSchedule() {
  if (!selectedClass) {
    showStatus('warn', '当前没有班级，请先新建班级');
    return;
  }
  const text = buildWeekText();
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    } else {
      ok = fallbackCopyText(text);
    }
  } catch (e) {
    ok = fallbackCopyText(text);
  }
  if (ok) {
    showStatus('ok', `已复制 ${selectedClass} 本周安排`);
  } else {
    showCopyFallback(text);
    showStatus('warn', '复制失败，已打开手动复制窗口');
  }
}

copyWeekBtn.addEventListener('click', copyWeekSchedule);
copyFallbackSelect.addEventListener('click', () => {
  try {
    copyFallbackText.focus();
    copyFallbackText.select();
    copyFallbackText.setSelectionRange(0, copyFallbackText.value.length);
  } catch (e) {}
});
copyFallbackDone.addEventListener('click', closeCopyFallback);
copyFallbackClose.addEventListener('click', closeCopyFallback);
copyMask.addEventListener('click', ev => {
  if (ev.target === copyMask) closeCopyFallback();
});

function buildJsonBackup(list, scope) {
  return JSON.stringify({
    format: 'crsecue-class-backup',
    version: 1,
    class: selectedClass,
    week1: toDateStr(week1Start),
    updatedAt: DATA_UPDATED_AT || '',
    exportedAt: formatExportTime(new Date()),
    scope: scope || 'all',
    count: list.length,
    periodTimes: currentPeriodTimes(),
    experiments: list.map(e => ({
      date: e.date,
      period: e.period,
      name: e.name,
      place: e.place,
      note: e.note || ''
    }))
  }, null, 2);
}

function exportJsonBackup() {
  if (!selectedClass) {
    showStatus('warn', '当前没有班级，无法导出');
    return;
  }
  try {
    const scope = exportScopeFiltered.checked ? 'filtered' : 'all';
    const list = getExportExperiments();
    const text = buildJsonBackup(list, scope);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    // 文件名统一为「班级[-筛选]-用途-日期.json」，导入时靠 classIdFromFileName 剥回去
  const fileName = `${selectedClass}${scope === 'filtered' ? '-筛选' : ''}-数据-${toDateStr(new Date())}.json`;
    downloadBlob(blob, fileName);
    showStatus('ok', `已导出 ${selectedClass} 的 JSON（${scope === 'filtered' ? '当前筛选' : '全部'} ${list.length} 条）：${fileName}`);
  } catch (err) {
    showStatus('error', 'JSON 备份导出失败：' + (err && err.message ? err.message : String(err)));
  }
}

function closeExportChooser() {
  exportMask.classList.remove('show');
  restoreModalFocus(exportMask);
}

function openExportChooser() {
  exportScopeAll.checked = true;
  refreshExportScopeCounts();
  rememberModalFocus(exportMask, exportBtn);
  exportMask.classList.add('show');
  setTimeout(() => { try { exportXlsxChoice.focus(); } catch (e) {} }, 0);
}

exportXlsxChoice.addEventListener('click', () => {
  closeExportChooser();
  exportXlsx();
});

exportJsonChoice.addEventListener('click', () => {
  closeExportChooser();
  exportJsonBackup();
});

exportClose.addEventListener('click', closeExportChooser);
exportCancel.addEventListener('click', closeExportChooser);
exportMask.addEventListener('click', ev => {
  if (ev.target === exportMask) closeExportChooser();
});


searchInput.addEventListener('input', queueSearchInput);
searchInput.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    applySearchInput();
  }
});


let actionMenuOpen = false;

function setActionMenu(open) {
  actionMenuOpen = !!open;
  actionPanel.hidden = !actionMenuOpen;
  actionsToggle.setAttribute('aria-expanded', String(actionMenuOpen));
}

actionsToggle.addEventListener('click', () => {
  setActionMenu(!actionMenuOpen);
});

// 只播报、不弹可见状态栏：给"自动定位"这类无界面变化的动作补一句读屏提示
function announce(msg) {
  if (liveStatusEl && msg) liveStatusEl.textContent = msg;
}

// 状态栏在窄屏只有几行高度：名称/地点都能到 200 字，直接把整段塞进去会撑成大色块。
// 可见文字截到 80 字（完整内容放 title），读屏仍播报全文。
const STATUS_TEXT_LIMIT = 80;

function setStatusExpanded(expanded) {
  const span = statusEl.querySelector('.status-text');
  const toggle = statusEl.querySelector('.status-toggle');
  if (!span || statusEl.dataset.truncated !== '1') return;
  span.textContent = expanded ? statusEl.dataset.full : statusEl.dataset.short;
  statusEl.classList.toggle('is-expanded', expanded);
  if (toggle) {
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-expanded', String(expanded));
  }
}

// 整条状态栏都可以点（按钮自己处理点击），只在"确实被截断"时生效
statusEl.addEventListener('click', event => {
  if (event.target.closest('button')) return;
  if (statusEl.dataset.truncated !== '1') return;
  const toggle = statusEl.querySelector('.status-toggle');
  const expanded = toggle && toggle.getAttribute('aria-expanded') === 'true';
  setStatusExpanded(!expanded);
});

function showStatus(type, msg, action) {
  statusEl.className = 'import-status show ' + type;
  const text = String(msg == null ? '' : msg);
  const short = text.length > STATUS_TEXT_LIMIT
    ? text.slice(0, STATUS_TEXT_LIMIT - 1) + '…'
    : text;
  const truncated = short !== text;
  statusEl.textContent = '';
  statusEl.dataset.full = text;
  statusEl.dataset.short = short;
  statusEl.dataset.truncated = truncated ? '1' : '0';
  const span = document.createElement('span');
  span.className = 'status-text';
  span.id = 'statusText';
  span.textContent = short;
  statusEl.appendChild(span);
  if (truncated) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'status-toggle';
    toggle.setAttribute('aria-controls', 'statusText');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '展开';
    toggle.addEventListener('click', () => {
      setStatusExpanded(toggle.getAttribute('aria-expanded') !== 'true');
    });
    statusEl.appendChild(toggle);
  }
  statusEl.title = text;
  if (liveStatusEl) liveStatusEl.textContent = text;
  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-action';
    btn.textContent = action.label || '撤销';
    btn.addEventListener('click', action.onClick);
    statusEl.appendChild(btn);
  }
}


/* ============================================================
   8.1 时间冲突：顶部筛选 & 桌面悬停
   ============================================================ */
const conflictFilter = document.getElementById('conflictFilter');
const conflictFilterLabel = document.getElementById('conflictFilterLabel');
const conflictLegend = document.getElementById('conflictLegend');
const nextLegend = document.getElementById('nextLegend');

function syncConflictFilter(info) {
  const totalGroups = info.groups.length;
  conflictLegend.hidden = totalGroups === 0;

  if (!totalGroups) {
    conflictFilter.checked = false;
    conflictOnly = false;
    conflictFilter.disabled = true;
    conflictFilter.title = '当前班没有时间冲突';
    conflictFilterLabel.title = '当前班没有时间冲突';
    conflictFilterLabel.classList.add('is-disabled');
    return;
  }

  conflictFilter.disabled = false;
  conflictFilter.checked = conflictOnly;
  conflictFilter.title = '只显示参与时间冲突的实验';
  conflictFilterLabel.title = '只显示参与时间冲突的实验';
  conflictFilterLabel.classList.remove('is-disabled');
}

conflictFilter.addEventListener('change', () => {
  if (conflictFilter.disabled) return;
  conflictOnly = conflictFilter.checked;
  render();
});

// 桌面端：鼠标移到任一同组冲突行时，同组行的左侧色块一起加深。
const tableBodyEl = tbodyEl;
let hoverConflictId = null;

function conflictHoverEnabled() {
  return window.matchMedia('(min-width: 941px)').matches;
}

function setConflictHover(id, on) {
  if (id == null || id === '') return;
  tableBodyEl.querySelectorAll(`tr[data-conflict="${id}"]`).forEach(tr => {
    tr.classList.toggle('conflict-peer', on);
  });
}

tableBodyEl.addEventListener('pointerover', (e) => {
  if (!conflictHoverEnabled()) {
    setConflictHover(hoverConflictId, false);
    hoverConflictId = null;
    return;
  }
  if (e.pointerType && e.pointerType !== 'mouse') return;
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return;
  const tr = target.closest('tr[data-conflict]');
  const id = tr ? tr.dataset.conflict : null;
  if (id === hoverConflictId) return;
  setConflictHover(hoverConflictId, false);
  hoverConflictId = id;
  setConflictHover(id, true);
});
tableBodyEl.addEventListener('pointerleave', () => {
  setConflictHover(hoverConflictId, false);
  hoverConflictId = null;
});
window.addEventListener('resize', () => {
  if (conflictHoverEnabled()) return;
  setConflictHover(hoverConflictId, false);
  hoverConflictId = null;
});


/* ============================================================
   9. 顶部时间
   ============================================================ */
function updateClock() {
  const now = new Date();
  const wkNow = weekNoOf(now);
  const frag = document.createDocumentFragment();

  // 格式：现在：2026-11-14 第 11 周 星期六 19:24（24 小时制）
  frag.appendChild(document.createTextNode('现在：'));
  const b = document.createElement('b');
  b.textContent = toDateStr(now);
  frag.appendChild(b);
  frag.appendChild(document.createTextNode(wkNow ? ` 第 ${wkNow} 周` : ' 学期未开始'));
  frag.appendChild(document.createTextNode(` ${WEEK_NAMES[now.getDay()]} `));

  const clockTime = document.createElement('span');
  clockTime.className = 'clock-time';
  clockTime.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  frag.appendChild(clockTime);

  if (usingSaved) {
    frag.appendChild(document.createTextNode(' · '));
    const span = document.createElement('span');
    span.className = 'saved-tip';
    span.textContent = '已加载本机保存的数据';
    frag.appendChild(span);
  }

  clockEl.replaceChildren(frag);
}


/* ============================================================
   10. 第 1 周星期一
   ============================================================ */
week1Input.value = toDateStr(week1Start);

recentFilter.addEventListener('change', () => {
  recentOnly = recentFilter.checked;
  render();
  // 只看筛选结果，不做自动定位：用户刚手动改了筛选，
  // 页面再自己跳走会让人失去位置感（勾选/取消都保持当前滚动位置）。
});

week1Input.addEventListener('change', () => {
  if (!selectedClass) {
    week1Input.value = toDateStr(week1Start);
    showStatus('warn', '当前没有班级，请先新建班级');
    return;
  }
  const v = week1Input.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    week1Input.value = toDateStr(week1Start);
    showStatus('error', '第 1 周起始日期无效，已保持原设置');
    return;
  }
  const d = parseDate(v);
  if (isNaN(d.getTime())) {
    week1Input.value = toDateStr(week1Start);
    showStatus('error', '第 1 周起始日期无效，已保持原设置');
    return;
  }
  if (d.getDay() !== 1) {
    week1Input.value = toDateStr(week1Start);
    showStatus('error', `${v} 是${WEEK_NAMES[d.getDay()]}，不是星期一；第 1 周星期一必须选周一`);
    return;
  }

  week1Start = d;
  const savedOk = saveWeek1Start();

  render();
  updateClock();

  showStatus(
    savedOk ? 'ok' : 'warn',
    savedOk
      ? `第 1 周星期一已更新为 ${v}，已保存到本班 ${selectedClass}`
      : `第 1 周星期一已更新为 ${v}，但本地保存失败（刷新后会恢复默认）`
  );
});

classSelect.addEventListener('change', () => {
  if (firstRunEl) firstRunEl.hidden = true;
  switchClass(classSelect.value);
});

newClassBtn.addEventListener('click', () => openClassPrompt('new'));
renameClassBtn.addEventListener('click', () => {
  if (isBuiltClass(selectedClass) && !isLocalClass(selectedClass)) {
    askConfirm({
      title: '重命名内置班级',
      message: `确定在本机重命名内置班级 ${selectedClass}？`,
      detail: '会隐藏原班并把实验/week1 复制到新本机班；部署数据不变，操作可撤销。',
      okText: '继续重命名'
    }).then(ok => {
      if (ok) openClassPrompt('rename');
    });
    return;
  }
  openClassPrompt('rename');
});
deleteClassBtn.addEventListener('click', deleteCurrentClass);
classPromptClose.addEventListener('click', closeClassPrompt);
classPromptCancel.addEventListener('click', closeClassPrompt);
classPromptOk.addEventListener('click', submitClassPrompt);
classPromptInput.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    submitClassPrompt();
  }
});
classMask.addEventListener('click', ev => {
  if (ev.target === classMask) closeClassPrompt();
});


/* ============================================================
   11. 添加实验（模态框）
   ============================================================ */
const modalMask   = document.getElementById('modalMask');
const modalClose  = document.getElementById('modalClose');
const modalCancel = document.getElementById('modalCancel');
const modalSubmit = document.getElementById('modalSubmit');
const modalDelete = document.getElementById('modalDelete');
const modalTitle  = document.getElementById('modalTitle');
const editA11ySummary = document.getElementById('editA11ySummary');
const modalDialog = modalMask.querySelector('.modal');
let editingIndex = null;
const formDate    = document.getElementById('formDate');
const formWeek    = document.getElementById('formWeek');
const formWeekday = document.getElementById('formWeekday');
const formPeriod  = document.getElementById('formPeriod');
const formName    = document.getElementById('formName');
const formPlace   = document.getElementById('formPlace');
const formNote    = document.getElementById('formNote');
const formError   = document.getElementById('formError');
const formConflict = document.getElementById('formConflict');

function currentDateMode() {
  const el = document.querySelector('input[name="dateMode"]:checked');
  return el ? el.value : 'week';
}

// 周次 + 星期 → 日期
function updateDateFromWeek() {
  const w = parseInt(formWeek.value, 10);
  const wd = parseInt(formWeekday.value, 10);
  if (Number.isInteger(w) && w >= 1 && w <= MAX_WEEK && Number.isInteger(wd) && wd >= 1 && wd <= 7) {
    formDate.value = toDateStr(dateFromWeekWeekday(w, wd));
  } else {
    formDate.value = '';
  }
}

// 日期 → 周次 + 星期
function updateWeekFromDate() {
  const v = formDate.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    formWeek.value = '';
    return;
  }
  const d = parseDate(v);
  if (isNaN(d.getTime())) {
    formWeek.value = '';
    return;
  }
  formWeekday.value = String(d.getDay() === 0 ? 7 : d.getDay());
  const w = weekNoOf(d);
  formWeek.value = (w === null) ? '' : String(w);
}

// 选中的一侧可编辑，另一侧禁用但保持同步
function syncDateModeUI() {
  const dateActive = currentDateMode() === 'date';
  formDate.disabled = !dateActive;
  formWeek.disabled = dateActive;
  formWeekday.disabled = dateActive;
}

function getFormConflictMatches() {
  let dateStr = '';
  if (currentDateMode() === 'date') {
    const v = formDate.value;
    if (isValidDateStr(v)) dateStr = v;
  } else {
    const w = parseInt(formWeek.value, 10);
    const wd = parseInt(formWeekday.value, 10);
    if (Number.isInteger(w) && w >= 1 && w <= MAX_WEEK && Number.isInteger(wd) && wd >= 1 && wd <= 7) {
      dateStr = toDateStr(dateFromWeekWeekday(w, wd));
    }
  }
  if (!dateStr) return [];

  const ranges = parsePeriodRanges(formPeriod.value);
  const key = ranges ? null : normKeyText(formPeriod.value);
  if (!ranges && !key) return [];

  const out = [];
  experiments.forEach((e, i) => {
    if (i === editingIndex) return;
    if (e.date !== dateStr) return;
    const other = parsePeriodRanges(e.period);
    let hit = false;
    if (ranges && other) hit = periodRangesOverlap(ranges, other);
    else if (!ranges && !other) hit = key === normKeyText(e.period);
    if (hit) out.push(e);
  });
  return out;
}

function updateFormConflictHint() {
  const matches = getFormConflictMatches();
  if (!matches.length) {
    formConflict.hidden = true;
    formConflict.textContent = '';
    return;
  }

  const brief = matches.slice(0, 2)
    .map(e => `${e.period} ${e.name}（${e.place}）`)
    .join('；');
  const more = matches.length > 2 ? `等 ${matches.length} 条` : '';
  formConflict.textContent =
    `时间冲突：与已有 ${matches.length} 条实验重叠 —— ${brief}${more}。仍可保存。`;
  formConflict.hidden = false;
}

document.querySelectorAll('input[name="dateMode"]').forEach(el => {
  el.addEventListener('change', () => {
    syncDateModeUI();
    if (currentDateMode() === 'date') updateWeekFromDate();
    else updateDateFromWeek();
    showFormError('');
    updateFormConflictHint();
  });
});

formWeek.addEventListener('input', () => {
  if (currentDateMode() !== 'week') return;
  updateDateFromWeek();
  updateFormConflictHint();
});
formWeekday.addEventListener('change', () => {
  if (currentDateMode() !== 'week') return;
  updateDateFromWeek();
  updateFormConflictHint();
});
formDate.addEventListener('input', () => {
  if (currentDateMode() !== 'date') return;
  updateWeekFromDate();
  updateFormConflictHint();
});
formDate.addEventListener('change', () => {
  if (currentDateMode() !== 'date') return;
  updateWeekFromDate();
  updateFormConflictHint();
});
formPeriod.addEventListener('input', updateFormConflictHint);

function showFormError(msg) {
  if (!msg) {
    formError.className = 'form-error';
    formError.textContent = '';
    return;
  }
  formError.className = 'form-error show';
  formError.textContent = msg;
}

/* 表单错误要绑到具体字段：读屏用户回到输入框时还能听到"错在哪"，
   而不是只在提交那一刻被 live region 播报一次。 */
const FORM_FIELDS = [formDate, formWeek, formWeekday, formPeriod, formName, formPlace, formNote];

function clearFieldErrors() {
  FORM_FIELDS.forEach(field => {
    if (!field) return;
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  });
}

function markFieldErrors(fields) {
  clearFieldErrors();
  fields.forEach(field => {
    if (!field) return;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', 'formError');
  });
  if (fields[0]) {
    try { fields[0].focus(); } catch (e) {}
  }
}

// 用户动手改某个字段就先把它的错误标记清掉，不用等下次提交
FORM_FIELDS.forEach(field => {
  if (!field) return;
  const clear = () => {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  };
  field.addEventListener('input', clear);
  field.addEventListener('change', clear);
});

function resetForm() {
  const today = startOfDay(new Date());
  const currentWeek = weekNoOf(today);
  const weekday = today.getDay() === 0 ? 7 : today.getDay();

  // 默认按「周次 + 星期」填写，并预填当前周和今天对应的星期
  document.querySelector('input[name="dateMode"][value="week"]').checked = true;
  formWeek.value = String(currentWeek === null ? 1 : currentWeek);
  formWeekday.value = String(weekday);
  updateDateFromWeek();

  formPeriod.value = '';
  formName.value = '';
  formPlace.value = '';
  formNote.value = '';
  syncDateModeUI();
  showFormError('');
  clearFieldErrors();
  updateFormConflictHint();
}

// 已有名称/地点做输入联想：同一个东西写成两种写法，搜索就命不中
function refreshPlaceSuggestions() {
  const placeList = document.getElementById('placeList');
  const nameList = document.getElementById('nameList');
  const places = new Map();
  const names = new Map();
  const collect = items => {
    (items || []).forEach(item => {
      if (!item) return;
      const place = String(item.place || '').trim();
      if (place && place !== '待定') {
        const key = place.toLowerCase();
        if (!places.has(key)) places.set(key, place);
      }
      const name = String(item.name || '').trim();
      if (name) {
        const nameKey = name.toLowerCase();
        if (!names.has(nameKey)) names.set(nameKey, name);
      }
    });
  };
  classIds.forEach(id => {
    collect(id === selectedClass ? experiments : (readClassStored(id) || getDefaultClassExperiments(id)));
  });
  const fill = (list, map) => {
    if (!list) return;
    const values = Array.from(map.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    list.replaceChildren(...values.slice(0, 100).map(value => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }));
  };
  fill(placeList, places);
  fill(nameList, names);
  // 自绘下拉用的候选（iOS 不渲染 datalist）
  suggestionData = {
    names: Array.from(names.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    places: Array.from(places.values()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  };
}

/* ---------- iOS 兜底：Safari 不渲染 <datalist>，自己画一个建议列表 ---------- */
let suggestionData = { names: [], places: [] };
const NEEDS_JS_SUGGEST = /iP(hone|ad|pod)/i.test(navigator.userAgent)
  || !('list' in HTMLInputElement.prototype);

function attachSuggest(input, getValues) {
  if (!input || !input.parentElement) return;
  const box = document.createElement('div');
  box.className = 'suggest-box';
  box.hidden = true;
  input.parentElement.appendChild(box);
  const close = () => { box.hidden = true; };
  const pick = value => {
    input.value = value;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const render = () => {
    const query = input.value.trim().toLowerCase();
    const values = getValues()
      .filter(value => !query || value.toLowerCase().includes(query))
      .slice(0, 8);
    if (!values.length) { close(); return; }
    box.replaceChildren(...values.map(value => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'suggest-item';
      item.textContent = value;
      // mousedown 而不是 click：避免 blur 先把列表关掉
      item.addEventListener('mousedown', event => { event.preventDefault(); pick(value); });
      return item;
    }));
    box.hidden = false;
  };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => window.setTimeout(close, 150));
  input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
}

if (NEEDS_JS_SUGGEST) {
  [['formName', 'names'], ['formPlace', 'places']].forEach(([id, key]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.removeAttribute('list');
    attachSuggest(input, () => suggestionData[key] || []);
  });
}

function openModal(prefill) {
  editingIndex = null;
  resetForm();
  refreshPlaceSuggestions();
  // 课表里点空格：按日期模式预填该天与节次，直接输入名称即可
  const prefilled = !!(prefill && prefill.date);
  if (prefilled) {
    document.querySelector('input[name="dateMode"][value="date"]').checked = true;
    formDate.value = prefill.date;
    if (prefill.period) formPeriod.value = prefill.period;
    syncDateModeUI();
    updateFormConflictHint();
  }
  modalTitle.textContent = '添加实验';
  modalSubmit.textContent = '确认添加';
  editA11ySummary.textContent = '';
  if (modalDelete) modalDelete.hidden = true;
  modalDialog.removeAttribute('aria-describedby');
  rememberModalFocus(modalMask, addBtn);
  modalMask.classList.add('show');
  // 打开后聚焦：预填过就跳名称，否则聚焦当前可编辑的那一侧
  setTimeout(() => {
    try {
      const target = prefilled ? formName : (currentDateMode() === 'week' ? formWeek : formDate);
      target.focus();
    } catch (e) {}
  }, 0);
}

function openEditModal(idx, opener) {
  const item = experiments[idx];
  if (!item) return;

  resetForm();
  refreshPlaceSuggestions();
  editingIndex = idx;
  modalTitle.textContent = '编辑实验';
  modalSubmit.textContent = '保存修改';
  if (modalDelete) modalDelete.hidden = false;
  editA11ySummary.textContent = experimentA11ySummary(item);
  modalDialog.setAttribute('aria-describedby', 'editA11ySummary');

  const d = parseDate(item.date);
  const w = weekNoOf(d);
  if (!isNaN(d.getTime()) && w !== null) {
    // 编辑默认周次+星期模式；日期自动同步
    document.querySelector('input[name="dateMode"][value="week"]').checked = true;
    formWeek.value = String(w);
    formWeekday.value = String(d.getDay() === 0 ? 7 : d.getDay());
    updateDateFromWeek();
  } else {
    document.querySelector('input[name="dateMode"][value="date"]').checked = true;
    formDate.value = item.date;
    updateWeekFromDate();
  }

  formPeriod.value = item.period;
  formName.value = item.name;
  formPlace.value = item.place;
  formNote.value = item.note || '';
  syncDateModeUI();
  showFormError('');
  updateFormConflictHint();
  rememberModalFocus(modalMask, opener || editModeBtn);

  modalMask.classList.add('show');
  setTimeout(() => {
    try { (currentDateMode() === 'week' ? formWeek : formDate).focus(); } catch (e) {}
  }, 0);
}

function closeModal() {
  modalMask.classList.remove('show');
  restoreModalFocus(modalMask);
  editingIndex = null;
  modalTitle.textContent = '添加实验';
  modalSubmit.textContent = '确认添加';
  if (modalDelete) modalDelete.hidden = true;
  formConflict.hidden = true;
  formConflict.textContent = '';
}

addBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);

// 编辑弹窗里直接删除（可撤销）
if (modalDelete) {
  modalDelete.addEventListener('click', async () => {
    const idx = editingIndex;
    const target = idx === null ? null : experiments[idx];
    if (!target) return;
    const ok = await askConfirm({
      title: '删除这条实验？',
      message: `${target.date} ${target.period} ${target.name}`,
      detail: '删除后可以用状态栏的「撤销」恢复。',
      okText: '删除'
    });
    if (!ok) return;
    deleteExperimentAt(idx);
  });
}

// 点击遮罩空白处关闭
modalMask.addEventListener('click', (e) => {
  if (e.target === modalMask) closeModal();
});

// 提交
modalSubmit.addEventListener('click', () => {
  const errs = [];
  const invalidFields = [];
  const markInvalid = field => {
    if (field && invalidFields.indexOf(field) < 0) invalidFields.push(field);
  };
  const mode = currentDateMode();

  let dt = null;
  if (mode === 'date') {
    const v = formDate.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errs.push('请选择有效日期');
      markInvalid(formDate);
    } else {
      const d = parseDate(v);
      if (isNaN(d.getTime())) { errs.push('日期无效'); markInvalid(formDate); }
      else dt = d;
    }
  } else {
    const w = parseInt(formWeek.value, 10);
    const wd = parseInt(formWeekday.value, 10);
    if (!Number.isInteger(w) || w < 1 || w > MAX_WEEK) {
      errs.push('周次必须是 1-' + MAX_WEEK + ' 的整数');
      markInvalid(formWeek);
    } else if (!(wd >= 1 && wd <= 7)) {
      errs.push('请选择星期');
      markInvalid(formWeekday);
    } else {
      dt = dateFromWeekWeekday(w, wd);
    }
  }

  const rawPeriod = formPeriod.value.trim();
  if (!rawPeriod) { errs.push('请填写节次'); markInvalid(formPeriod); }
  else if (rawPeriod.length > MAX_PERIOD_LEN) { errs.push('节次不能超过 ' + MAX_PERIOD_LEN + ' 个字符'); markInvalid(formPeriod); }
  const period = cleanText(rawPeriod, MAX_PERIOD_LEN);
  if (rawPeriod && !period) { errs.push('节次包含无效字符'); markInvalid(formPeriod); }

  const rawName = formName.value.trim();
  if (!rawName) { errs.push('请填写实验名称'); markInvalid(formName); }
  else if (rawName.length > MAX_NAME_LEN) { errs.push('实验名称不能超过 ' + MAX_NAME_LEN + ' 个字符'); markInvalid(formName); }
  const name = cleanText(rawName, MAX_NAME_LEN);
  if (rawName && !name) { errs.push('实验名称包含无效字符'); markInvalid(formName); }

  const rawPlace = formPlace.value.trim();
  if (rawPlace.length > MAX_PLACE_LEN) { errs.push('实验地点不能超过 ' + MAX_PLACE_LEN + ' 个字符'); markInvalid(formPlace); }
  const place = cleanText(rawPlace, MAX_PLACE_LEN) || '待定';

  const rawNote = formNote.value.trim();
  if (rawNote.length > MAX_NOTE_LEN) { errs.push('备注不能超过 ' + MAX_NOTE_LEN + ' 个字符'); markInvalid(formNote); }
  const note = cleanNote(rawNote);

  if (errs.length) {
    markFieldErrors(invalidFields);
    showFormError(errs.join('；'));
    return;
  }
  clearFieldErrors();

  const isEditing = editingIndex !== null;
  const editIdx = editingIndex;
  const item = { date: toDateStr(dt), period, name, place, note };
  const where = `${toDateStr(dt)} ${period} · ${name}（${place}）`;
  let savedOk = false;

  if (isEditing) {
    const before = experiments[editIdx] ? { ...experiments[editIdx] } : null;
    if (!before) {
      showFormError('这条实验已不存在，请关闭后重试');
      return;
    }

    experiments[editIdx] = item;
    lastEditedByClass.set(selectedClass, { index: editIdx, before });
    lastDeletedByClass.delete(selectedClass);

    savedOk = saveExperiments();
    if (savedOk) usingSaved = true;

    render();
    updateClock();
    closeModal();
    showStatus(
      savedOk ? 'ok' : 'warn',
      `已更新实验：${where}` +
        (savedOk ? '' : '；本地保存失败（刷新后会恢复）'),
      { label: '撤销', onClick: undoLastEdit }
    );
  } else {
    experiments.push(item);
    lastEditedByClass.delete(selectedClass);

    savedOk = saveExperiments();
    if (savedOk) usingSaved = true;

    render();
    updateClock();
    closeModal();
    showStatus(
      savedOk ? 'ok' : 'warn',
      savedOk
        ? `已添加实验：${where}，已自动保存`
        : `已添加实验：${where}，但本地保存失败（刷新后会恢复）`
    );
  }
});


/* ============================================================
   12. 通用确认框
   ============================================================ */
const confirmMask   = document.getElementById('confirmMask');
const confirmTitle  = document.getElementById('confirmTitle');
const confirmMsg    = document.getElementById('confirmMsg');
const confirmDetail = document.getElementById('confirmDetail');
const confirmOk     = document.getElementById('confirmOk');
const confirmCancel = document.getElementById('confirmCancel');

let confirmResolve = null;

function askConfirm(opts) {
  const o = opts || {};
  return new Promise(resolve => {
    if (confirmResolve) { const prev = confirmResolve; confirmResolve = null; prev(false); }
    confirmResolve = resolve;

    confirmTitle.textContent = o.title || '请确认';
    confirmMsg.textContent = o.message || '';
    if (o.detail) {
      confirmDetail.textContent = o.detail;
      confirmDetail.hidden = false;
    } else {
      confirmDetail.textContent = '';
      confirmDetail.hidden = true;
    }
    confirmOk.textContent = o.okText || '确定';
    confirmOk.className = 'danger-btn';
    rememberModalFocus(confirmMask, null);
    confirmMask.classList.add('show');

    setTimeout(() => { try { confirmOk.focus(); } catch (e) {} }, 0);
  });
}

function settleConfirm(val) {
  confirmMask.classList.remove('show');
  restoreModalFocus(confirmMask);
  const fn = confirmResolve;
  confirmResolve = null;
  if (fn) fn(val);
}

confirmOk.addEventListener('click', () => settleConfirm(true));
confirmCancel.addEventListener('click', () => settleConfirm(false));
confirmMask.addEventListener('click', (e) => {
  if (e.target === confirmMask) settleConfirm(false);
});


/* ============================================================
   13. 删除实验（批量标记模式）
   ============================================================ */
const lastDeletedByClass = new Map(); // 当前页面会话内，按班保留最近一次删除批次
const lastEditedByClass = new Map();  // 当前页面会话内，按班保留最近一次编辑

function beginModeFilter() {
  if (!filterStateSaved) {
    filterBeforeMode = recentFilter.checked;
    filterStateSaved = true;
  }
  if (!conflictFilterStateSaved) {
    conflictBeforeMode = conflictOnly;
    conflictFilterStateSaved = true;
  }
  recentOnly = false;
  recentFilter.checked = false;
  recentFilter.disabled = false;
  conflictOnly = false;
  conflictFilter.checked = false;
}

function endModeFilter() {
  if (!filterStateSaved && !conflictFilterStateSaved) return;
  if (filterStateSaved) {
    filterStateSaved = false;
    recentFilter.disabled = false;
    recentFilter.checked = filterBeforeMode;
    recentOnly = filterBeforeMode;
  }
  if (conflictFilterStateSaved) {
    conflictFilterStateSaved = false;
    conflictOnly = conflictBeforeMode;
    conflictFilter.checked = conflictOnly;
  }
}

function syncHeaderActions() {
  const anyMode = deleteMode || editMode;
  const noClass = !selectedClass;
  addBtn.disabled = anyMode || noClass;
  importBtn.disabled = anyMode;
  exportBtn.disabled = anyMode || noClass;
  copyWeekBtn.disabled = noClass;
  classSelect.disabled = anyMode || !classIds.length;
  week1Input.disabled = anyMode || noClass;
  deleteModeBtn.disabled = editMode;
  editModeBtn.disabled = deleteMode;
  syncClassTools();
}

function setDeleteModeUI(on) {
  deleteMode = on;
  if (on) beginModeFilter();
  else endModeFilter();
  if (!on) markedIndices.clear();

  document.body.classList.toggle('deleting', on);
  deleteModeBtn.textContent = on ? '完成' : '删除实验';
  deleteModeBtn.classList.toggle('active', on);
  deleteModeBtn.setAttribute('aria-pressed', String(on));
  deleteModeBtn.title = on
    ? '完成删除：删除所有已标记的实验'
    : '进入删除模式：点行首圆圈标记，再点完成统一删除';

  syncClassSelect();
  syncHeaderActions();
}

function enterDeleteMode() {
  if (editMode) return;
  if (!experiments.length) {
    showStatus('warn', `${selectedClass} 当前没有实验可删除`);
    return;
  }

  setDeleteModeUI(true);
  render();
}

function setEditModeUI(on) {
  editMode = on;
  if (on) {
    beginModeFilter();
  } else {
    endModeFilter();
  }

  document.body.classList.toggle('editing', on);
  editModeBtn.textContent = on ? '完成' : '编辑实验';
  editModeBtn.classList.toggle('active', on);
  editModeBtn.setAttribute('aria-pressed', String(on));
  editModeBtn.title = on
    ? '完成编辑：退出编辑模式'
    : '进入编辑模式：点行首铅笔修改实验';

  if (!on) {
    editingIndex = null;
    if (modalMask && modalMask.classList.contains('show')) closeModal();
  }

  syncClassSelect();
  syncHeaderActions();
}

function enterEditMode() {
  if (deleteMode) return;
  if (!experiments.length) {
    showStatus('warn', `${selectedClass} 当前没有实验可编辑`);
    return;
  }

  setEditModeUI(true);
  render();
}

function exitEditMode() {
  if (!editMode) return;
  setEditModeUI(false);
  render();
}

function finishDeleteMode() {
  // 先记下待删除的行（按下标升序），再退出删除模式
  const picked = Array.from(markedIndices)
    .sort((a, b) => a - b)
    .map(i => ({ index: i, item: experiments[i] ? { ...experiments[i] } : null }))
    .filter(x => x.item);

  setDeleteModeUI(false);

  if (!picked.length) {
    render();
    return;
  }

  // 从后往前删，保证前面的下标仍然有效
  for (let k = picked.length - 1; k >= 0; k--) {
    experiments.splice(picked[k].index, 1);
  }

  const names = picked.slice(0, 3).map(x => `${x.item.date} ${x.item.name}`).join('、');
  const detail = picked.length > 3 ? `${names} 等 ${picked.length} 条` : names;
  const savedOk = saveExperiments();
  const message =
    `已删除 ${picked.length} 条实验：${detail}` +
    (savedOk ? '' : '；本地保存失败，刷新后会恢复');

  lastDeletedByClass.set(selectedClass, { items: picked, message });
  lastEditedByClass.delete(selectedClass);

  render();
  updateClock();

  showStatus(
    savedOk ? 'ok' : 'warn',
    message,
    { label: '撤销', onClick: undoLastDelete }
  );
}

// 课表里点块标记/取消标记（删除模式），标记集合与列表共用 markedIndices
function toggleWeekMark(idx) {
  if (!experiments[idx]) return;
  if (markedIndices.has(idx)) markedIndices.delete(idx);
  else markedIndices.add(idx);
  renderWeekView();
  deleteModeBtn.textContent = markedIndices.size ? `完成（${markedIndices.size}）` : '完成';
}

// 单条删除：给编辑弹窗里的「删除实验」用，撤销沿用 lastDeletedByClass
function deleteExperimentAt(idx) {
  const target = experiments[idx];
  if (!target) return;

  const snapshot = { index: idx, item: { ...target } };
  experiments.splice(idx, 1);
  const savedOk = saveExperiments();
  if (savedOk) usingSaved = true;

  lastDeletedByClass.set(selectedClass, { items: [snapshot], message: '' });
  lastEditedByClass.delete(selectedClass);

  closeModal();
  render();
  updateClock();
  showStatus(
    savedOk ? 'ok' : 'warn',
    `已删除：${snapshot.item.date} ${snapshot.item.name}` + (savedOk ? '' : '；本地保存失败，刷新后会恢复'),
    { label: '撤销', onClick: undoLastDelete }
  );
}

function undoLastDelete() {
  const batch = lastDeletedByClass.get(selectedClass);
  if (!batch || !batch.items.length) return;
  lastDeletedByClass.delete(selectedClass);

  // 按原下标从小到大插回，位置与删除前一致
  batch.items.slice().sort((a, b) => a.index - b.index).forEach(entry => {
    const at = Math.min(Math.max(entry.index, 0), experiments.length);
    experiments.splice(at, 0, { ...entry.item });
  });

  const savedOk = saveExperiments();
  if (savedOk) usingSaved = true;

  render();
  updateClock();

  showStatus(
    savedOk ? 'ok' : 'warn',
    `已恢复 ${batch.items.length} 条实验` + (savedOk ? '' : '；本地保存失败')
  );
}

function undoLastEdit() {
  const batch = lastEditedByClass.get(selectedClass);
  if (!batch) return;
  lastEditedByClass.delete(selectedClass);

  if (batch.index >= 0 && batch.index < experiments.length) {
    experiments[batch.index] = { ...batch.before };
  }

  const savedOk = saveExperiments();
  if (savedOk) usingSaved = true;

  render();
  updateClock();

  showStatus(
    savedOk ? 'ok' : 'warn',
    '已撤销编辑' + (savedOk ? '' : '；本地保存失败')
  );
}

function undoLastImport() {
  const snapshot = lastImportUndo;
  if (!snapshot) return;
  if (editMode || deleteMode) {
    showStatus('warn', '请先完成编辑/删除模式，再撤销导入');
    return;
  }
  lastImportUndo = null;

  const { targetId, targetNew, beforeList, beforeWeek1Raw, previousSelected } = snapshot;
  let savedOk = true;

  if (targetNew) {
    removeExtraClass(targetId);
    removeClassStored(targetId);
    try { localStorage.removeItem(classWeek1Key(targetId)); } catch (e) {}
  } else {
    savedOk = saveClassStored(targetId, beforeList);
    try {
      if (beforeWeek1Raw == null) localStorage.removeItem(classWeek1Key(targetId));
      else localStorage.setItem(classWeek1Key(targetId), beforeWeek1Raw);
    } catch (e) {
      savedOk = false;
    }
  }

  const desired = classIds.includes(previousSelected)
    ? previousSelected
    : (classIds.includes(targetId) ? targetId : classIds[0]);

  if (desired && selectedClass !== desired) {
    switchClass(desired);
  } else if (desired) {
    setCurrentClassData(desired);
    week1Start = readClassWeek1(desired);
    if (week1Input) week1Input.value = toDateStr(week1Start);
    syncClassSelect();
    syncHeaderActions();
    syncUrlClass();
    render();
    updateClock();
  } else {
    selectedClass = '';
    saveSelectedClass();
    experiments = [];
    usingSaved = false;
    week1Start = new Date(WEEK1_DEFAULT.getFullYear(), WEEK1_DEFAULT.getMonth(), WEEK1_DEFAULT.getDate());
    if (week1Input) week1Input.value = toDateStr(week1Start);
    clearSearchState(false);
    syncClassSelect();
    syncHeaderActions();
    syncUrlClass();
    render();
    updateClock();
  }

  const count = beforeList.length;
  const message = targetNew
    ? `已撤销导入，并删除本机新建班级 ${targetId}`
    : `已撤销导入，${targetId} 已恢复到导入前的 ${count} 条实验`;
  showStatus(savedOk ? 'ok' : 'warn', message + (savedOk ? '' : '；本地保存失败'));
}

function showUndoForCurrentClass() {
  const batch = lastDeletedByClass.get(selectedClass);
  if (batch) {
    showStatus('ok', batch.message, { label: '撤销', onClick: undoLastDelete });
    return;
  }
  if (statusEl && statusEl.classList.contains('show')) {
    statusEl.className = 'import-status';
    statusEl.textContent = '';
  }
}

deleteModeBtn.addEventListener('click', () => {
  if (editMode) return;
  if (deleteMode) finishDeleteMode();
  else enterDeleteMode();
});

editModeBtn.addEventListener('click', () => {
  if (deleteMode) return;
  if (editMode) exitEditMode();
  else enterEditMode();
});

// 删除模式点左侧圆圈；编辑模式点左侧铅笔
document.getElementById('tbody').addEventListener('click', (ev) => {
  const target = ev.target;
  if (editMode) {
    const editBtn = target && target.closest ? target.closest('button[data-action="edit"]') : null;
    if (!editBtn) return;
    openEditModal(Number(editBtn.dataset.idx));
    return;
  }
  if (!deleteMode) return;

  const btn = target && target.closest ? target.closest('button[data-action="mark"]') : null;
  if (!btn) return;

  const idx = Number(btn.dataset.idx);
  if (!experiments[idx]) return;

  if (markedIndices.has(idx)) markedIndices.delete(idx);
  else markedIndices.add(idx);

  const marked = markedIndices.has(idx);
  btn.classList.toggle('is-marked', marked);
  btn.setAttribute('aria-pressed', String(marked));
  btn.title = marked ? '取消删除标记' : '标记为待删除';
  btn.setAttribute('aria-label', `${btn.title}：${experimentA11ySummary(experiments[idx])}`);

  const row = btn.closest('tr');
  if (row) row.classList.toggle('row-marked', marked);
});

// roving tabindex：整张表只保留 1 个 Tab 停靠点（当前行），其余行 -1。
// 否则 25 条实验就要按 25 次 Tab 才能穿过表格，键盘用户代价过高。
let activeRowIndex = 0;

function syncRowFocusability() {
  const rows = Array.from(tableBodyEl.querySelectorAll('tr:not(.note-row)'));
  if (!rows.length) { activeRowIndex = 0; return; }
  if (activeRowIndex >= rows.length) activeRowIndex = rows.length - 1;
  if (activeRowIndex < 0) activeRowIndex = 0;
  rows.forEach((row, i) => { row.tabIndex = i === activeRowIndex ? 0 : -1; });
}

tableBodyEl.addEventListener('focusin', ev => {
  const target = ev.target;
  const row = target && target.closest ? target.closest('tr') : null;
  if (!row || row.classList.contains('note-row')) return;
  const rows = Array.from(tableBodyEl.querySelectorAll('tr:not(.note-row)'));
  const index = rows.indexOf(row);
  if (index < 0 || index === activeRowIndex) return;
  activeRowIndex = index;
  syncRowFocusability();
});

// 表格聚焦后，用上下方向键逐条读取实验；Tab 只停靠一次（roving tabindex）。
scheduleTableEl.addEventListener('keydown', ev => {
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

  const rows = Array.from(tableBodyEl.querySelectorAll('tr:not(.note-row)'));
  if (!rows.length) return;

  const active = document.activeElement;
  const currentRow = active && active.closest ? active.closest('tr') : null;

  if (ev.shiftKey) return;
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Escape') return;

  if (ev.key === 'Escape') {
    if (currentRow) {
      ev.preventDefault();
      scheduleTableEl.focus();
    }
    return;
  }

  ev.preventDefault();
  let idx = currentRow ? rows.indexOf(currentRow) : -1;
  if (idx < 0) idx = ev.key === 'ArrowDown' ? 0 : rows.length - 1;
  else idx += ev.key === 'ArrowDown' ? 1 : -1;
  idx = Math.max(0, Math.min(rows.length - 1, idx));
  rows[idx].focus({ preventScroll: true });
  // 和提示条跳转、冷启动共用一套最小滚动：吸顶表头算安全区，不再依赖 scroll-margin-top
  ensureElementVisible(rows[idx], false);
});


/* ============================================================
   14. 导入 Excel（替换 / 叠加）
   ============================================================ */
const importMask       = document.getElementById('importMask');
const importClose      = document.getElementById('importClose');
const importCancelBtn  = document.getElementById('importCancel');
const importConfirmBtn = document.getElementById('importConfirm');
const importSummary    = document.getElementById('importSummary');
const importConflict   = document.getElementById('importConflict');
const importScopeWarning = document.getElementById('importScopeWarning');
const mergeDesc        = document.getElementById('mergeDesc');
const replaceDesc      = document.getElementById('replaceDesc');
const importNote       = document.getElementById('importNote');
const conflictBox      = document.getElementById('conflictBox');
const conflictCountEl  = document.getElementById('conflictCount');
const conflictSelect   = document.getElementById('conflictSelect');
const importTargetBox  = document.getElementById('importTargetBox');
const importCurrentClass = document.getElementById('importCurrentClass');
const importFileTitle  = document.getElementById('importFileTitle');
const importFileDesc   = document.getElementById('importFileDesc');

const IMPORT_NOTE_MERGE =
  '叠加：同名同时间即同一条，默认跳过。';
const IMPORT_NOTE_REPLACE =
  '替换会清空目标班当前表格中的全部实验，只保留本次导入的数据，操作后无法撤销。';

let pendingImport = null;

function classIdFromFileName(name) {
  let base = String(name || '');
  if (!/\.(xlsx|json)$/i.test(base)) return '';
  base = base.slice(0, -5);
  // 导出文件名是「Z1-筛选-数据-2026-11-14.json」：先剥日期、再剥用途标签
  base = base.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-(实验安排|数据|实验课)$/, '');
  return base;
}

function resolveImportFileClass(fileClass, metaClass) {
  if (metaClass && fileClass === metaClass + '-筛选') return metaClass;
  return fileClass;
}

function selectedImportTarget() {
  const el = document.querySelector('input[name="importTarget"]:checked');
  return el ? el.value : 'current';
}

function importTargetId() {
  if (!pendingImport) return selectedClass;
  return selectedImportTarget() === 'file' ? pendingImport.fileClass : selectedClass;
}

function getImportTargetData() {
  const id = importTargetId();
  if (id === selectedClass) return experiments;
  return loadClassState(id).list;
}

function renderImportSummary() {
  if (!pendingImport) return;
  const targetId = importTargetId();
  const targetData = getImportTargetData();
  const targetNew = !classIds.includes(targetId);
  const fileClass = pendingImport.fileClass;

  importSummary.replaceChildren();

  const fileLine = document.createElement('div');
  fileLine.appendChild(document.createTextNode('文件：'));
  const fileB = document.createElement('b');
  fileB.textContent = cleanText(pendingImport.fileName, 160);
  fileLine.appendChild(fileB);
  const fileClassText = document.createElement('span');
  fileClassText.textContent = `（文件名班级：${cleanText(fileClass, 160)}）`;
  fileLine.appendChild(fileClassText);
  importSummary.appendChild(fileLine);

  if (pendingImport.source === 'json') {
    const sourceLine = document.createElement('div');
    sourceLine.textContent = '来源：JSON 完整备份';
    importSummary.appendChild(sourceLine);
  }

  const countLine = document.createElement('div');
  countLine.appendChild(document.createTextNode('有效记录 '));
  const countB = document.createElement('b');
  countB.textContent = String(pendingImport.list.length);
  countLine.appendChild(countB);
  countLine.appendChild(document.createTextNode(' 条'));
  importSummary.appendChild(countLine);

  if (pendingImport.meta) {
    const metaLine = document.createElement('div');
    const bits = [];
    if (pendingImport.metaClass) bits.push(`班级 ${pendingImport.metaClass}`);
    if (pendingImport.meta['记录数']) bits.push(`记录数 ${pendingImport.meta['记录数']}`);
    metaLine.textContent = bits.length ? `班级信息：${bits.join(' · ')}` : '包含班级信息';
    importSummary.appendChild(metaLine);
  }

  if (pendingImport.week1) {
    const currentWeek1 = toDateStr(readClassWeek1(targetId));
    const week1Line = document.createElement('div');
    week1Line.textContent = currentWeek1 === pendingImport.week1
      ? `week1：${currentWeek1}（不变）`
      : `week1：${currentWeek1} → ${pendingImport.week1}`;
    importSummary.appendChild(week1Line);
  }

  if (pendingImport.skipped.length) {
    const skipLine = document.createElement('div');
    skipLine.textContent = `忽略 ${pendingImport.skipped.length} 行无法识别的数据`;
    importSummary.appendChild(skipLine);

    const details = document.createElement('details');
    details.className = 'import-skipped';
    const summary = document.createElement('summary');
    summary.textContent = `查看 ${pendingImport.skipped.length} 行失败明细`;
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'import-skipped-list';
    pendingImport.skipped.forEach(item => {
      const row = document.createElement('div');
      row.className = 'import-skipped-item';
      row.textContent = item;
      list.appendChild(row);
    });
    details.appendChild(list);
    importSummary.appendChild(details);
  }

  const targetLine = document.createElement('div');
  targetLine.appendChild(document.createTextNode('导入目标：'));
  const targetB = document.createElement('b');
  targetB.textContent = targetId;
  targetLine.appendChild(targetB);
  targetLine.appendChild(document.createTextNode(
    targetNew ? '（本机新建）' : (targetId === selectedClass ? '（当前班）' : '（切换班级）')
  ));
  targetLine.appendChild(document.createTextNode(`；该班已有 ${targetData.length} 条记录`));
  importSummary.appendChild(targetLine);

  if (targetNew) {
    const note = document.createElement('div');
    note.textContent = '新建班只在本机保留；导出该班 xlsx 放进 data/ 并 build 后才会成为部署默认。';
    importSummary.appendChild(note);
  }

  // 文件内部自身就重复（判重口径与合并去重一致：日期 + 节次 + 名称）
  const dupes = findDuplicateRows(pendingImport.list);
  if (dupes.length) {
    const dupeLine = document.createElement('div');
    dupeLine.className = 'import-dupe';
    dupeLine.textContent = `文件里有 ${dupes.length} 条疑似重复（同日期、同节次、同名称），合并模式下只保留第一条`;
    importSummary.appendChild(dupeLine);
  }
}

// 与 mergeExperiments 同一判重口径：日期 + 节次 + 名称（规整后）
function findDuplicateRows(list) {
  const seen = new Map();
  const dupes = [];
  (list || []).forEach(item => {
    const key = expIdentity(item);
    if (seen.has(key)) {
      dupes.push({ key, first: seen.get(key), item });
      return;
    }
    seen.set(key, item);
  });
  return dupes;
}

function renderImportConflictHint(list) {
  const info = computeConflictInfo(list);
  if (!info.groups.length) {
    importConflict.hidden = true;
    importConflict.textContent = '';
    return;
  }

  const brief = info.groups.slice(0, 2)
    .map(g => `${g.dateLabel} ${g.periodLabel}`)
    .join('、');
  const more = info.groups.length > 2 ? '等' : '';
  importConflict.textContent =
    `导入后有 ${info.groups.length} 组时间冲突（${info.totalRows} 条）：${brief}${more}。仍可导入。`;
  importConflict.hidden = false;
}

function syncImportTargetUI() {
  if (!pendingImport) return;
  const fileClass = pendingImport.fileClass;
  const differs = fileClass !== selectedClass;
  importTargetBox.hidden = !differs;

  if (differs) {
    const exists = classIds.includes(fileClass);
    importCurrentClass.textContent = selectedClass;
    importFileTitle.textContent = exists
      ? `导入到 ${fileClass}（切换班级）`
      : `新建 ${fileClass} 并导入`;
    importFileDesc.textContent = exists
      ? `文件名是 ${fileClass}；确认后切换到该班并导入`
      : `文件名是 ${fileClass}；先在本机新建该班，导出并 build 后成为部署默认`;
  }

  const target = selectedImportTarget();
  document.querySelectorAll('.target-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.target === target);
  });
}

function selectedImportMode() {
  const el = document.querySelector('input[name="importMode"]:checked');
  return el ? el.value : 'merge';
}

/**
 * 合并去重
 *  - 判重依据：日期 + 节次 + 实验名称（做全角/空白/横线规整后比较）
 *  - 完全重复（地点和备注都相同）：跳过
 *  - 同名同时间但地点或备注不同：默认保留现有记录；updatePlace 为 true 时改用导入的地点和备注
 */
function mergeExperiments(existing, incoming, opts) {
  const updatePlace = !!(opts && opts.updatePlace);
  const list = existing.map(e => ({ ...e }));
  const index = new Map();
  list.forEach((e, i) => index.set(expIdentity(e), i));

  const added = [];
  const duplicates = [];
  const conflicts = [];
  const updated = [];

  incoming.forEach(src => {
    const item = { ...src };
    const key = expIdentity(item);
    const pos = index.get(key);

    if (pos === undefined) {
      index.set(key, list.length);
      list.push(item);
      added.push(item);
      return;
    }

    const cur = list[pos];
    const placeSame = normKeyText(cur.place) === normKeyText(item.place);
    const noteSame = String(cur.note || '').trim() === String(item.note || '').trim();
    if (placeSame && noteSame) {
      duplicates.push(item);
      return;
    }

    if (updatePlace) {
      conflicts.push({ before: cur.place, after: item.place, updated: true });
      updated.push(item);
      cur.place = item.place;
      cur.note = item.note || '';
    } else {
      conflicts.push({ before: cur.place, after: item.place, updated: false });
    }
  });

  return { list, added, duplicates, conflicts, updated };
}

function countSkippedDup(preview) {
  return preview.duplicates.length + preview.conflicts.filter(c => !c.updated).length;
}

function renderImportPreview() {
  if (!pendingImport) return;

  const targetId = importTargetId();
  const targetData = getImportTargetData();
  const preview = mergeExperiments(targetData, pendingImport.list, {
    updatePlace: conflictSelect.value === 'update'
  });

  const resultList = selectedImportMode() === 'replace' ? pendingImport.list : preview.list;
  renderImportConflictHint(resultList);

  const parts = [`保留 ${targetId} 现有 ${targetData.length} 条`];
  if (preview.added.length) parts.push(`新增 ${preview.added.length} 条`);
  else parts.push('没有可新增的记录');

  const skipped = countSkippedDup(preview);
  if (skipped) parts.push(`跳过重复 ${skipped} 条`);
  if (preview.updated.length) parts.push(`更新地点/备注 ${preview.updated.length} 条`);
  mergeDesc.textContent = parts.join('，') + '。';

  replaceDesc.textContent =
    `清空 ${targetId} 现有 ${targetData.length} 条记录，改用导入的 ${pendingImport.list.length} 条。`;

  conflictCountEl.textContent = String(preview.conflicts.length);
  conflictBox.hidden = !(selectedImportMode() === 'merge' && preview.conflicts.length > 0);
}

function syncImportModeCards() {
  const mode = selectedImportMode();
  document.querySelectorAll('.mode-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.mode === mode);
  });
  importNote.textContent = mode === 'replace' ? IMPORT_NOTE_REPLACE : IMPORT_NOTE_MERGE;
  renderImportPreview();
}

document.querySelectorAll('input[name="importMode"]').forEach(el => {
  el.addEventListener('change', syncImportModeCards);
});
document.querySelectorAll('input[name="importTarget"]').forEach(el => {
  el.addEventListener('change', () => {
    syncImportTargetUI();
    renderImportSummary();
    renderImportPreview();
  });
});
conflictSelect.addEventListener('change', renderImportPreview);

function openImportModal(data) {
  // 若读取文件期间进入了删除模式，先退出，避免标记下标与导入后的数据错位
  if (deleteMode) {
    setDeleteModeUI(false);
    render();
  }

  if (!data.fileClass) {
    data.fileClass = classIdFromFileName(data.fileName) || selectedClass;
  }

  pendingImport = data;
  const filteredBackup = data.exportScope === 'filtered';
  importScopeWarning.hidden = !filteredBackup;
  importScopeWarning.textContent = filteredBackup
    ? '这是“当前筛选”导出的备份，不是完整班级。叠加只导入这些记录；替换会清空未包含在备份中的实验。'
    : '';
  document.querySelector('input[name="importMode"][value="merge"]').checked = true;
  conflictSelect.value = 'keep';

  const targetValue = data.fileClass !== selectedClass ? 'file' : 'current';
  const targetRadio = document.querySelector(`input[name="importTarget"][value="${targetValue}"]`);
  if (targetRadio) targetRadio.checked = true;

  syncImportTargetUI();
  renderImportSummary();
  syncImportModeCards();
  rememberModalFocus(importMask, importBtn);
  importMask.classList.add('show');
  setTimeout(() => { try { importConfirmBtn.focus(); } catch (e) {} }, 0);
}

let pendingStorageRefresh = false;

function closeImportModal(skipReload) {
  importMask.classList.remove('show');
  restoreModalFocus(importMask);
  pendingImport = null;
  importConflict.hidden = true;
  importConflict.textContent = '';
  importScopeWarning.hidden = true;
  importScopeWarning.textContent = '';
  if (!skipReload && pendingStorageRefresh && !hasOpenOverlay() && !editMode && !deleteMode) {
    pendingStorageRefresh = false;
    setTimeout(() => { window.location.reload(); }, 0);
  }
}

importClose.addEventListener('click', () => closeImportModal());
importCancelBtn.addEventListener('click', () => closeImportModal());
importMask.addEventListener('click', (e) => {
  if (e.target === importMask) closeImportModal();
});

importConfirmBtn.addEventListener('click', async () => {
  if (!pendingImport) return;

  const mode = selectedImportMode();
  if (mode === 'replace' && pendingImport.exportScope === 'filtered') {
    const targetId = importTargetId();
    const targetNew = !classIds.includes(targetId);
    const existingCount = targetNew
      ? 0
      : (targetId === selectedClass ? experiments.length : getImportTargetData().length);
    if (existingCount > 0) {
      const ok = await askConfirm({
        title: '这是筛选备份',
        message: `它只包含当前筛选出的 ${pendingImport.list.length} 条实验，不是完整班级。`,
        detail: `替换会清空 ${targetId} 现有的 ${existingCount} 条记录，只保留备份中的记录。确定继续？`,
        okText: '仍然替换'
      });
      if (!ok) return;
    }
  }

  const updatePlace = conflictSelect.value === 'update';
  const { list, skipped, timeMode, fileClass, week1: importedWeek1, periodTimes: importedTimes } = pendingImport;
  const targetId = importTargetId();
  const targetNew = !classIds.includes(targetId);
  const targetWasCurrent = targetId === selectedClass;
  const previousSelected = selectedClass;
  const beforeList = (targetNew ? [] : getImportTargetData()).map(e => ({ ...e }));
  let beforeWeek1Raw = null;
  try { beforeWeek1Raw = localStorage.getItem(classWeek1Key(targetId)); } catch (e) {}

  if (targetNew) {
    addExtraClass(targetId);
    if (!classIds.includes(targetId)) {
      showStatus('error', `无法新建班级 ${targetId}`);
      return;
    }
  }
  if (targetId !== selectedClass) {
    if (!switchClass(targetId)) {
      showStatus('error', `无法切换到班级 ${targetId}`);
      return;
    }
  }

  let week1Applied = false;
  if (importedWeek1) {
    const w1 = parseDate(importedWeek1);
    if (saveClassWeek1Value(targetId, importedWeek1)) {
      if (targetId === selectedClass) {
        week1Start = w1;
        week1Input.value = importedWeek1;
      }
      week1Applied = true;
    }
  }

  // 班级自带的节次时间：优先于设置.json（留空则保持原有继承关系）
  let timesApplied = false;
  if (importedTimes) {
    saveStoredClassTimes(targetId, importedTimes);
    timesApplied = true;
  }

  let mergeInfo = null;
  if (mode === 'replace') {
    experiments = list.map(e => ({ ...e }));
  } else {
    mergeInfo = mergeExperiments(experiments, list, { updatePlace });
    experiments = mergeInfo.list;
  }

  lastDeletedByClass.delete(targetId);
  lastEditedByClass.delete(targetId);
  const savedOk = saveExperiments();
  if (savedOk) usingSaved = true;
  lastImportUndo = {
    targetId,
    targetNew,
    beforeList,
    beforeWeek1Raw,
    previousSelected
  };

  render();
  updateClock();
  pendingStorageRefresh = false;
  closeImportModal(true);
  syncClassSelect();
  syncHeaderActions();

  const modeTip = timeMode === 'week'
    ? '（按周次 + 星期推算日期）'
    : timeMode === 'mixed'
      ? '（按行识别日期或周次+星期）'
      : '';
  const lines = [];

  if (mode === 'replace') {
    lines.push(`已用导入文件替换 ${targetId} 的全部实验：共 ${list.length} 条${modeTip}`);
  } else {
    const bits = [`新增 ${mergeInfo.added.length} 条`];
    const skippedDup = countSkippedDup(mergeInfo);
    if (skippedDup) bits.push(`跳过重复 ${skippedDup} 条`);
    if (mergeInfo.updated.length) bits.push(`更新地点/备注 ${mergeInfo.updated.length} 条`);
    lines.push(`已叠加导入到 ${targetId}：${bits.join('，')}，当前共 ${experiments.length} 条${modeTip}`);
  }

  if (targetWasCurrent) {
    // 当前班提示保持简洁
  } else {
    lines.push(`· 已切换到班级 ${targetId}`);
  }
  if (week1Applied) lines.push(`· 已应用班级 week1：${importedWeek1}`);
  if (targetNew) lines.push(`· ${targetId} 是本机新建班级；导出该班 xlsx 放进 data/ 并 build 后才会成为部署默认`);
  if (fileClass !== targetId) lines.push(`· 文件名班级 ${fileClass} 未采用，已导入到 ${targetId}`);

  if (mergeInfo && mergeInfo.conflicts.length) {
    const kept = mergeInfo.conflicts.filter(c => !c.updated).length;
    if (kept) lines.push(`· 其中 ${kept} 条与现有记录同名同时间但地点或备注不同，已保留原有记录`);
  }

  if (skipped.length) {
    lines.push(`· 跳过 ${skipped.length} 行无法识别的数据：\n` + formatSkipped(skipped));
  }
  if (!savedOk) lines.push('· 本地保存失败，刷新后会恢复为之前的数据');

  showStatus(
    skipped.length || !savedOk ? 'warn' : 'ok',
    lines.join('\n'),
    { label: '撤销导入', onClick: undoLastImport }
  );
});

importBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;

  if (!/\.(xlsx|json)$/i.test(file.name)) {
    showStatus('error', '导入失败：请选择 .xlsx 或 .json 格式的文件');
    return;
  }
  const isJson = /\.json$/i.test(file.name);
  const fileClass = classIdFromFileName(file.name);
  if (!fileClass) {
    showStatus('error', '导入失败：文件名不能是空的班级名');
    return;
  }

  const oldText = importBtn.textContent;
  importBtn.disabled = true;
  importBtn.textContent = '正在读取…';
  statusEl.className = 'import-status';

  try {
    const data = isJson ? await importJsonFile(file) : await importXlsx(file);
    data.fileName = file.name;
    openImportModal(data);
  } catch (err) {
    showStatus('error', '导入失败：' + (err && err.message ? err.message : String(err)));
  } finally {
    importBtn.disabled = deleteMode;
    importBtn.textContent = oldText;
  }
});


/* ============================================================
   15. 导出 Excel
   ============================================================ */
function formatExportTime(d) {
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())} ${pad2(dd.getHours())}:${pad2(dd.getMinutes())}:${pad2(dd.getSeconds())}`;
}

/* ---------- 日历订阅（.ics）：纯静态页面唯一能做到"真正提醒"的方式 ----------
   生成标准 VCALENDAR，同学导入 iOS/Android 日历后由系统负责提醒。
   不依赖后端、不发网络请求、不影响 CSP。 */
// 节次时间：默认 < 设置.json < 班级文件（build 时已合并好注入模板）
const DEFAULT_PERIOD_TIMES = {
  '1-2': ['08:00', '09:40'],
  '3-4': ['10:00', '11:40'],
  '5-6': ['13:30', '15:10'],
  '7-8': ['16:00', '17:40'],
  '9-10': ['19:00', '20:40']
};
const REMINDER_MINUTES = (() => {
  const value = DEFAULT_DATA ? Number(DEFAULT_DATA.reminderMinutes) : NaN;
  return Number.isFinite(value) && value > 0 && value <= 24 * 60 ? value : 30;
})();
const CLASS_TIMES_KEY = STORAGE_PREFIX + 'classtimes:v1:';

function readStoredClassTimes(id) {
  if (!id) return null;
  try {
    return sanitizePeriodTimes(JSON.parse(localStorage.getItem(CLASS_TIMES_KEY + id) || 'null'));
  } catch (e) {
    return null;
  }
}

function saveStoredClassTimes(id, times) {
  if (!id) return;
  try {
    if (times) localStorage.setItem(CLASS_TIMES_KEY + id, JSON.stringify(times));
    else localStorage.removeItem(CLASS_TIMES_KEY + id);
  } catch (e) {}
}

// 本机班级时间 > 构建注入（已合并设置与班级）> 前端默认
function currentPeriodTimes() {
  const stored = readStoredClassTimes(selectedClass);
  if (stored) return Object.assign({}, DEFAULT_PERIOD_TIMES, stored);
  const injected = DEFAULT_CLASS_TIMES.get(selectedClass);
  if (injected) return injected;
  return Object.assign({}, DEFAULT_PERIOD_TIMES);
}

function icsEscape(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545：内容行不超过 75 个八位组，超出用 CRLF + 单个空格折行
function icsFold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  let out = '';
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 73) {
      out += current + '\r\n ';
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  return out + current;
}

function icsStampUtc(date) {
  return String(date.getUTCFullYear()) + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) + 'T' +
    pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + 'Z';
}

// 把「第3-4节」映射到具体时间；无法识别时退化为全天事件
function resolvePeriodTimes(period, table) {
  const ranges = parsePeriodRanges(period);
  if (!ranges || !ranges.length) return null;
  const times = table || currentPeriodTimes();
  const first = Math.min.apply(null, ranges.map(r => r[0]));
  const last = Math.max.apply(null, ranges.map(r => r[1]));
  const slots = Object.keys(times).map(key => {
    const parts = key.split('-');
    return { from: Number(parts[0]), to: Number(parts[1]), start: times[key][0], end: times[key][1] };
  });
  const startSlot = slots.find(slot => slot.from === first);
  const endSlot = slots.find(slot => slot.to === last);
  if (!startSlot || !endSlot) return null;
  return { start: startSlot.start, end: endSlot.end };
}

function buildIcsText(list, className) {
  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CrseCue//实验课提醒//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape('实验课 ' + className),
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(e => {
    const date = parseDate(e.date);
    if (isNaN(date.getTime())) return;
    const ymd = e.date.replace(/-/g, '');
    const slot = resolvePeriodTimes(e.period);
    let uid = 0;
    const seed = `${className}|${e.date}|${normKeyText(e.period)}|${normKeyText(e.name)}`;
    for (let i = 0; i < seed.length; i++) uid = (uid * 31 + seed.charCodeAt(i)) >>> 0;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid.toString(36)}-${ymd}@crsecue`);
    lines.push(`DTSTAMP:${icsStampUtc(now)}`);
    if (slot) {
      lines.push(`DTSTART;TZID=Asia/Shanghai:${ymd}T${slot.start.replace(':', '')}00`);
      lines.push(`DTEND;TZID=Asia/Shanghai:${ymd}T${slot.end.replace(':', '')}00`);
    } else {
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${ymd}`);
      lines.push(`DTEND;VALUE=DATE:${toDateStr(next).replace(/-/g, '')}`);
    }
    lines.push('SUMMARY:' + icsEscape(e.name || '实验课'));
    if (e.place) lines.push('LOCATION:' + icsEscape(e.place));
    const week = weekNoOf(date);
    const desc = [
      week === null ? '' : `第${week}周 ${WEEK_NAMES[date.getDay()]}`,
      e.period ? `节次 ${e.period}` : '',
      e.note ? `备注：${e.note}` : ''
    ].filter(Boolean).join('\n');
    if (desc) lines.push('DESCRIPTION:' + icsEscape(desc));
    lines.push('BEGIN:VALARM');
    lines.push(`TRIGGER:-PT${REMINDER_MINUTES}M`);
    lines.push('ACTION:DISPLAY');
    lines.push('DESCRIPTION:' + icsEscape('实验课提醒：' + (e.name || '实验课')));
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function exportIcs() {
  if (!selectedClass) {
    showStatus('warn', '当前没有班级，无法导出日历');
    return;
  }
  const list = experiments.slice();
  if (!list.length) {
    showStatus('warn', '当前班级还没有实验，未生成日历文件');
    return;
  }
  try {
    const blob = new Blob([buildIcsText(list, selectedClass)], { type: 'text/calendar;charset=utf-8' });
    const fileName = `${selectedClass}-实验课-${toDateStr(new Date())}.ics`;
    downloadBlob(blob, fileName);
    showStatus('ok', `已导出 ${list.length} 条实验到 ${fileName}。导入手机日历后会提前 2 小时提醒。`);
  } catch (err) {
    showStatus('error', '生成日历失败：' + (err && err.message ? err.message : err));
  }
}

function exportXlsx() {
  if (!selectedClass) {
    showStatus('warn', '当前没有班级，无法导出');
    return;
  }
  try {
    const scope = exportScopeFiltered.checked ? 'filtered' : 'all';
    const rows = getExportEntries();

    const aoa = [EXPORT_HEADERS.slice()];
    rows.forEach(e => {
      const wk = weekNoOf(e._date);
      aoa.push([
        e.date,
        wk === null ? '—' : '第' + wk + '周',
        WEEK_NAMES[e._date.getDay()],
        e.period,
        e.name,
        e.place,
        e.note || ''
      ]);
    });

    const conflictInfo = computeConflictInfo(experiments);
    const highlight = new Set();
    rows.forEach((e, i) => {
      if (conflictInfo.byIndex.has(e._idx)) highlight.add(i + 1);
    });

    const blob = buildXlsxBlob(aoa, EXPORT_SHEET_NAME, EXPORT_COL_WIDTHS, highlight, [
      ['键', '值'],
      ['备份格式版本', '1'],
      ['班级', selectedClass],
      ['导出范围', scope === 'filtered' ? '当前筛选' : '全部实验'],
      ['记录数', String(rows.length)],
      ['week1', toDateStr(week1Start)],
      ['periodTimes', JSON.stringify(currentPeriodTimes())],
      ['数据更新时间', DATA_UPDATED_AT || ''],
      ['导出时间', formatExportTime(new Date())]
    ]);
    const fileName = `${selectedClass}${scope === 'filtered' ? '-筛选' : ''}-实验安排-${toDateStr(new Date())}.xlsx`;
    downloadBlob(blob, fileName);

    const base = rows.length
      ? `已导出班级 ${selectedClass} 的 ${scope === 'filtered' ? '当前筛选' : '全部'} ${rows.length} 条实验安排：${fileName}`
      : `已导出班级 ${selectedClass} 的空表（仅表头）：${fileName}`;
    showStatus(
      'ok',
      base + (highlight.size
        ? `；其中 ${conflictInfo.groups.length} 组时间冲突所在行已标为浅黄色`
        : '')
    );
  } catch (err) {
    showStatus('error', '导出失败：' + (err && err.message ? err.message : String(err)));
  }
}

exportBtn.addEventListener('click', openExportChooser);
document.getElementById('icsBtn').addEventListener('click', exportIcs);

// 订阅地址：指向构建期生成的 calendars/<班级>.ics，日历 App 订阅一次后随数据更新自动同步
document.getElementById('icsCopyBtn').addEventListener('click', () => {
  if (!selectedClass) {
    showStatus('warn', '当前没有班级，无法复制订阅地址');
    return;
  }
  if (!isBuiltClass(selectedClass)) {
    showStatus('warn', `${selectedClass} 是本机班级，还没有订阅文件；导出并 build 之后才会有`);
    return;
  }
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    showStatus('warn', '用本地文件方式打开时没有可订阅的地址；请用部署后的网页地址');
    return;
  }
  // 订阅文件放在 calendars/ 下：从当前页面地址推出站点根，再拼 calendars/<班级>.ics
  const pageUrl = new URL(location.href);
  pageUrl.pathname = pageUrl.pathname.replace(/[^/]*$/, '');
  pageUrl.search = '';
  pageUrl.hash = '';
  const url = new URL('calendars/' + encodeURIComponent(selectedClass) + '.ics', pageUrl.href).href;
  const ok = () => showStatus('ok', `订阅地址已复制：${url}。在手机日历里选「订阅日历」粘贴即可。`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(() => showCopyFallback(url, '订阅地址'));
  } else {
    showCopyFallback(url, '订阅地址');
  }
});

// 诊断信息：粘到群里就能定位"为什么显示不对"
// 设备时区标签：页面按本地时区算"今天"，.ics 固定 UTC+8，不一致时容易差一天
function timezoneOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

function timezoneLabel() {
  const offset = timezoneOffsetMinutes();
  const abs = Math.abs(offset);
  return (offset >= 0 ? '+' : '-') + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/* 纠错回路：页面没有后端、也没有任何外链，学生发现"地点写错了"只能截图发群里。
   这里把班级、页面链接、最可能是他正在看的那一条实验拼成一段话，一键复制。
   目标优先取提示条指向的那条（今天/下一节），没有就取当前显示的第一行。
   它不改数据、不发请求，只是把"截图 + 描述"的成本降到一次点击。 */
const feedbackBtn = document.getElementById('feedbackBtn');
if (feedbackBtn) {
  feedbackBtn.addEventListener('click', () => {
    let target = null;
    const cueIdx = cueTextEl && cueTextEl.dataset.idx !== undefined ? Number(cueTextEl.dataset.idx) : null;
    if (cueIdx !== null && !isNaN(cueIdx) && experiments[cueIdx]) {
      target = experiments[cueIdx];
    } else {
      const firstRow = document.querySelector('#tbody tr:not(.note-row)');
      const rowIdx = firstRow && firstRow.dataset.idx !== undefined ? Number(firstRow.dataset.idx) : null;
      if (rowIdx !== null && !isNaN(rowIdx) && experiments[rowIdx]) target = experiments[rowIdx];
    }

    const cls = selectedClass || '';
    // file:// 直接双击打开时 location.origin 是 "null"，拼出来的链接是废的；
    // 那种情况下宁可写一句实话，也不要给群里贴一条打不开的地址。
    const shareable = location.protocol === 'http:' || location.protocol === 'https:';
    const pageUrl = shareable
      ? location.origin + location.pathname + (cls ? `?${CLASS_QUERY_PARAM}=${encodeURIComponent(cls)}` : '')
      : '（这份页面是本地文件打开的，没有可分享的网址）';
    const lines = ['【CrseCue · 反馈】'];
    if (cls) lines.push('班级：' + cls);
    lines.push('页面：' + pageUrl);
    if (target) {
      const d = parseDate(target.date);
      let when = target.date || '';
      if (d && !isNaN(d.getTime())) {
        const wk = weekNoOf(d);
        when = `${target.date}（第 ${wk} 周 ${WEEK_NAMES[d.getDay()]}）`;
      }
      lines.push(`我看到的是：${when} ${target.period || ''} ${target.name || ''}`.replace(/\s+/g, ' ').trim()
        + (target.place ? ` · ${target.place}` : ''));
      lines.push('应该改为：（请补充：日期 / 节次 / 地点 / 名称）');
    } else {
      lines.push('我看到的是：（请补充：哪一天、第几节、哪条实验）');
      lines.push('应该改为：（请补充）');
    }
    lines.push('页面显示的更新时间：' + (DATA_UPDATED_AT || '未知'));

    const text = lines.join('\n');
    const ok = () => showStatus('ok', '反馈内容已复制，粘贴到班级群即可');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(() => showCopyFallback(text, '反馈内容'));
    } else {
      showCopyFallback(text, '反馈内容');
    }
  });
}

document.getElementById('diagBtn').addEventListener('click', () => {
  const shownRows = document.querySelectorAll('#tbody tr:not(.note-row)').length;
  // 本机存储占用：换学期/长期使用后，用户最需要知道这份缓存有多大
  let usedBytes = 0;
  let usedKeys = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      usedKeys += 1;
      usedBytes += (key.length + String(localStorage.getItem(key) || '').length) * 2;
    }
  } catch (e) {}
  const timesSource = readStoredClassTimes(selectedClass)
    ? '本机保存'
    : (DEFAULT_CLASS_TIMES.has(selectedClass) ? '页面数据' : '内置默认');
  const filterBits = [];
  if (recentOnly) filterBits.push('已结束仅显示本周');
  if (conflictOnly) filterBits.push('只看冲突');
  const query = searchInput ? searchInput.value.trim() : '';
  if (query) filterBits.push(`搜索「${query}」`);

  const text = [
    '【CrseCue · 诊断信息】',
    '时间：' + new Date().toLocaleString('zh-CN'),
    '班级：' + (selectedClass || '（无）'),
    '该班实验：' + experiments.length + ' 条，当前显示 ' + shownRows + ' 条',
    '数据版本：' + (DATA_UPDATED_AT || '未知'),
    '第 1 周星期一：' + toDateStr(week1Start),
    '本机数据：' + (usingSaved ? '有（只在这台设备）' : '无'),
    '本机存储：' + usedKeys + ' 个键 / ' + (usedBytes / 1024).toFixed(1) + ' KB',
    '节次时间来源：' + timesSource,
    '当前筛选：' + (filterBits.length ? filterBits.join(' + ') : '无'),
    '视图：' + (document.body.classList.contains('view-week') ? '课表' : '列表'),
    '模式：' + (READ_ONLY ? '只读' : '可编辑'),
    '视口：' + window.innerWidth + '×' + window.innerHeight,
    '时区：UTC' + timezoneLabel(),
    'UA：' + navigator.userAgent
  ].join('\n');
  const ok = () => showStatus('ok', '诊断信息已复制，粘贴到群里即可');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(() => showCopyFallback(text, '诊断信息'));
  } else {
    showCopyFallback(text, '诊断信息');
  }
});

// 清理本机数据：只清这台设备上的覆盖，部署数据不动
const wipeLocalBtn = document.getElementById('wipeLocalBtn');
if (wipeLocalBtn) {
  wipeLocalBtn.addEventListener('click', async () => {
    if (READ_ONLY) {
      showStatus('warn', '只读链接不会写入本机数据，无需清理');
      return;
    }
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
      }
    } catch (e) {}
    if (!keys.length) {
      showStatus('ok', '本机没有可清理的数据');
      return;
    }
    let bytes = 0;
    keys.forEach(key => {
      try { bytes += (key.length + String(localStorage.getItem(key) || '').length) * 2; } catch (e) {}
    });
    const ok = await askConfirm({
      title: '清理本机数据？',
      message: `将删除这台设备上保存的 ${keys.length} 项数据（约 ${(bytes / 1024).toFixed(1)} KB）：班级改动、隐藏的内置班、班级节次时间与当前选择。`,
      detail: '只影响这台设备，部署的数据不会变。清理后页面会重新加载；需要保留请先导出。',
      okText: '清理'
    });
    if (!ok) return;
    keys.forEach(key => {
      try { localStorage.removeItem(key); } catch (e) {}
    });
    try { sessionStorage.removeItem(VIEW_STATE_KEY); } catch (e) {}
    showStatus('ok', `已清理 ${keys.length} 项本机数据，正在重新加载…`);
    window.setTimeout(() => { window.location.reload(); }, 600);
  });
}

// 键盘 /：展开「操作」面板并聚焦搜索（桌面快捷入口；手机从「操作」进入）
document.addEventListener('keydown', ev => {
  if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const active = document.activeElement;
  const tag = active ? active.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable)) return;
  ev.preventDefault();
  if (actionPanel.hidden) actionsToggle.click();
  searchInput.focus();
  searchInput.select();
});


/* ============================================================
   16. 恢复默认实验 / 隐藏的内置班
   ============================================================ */
restoreToolBtn.addEventListener('click', openRestoreDialog);
restoreDefaultBtn.addEventListener('click', restoreCurrentClassDefaults);
restoreClose.addEventListener('click', closeRestoreDialog);
restoreDone.addEventListener('click', closeRestoreDialog);
restoreMask.addEventListener('click', ev => {
  if (ev.target === restoreMask) closeRestoreDialog();
});


function hasOpenOverlay() {
  return !!document.querySelector('.modal-mask.show');
}

function reloadFromStorage() {
  window.location.reload();
}

window.addEventListener('storage', event => {
  if (!event.key) {
    extraClasses = loadExtraClasses();
    hiddenBuiltClasses = loadHiddenBuiltClasses();
    classIds = getAllClassIds();
    if (!classIds.includes(selectedClass)) selectedClass = classIds[0] || '';
    saveSelectedClass();
    setCurrentClassData(selectedClass);
    week1Start = readClassWeek1(selectedClass);
    if (week1Input) week1Input.value = toDateStr(week1Start);
    pendingStorageRefresh = false;
    syncClassSelect();
    syncHeaderActions();
    syncUrlClass();
    render();
    updateClock();
    showStatus('warn', '另一个标签页清空了本机数据，已重新加载');
    return;
  }

  if (event.key === CLASS_SELECTED_KEY && event.newValue && event.newValue !== selectedClass) {
    showStatus(
      'warn',
      `另一个标签页已切换到 ${cleanText(event.newValue, 80)}`,
      { label: '重新加载', onClick: reloadFromStorage }
    );
    return;
  }

  const currentDataKey = classDataKey(selectedClass);
  const currentWeek1Key = classWeek1Key(selectedClass);

  if (event.key === currentDataKey || event.key === currentWeek1Key) {
    if (hasOpenOverlay() || editMode || deleteMode) {
      pendingStorageRefresh = true;
      showStatus(
        'warn',
        '另一个标签页更新了当前班；请关闭弹窗/完成模式后重新加载',
        { label: '重新加载', onClick: reloadFromStorage }
      );
      return;
    }
    pendingStorageRefresh = false;
    lastImportUndo = null;
    lastDeletedByClass.delete(selectedClass);
    lastEditedByClass.delete(selectedClass);
    setCurrentClassData(selectedClass);
    week1Start = readClassWeek1(selectedClass);
    if (week1Input) week1Input.value = toDateStr(week1Start);
    render();
    updateClock();
    showStatus('ok', '已同步另一个标签页对当前班的修改');
    return;
  }

  if (event.key === CLASS_EXTRA_KEY || event.key === CLASS_HIDDEN_KEY) {
    extraClasses = loadExtraClasses();
    hiddenBuiltClasses = loadHiddenBuiltClasses();
    classIds = getAllClassIds();
    if (!classIds.includes(selectedClass)) {
      selectedClass = classIds[0] || '';
      saveSelectedClass();
      setCurrentClassData(selectedClass);
      week1Start = readClassWeek1(selectedClass);
      if (week1Input) week1Input.value = toDateStr(week1Start);
    }
    pendingStorageRefresh = false;
    syncClassSelect();
    syncHeaderActions();
    syncUrlClass();
    render();
    updateClock();
    showStatus('ok', '已同步另一个标签页的班级列表');
  }
});


/* ============================================================
   17. 全局键盘 & 初始渲染
   ============================================================ */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = topOpenModal();
  if (!top) return;
  if (top === exportMask) closeExportChooser();
  else if (top === copyMask) closeCopyFallback();
  else if (top === classMask) closeClassPrompt();
  else if (top === restoreMask) closeRestoreDialog();
  else if (top === confirmMask) settleConfirm(false);
  else if (top === importMask) closeImportModal();
  else if (top === modalMask) closeModal();
});

showFirstRunHint();

// 存储不可用时挂常驻提示：否则用户会以为改动已经保存，刷新后才发现全丢了
(function showStorageWarning() {
  const el = document.getElementById('storageWarn');
  if (!el || STORAGE_OK) return;
  el.textContent = '这台设备无法保存改动（浏览器禁用了本地存储）。刷新后修改会丢失，'
    + '需要保留请用「操作 → 数据 → 导出」备份。';
  el.hidden = false;
})();

// 设备时区不是 UTC+8 时提醒：页面按本地时区算"今天"，.ics 里固定 +08:00
(function showTimezoneWarning() {
  const el = document.getElementById('tzWarn');
  if (!el) return;
  if (timezoneOffsetMinutes() === 480) return;
  el.textContent = '你的设备时区是 UTC' + timezoneLabel() + '，课表按 UTC+08:00 排课；'
    + '两者不一致时，"今天"和日历时间可能相差一天，请自行换算。';
  el.hidden = false;
})();

if (viewListBtn) viewListBtn.addEventListener('click', () => setView('list', true));
if (viewWeekBtn) viewWeekBtn.addEventListener('click', () => setView('week', true));
{
  let savedView = 'list';
  try { savedView = sessionStorage.getItem(VIEW_STATE_KEY) || 'list'; } catch (e) {}
  setView(savedView, false);
}
window.addEventListener('resize', () => {
  if (document.body.classList.contains('view-week')
      && !window.matchMedia(`(min-width: ${WEEK_VIEW_MIN_WIDTH}px)`).matches) {
    setView('list', false);
  }
});
syncDateModeUI();
syncImportModeCards();
syncClassSelect();
syncHeaderActions();

// 链接里的班级不存在：跳 404 说明情况，不要静默换成别的班
if (REQUESTED_CLASS_MISSING) {
  try {
    location.replace('404.html?from=class&name=' + encodeURIComponent(cleanText(REQUESTED_CLASS, 40)));
  } catch (e) {}
} else {
  syncUrlClass();
}
updateClock();
render();

// 冷启动定位到「最近一次实验」（今天有就今天，否则之后最近的一天）：
//   · 只做一次（刷新/新标签页算一次；切班级、改筛选、跨天刷新都不再自作主张滚动）
//   · 那天所有条都已完整可见 → 什么都不做，标记靠行上的蓝色描边 +「今天 / N天后」标签
//   · 看不全 → 用最小距离滚动，让那天所有条完整落在安全区内（顶部扣掉吸顶表头）
//   · 没有今天及以后的实验、或目标被搜索/只看冲突筛掉 → 不动
let autoLocated = false;

// 顶部吸顶遮挡：桌面表格的 thead th 是 sticky；卡片布局下表头是视觉隐藏的，返回 0
function stickyTopInset() {
  const thead = document.querySelector('thead');
  const th = thead && thead.querySelector('th');
  if (!th) return 0;
  // 卡片布局里 thead 被绝对定位 + clip 成"视觉隐藏"，但里面的 th 仍是 position: sticky，
  // 直接量它的底边会拿到整页高度级的假值（实测 296px），把安全区吃掉一半。
  if (getComputedStyle(thead).position === 'absolute') return 0;
  if (getComputedStyle(th).position !== 'sticky') return 0;
  const rect = th.getBoundingClientRect();
  if (rect.height <= 0 || rect.height > 96) return 0;  // 几何异常时不参与计算
  return Math.max(0, rect.bottom);
}

// ---------------------------------------------------------------------------
// 可见性：冷启动定位和「点提示条跳转」共用同一套规则 —— 能看见就不动，看不全才最小滚动。
// ---------------------------------------------------------------------------
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 返回需要滚动的距离（0 表示已经完整可见，不用动）
function rangeScrollDelta(top, bottom, safeTop, safeBottom) {
  if (top >= safeTop - 1 && bottom <= safeBottom + 1) return 0;
  const available = safeBottom - safeTop;
  if (bottom - top > available) return top - safeTop;   // 比安全区还高：首端贴顶
  if (bottom > safeBottom) return bottom - safeBottom;  // 下面看不全：最小上移
  return top - safeTop;                                 // 上面被挡住：最小下移
}

// 小于这个距离就不滚了：差 1–2px 本来就算"基本完整可见"，
// 真滚那 1px 反而像页面抽了一下（实测 560px 高时只差 1px）。
const SCROLL_EPSILON = 8;

function scrollRangeIntoView(top, bottom, smooth) {
  const delta = rangeScrollDelta(top, bottom, stickyTopInset(), window.innerHeight);
  if (Math.abs(delta) < SCROLL_EPSILON) return false;
  window.scrollBy({ top: delta, left: 0, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  return true;
}

// 单个元素：已经完整可见就什么都不做（提示条点击用它，避免"明明看得见还跳到屏幕正中"）
function ensureElementVisible(el, smooth) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return scrollRangeIntoView(rect.top, rect.bottom, smooth);
}

function autoLocateNearest() {
  if (autoLocated) return;
  if (document.body.classList.contains('view-week')) { autoLocated = true; return; }  // 课表视图整天都看得见
  const rows = Array.prototype.slice.call(tableBodyEl.querySelectorAll('tr[data-idx]'));
  // 首次渲染可能还没有行（班级数据还在还原）：留个待办，等数据到位再判断一次
  if (!rows.length) return;

  const today = startOfDay(new Date());
  const dateOf = tr => {
    const entry = experiments[Number(tr.dataset.idx)];
    return entry ? parseDate(entry.date) : new Date(NaN);
  };
  const dates = rows.map(dateOf);
  let targetDate = dates.find(d => d.getTime() === today.getTime());
  if (!targetDate) {
    targetDate = dates.filter(d => d > today).sort((a, b) => a - b)[0];
    if (!targetDate) { autoLocated = true; return; }  // 全是已结束
  }
  const group = rows.filter(tr => dateOf(tr).getTime() === targetDate.getTime());
  if (!group.length) { autoLocated = true; return; }
  autoLocated = true;

  // 读屏用户看不到滚动和闪烁，用 sr-only 的 liveStatus 播报一句（不弹可见状态栏）
  const firstEntry = experiments[Number(group[0].dataset.idx)];
  if (firstEntry) announce(`已定位到 ${cueTargetLabel(firstEntry)}`);

  // 那一天的所有条都算目标范围：全部完整可见就不滚
  const rects = group.map(tr => tr.getBoundingClientRect());
  scrollRangeIntoView(
    Math.min.apply(null, rects.map(r => r.top)),
    Math.max.apply(null, rects.map(r => r.bottom)),
    false
  );
  // 滚不滚都闪第一行：不滚时这就是唯一"定位到了"的反馈。
  // 同一天多条时全都闪会在桌面上叠成双线，所以只标首行，其余行保留各自的描边与标签。
  flashElement(group[0]);
}

// 同步执行（脚本在 </body> 前，早于首次绘制）：不会出现"先看到顶部再跳一下"。
// 注意别挪到 load / rAF 之后——那样既会闪一下，也会和"打开页面先滚到顶"的脚本抢滚动位置。
autoLocateNearest();
// 只在"第一次没行可判断"的情况下补一次（数据稍后才还原时），正常路径不会重复滚动
if (!autoLocated) {
  window.addEventListener('load', () => {
    window.requestAnimationFrame(() => {
      if (!autoLocated) autoLocateNearest();
    });
  }, { once: true });
}

// 时钟每 30 秒刷一次；顺带检查是否跨天（页面挂一夜也会自己对齐）
window.setInterval(() => {
  updateClock();
  refreshIfDayChanged();
}, 30000);

// 回到前台立刻查一次：后台标签页的定时器会被节流，光靠心跳不够
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  updateClock();
  refreshIfDayChanged();
});
window.addEventListener('focus', refreshIfDayChanged);

/* 弹窗打开时把 <main> 设为 inert：
   JS 的焦点陷阱挡得住 Tab，挡不住读屏的虚拟光标 —— 否则打开弹窗后还能"逛"到后面的表格。
   inert 是 Chrome 102+，老浏览器退回 aria-hidden（行为略弱但仍比不做好）。 */
(function syncBackgroundInert() {
  var masks = ['modalMask', 'importMask', 'exportMask', 'copyMask', 'confirmMask', 'classMask', 'restoreMask'];
  var mainEl = document.getElementById('main');
  if (!mainEl || typeof MutationObserver === 'undefined') return;
  function sync() {
    var open = masks.some(function (id) {
      var el = document.getElementById(id);
      return el && el.classList.contains('show');
    });
    if (open) {
      mainEl.setAttribute('aria-hidden', 'true');
      if ('inert' in mainEl) mainEl.inert = true;
    } else {
      mainEl.removeAttribute('aria-hidden');
      if ('inert' in mainEl) mainEl.inert = false;
    }
  }
  var observer = new MutationObserver(sync);
  masks.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  sync();
})();
