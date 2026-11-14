// 纯逻辑回归：日期/周次/节次/冲突/ICS 生成。
// 这些函数在页面里是全局的，直接 page.evaluate 调用即可，不需要重构源码或引入构建工具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = pathToFileURL(path.join(root, 'index.html')).href;
const browserName = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const browserType = browserName === 'webkit' ? webkit : chromium;
const channel = browserName === 'chromium'
  ? (process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined))
  : undefined;

const browser = await browserType.launch({ headless: true, ...(channel ? { channel } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.stack || error.message));
await page.goto(appUrl);
await page.waitForSelector('#tbody tr');

const r = await page.evaluate(() => {
  const out = {};
  const d = parseDate('2026-11-06');
  out.parseDate = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  out.parseDateGarbage = Number.isNaN(parseDate('abc').getTime());
  // 记录当前行为：越界月份按 JS Date 规则进位（真实输入路径都会先过 isValidDateStr）
  out.parseDateRollover = (() => {
    const x = parseDate('2026-13-01');
    return [x.getFullYear(), x.getMonth() + 1, x.getDate()];
  })();
  out.parseDateCacheClone = (() => {
    const a = parseDate('2026-11-06');
    a.setFullYear(1999);
    const b = parseDate('2026-11-06');
    return b.getFullYear();
  })();

  out.startOfWeekMonday = toDateStr(startOfWeekMonday(parseDate('2026-11-14')));
  out.dayDiff = dayDiff(parseDate('2026-11-16'), parseDate('2026-11-14'));
  out.weekNo = weekNoOf(parseDate('2026-11-16'));
  out.weekNoBeforeTerm = weekNoOf(parseDate('2020-01-01'));

  out.ranges = parsePeriodRanges('第3-4节');
  out.rangesList = parsePeriodRanges('第3、4节');
  out.rangesSpan = parsePeriodRanges('第3-8节');
  out.rangesReversed = parsePeriodRanges('第8-3节');
  out.rangesUnparsable = parsePeriodRanges('待定');
  out.overlapYes = periodRangesOverlap([[3, 8]], [[5, 6]]);
  out.overlapNo = periodRangesOverlap([[3, 4]], [[5, 6]]);

  out.normKeyText = normKeyText('第３－４节');
  out.weekNoText = parseWeekNo('第7周');
  out.weekNoBad = parseWeekNo('第七周');
  out.weekdayCn = parseWeekday('星期一');
  out.weekdayZero = parseWeekday(0);
  out.identitySame = expIdentity({ date: '2026-11-06', period: '第３－４节', name: 'A' })
    === expIdentity({ date: '2026-11-06', period: '第3-4节', name: 'A' });

  const conflict = computeConflictInfo([
    { date: '2026-11-06', period: '第3-4节', name: 'A', place: '1' },
    { date: '2026-11-06', period: '第4-5节', name: 'B', place: '2' },
    { date: '2026-11-06', period: '第7-8节', name: 'C', place: '3' },
    { date: '2026-11-07', period: '第3-4节', name: 'D', place: '4' }
  ]);
  out.conflictGroups = conflict.groups.map(group => group.indices);
  out.conflictIndexed = conflict.byIndex.size;

  const ics = buildIcsText([
    { date: '2026-11-06', period: '第3-4节', name: '实验;A,B', place: 'A101', note: '第一行\n第二行' }
  ], 'Z1');
  out.icsStartsEnds = ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR');
  out.icsEvents = (ics.match(/BEGIN:VEVENT/g) || []).length;
  out.icsAlarm = /TRIGGER:-PT30M/.test(ics);
  // 5-6 节按班级/设置前移到 13:30
  out.icsPeriod5 = /DTSTART;TZID=Asia\/Shanghai:\d{8}T133000/.test(
    buildIcsText([{ date: '2026-11-06', period: '第5-6节', name: '下午课', place: 'A101', note: '' }], 'Z1')
  );
  out.icsEscapedSummary = /SUMMARY:实验\\;A\\,B/.test(ics);
  out.icsEscapedNote = /DESCRIPTION:.*\\n/.test(ics);
  out.icsTime = /DTSTART;TZID=Asia\/Shanghai:20261106T100000/.test(ics);
  out.icsMaxLineBytes = Math.max.apply(null, ics.split('\r\n').map(line => new TextEncoder().encode(line).length));
  out.icsCrlfOnly = !/[^\r]\n/.test(ics);

  const allDay = buildIcsText([{ date: '2026-11-06', period: '晚上', name: 'X', place: '' }], 'Z1');
  out.icsAllDay = /DTSTART;VALUE=DATE:20261106/.test(allDay);

  out.xmlEscape = xmlEscape('<a href="x">&');
  out.cleanText = cleanText('a\u0001b', 10);
  out.cleanNote = cleanNote('  x\r\ny  ');
  out.escapeRegex = normKeyText('  A  B ');

  // 导入时的疑似重复：与合并去重同一口径（日期 + 节次 + 名称）
  out.dupeRows = findDuplicateRows([
    { date: '2026-11-02', period: '第3-4节', name: '重复实验', place: 'A101', note: '' },
    { date: '2026-11-02', period: '第 3-4 节', name: '重复实验', place: 'B202', note: '不同地点' },
    { date: '2026-11-02', period: '第5-6节', name: '重复实验', place: 'A101', note: '' }
  ]).length;
  out.periodTimesShape = JSON.stringify(sanitizePeriodTimes({ '5-6': ['13:30', '15:10'], '7': ['x', 'y'] }));

  // ---- xlsx 生成：手写 OOXML 是"数据出得去"的唯一通道，之前零覆盖 ----
  const sheet = makeXlsxSheetXml([
    ['日期', '实验名称'],
    ['2026-11-02', 'A&B <c> "d" \'e\''],
    ['2026-11-09', ' 前后有空格 ']
  ], [12, 30], new Set([1]), true);
  out.xlsxEscaped = /A&amp;B &lt;c&gt; &quot;d&quot; &apos;e&apos;/.test(sheet);
  out.xlsxHeaderNoStyle = !/<c r="A1"[^>]*s="1"/.test(sheet);
  out.xlsxHighlighted = /<c r="A2"[^>]*s="1"/.test(sheet) && !/<c r="A3"[^>]*s="1"/.test(sheet);
  out.xlsxPreserveSpace = /<t xml:space="preserve"> 前后有空格 <\/t>/.test(sheet);
  out.xlsxStructure = /<pane ySplit="1"/.test(sheet)
    && /<autoFilter ref="A1:B3"\/>/.test(sheet)
    && /<col min="1" max="1" width="12"/.test(sheet)
    && /<col min="2" max="2" width="30"/.test(sheet);
  const plainSheet = makeXlsxSheetXml([['日期'], ['2026-11-02']], [], null, false);
  out.xlsxNoHighlightNoCols = !/ s="1"/.test(plainSheet) && !/<cols>/.test(plainSheet);
  const headerOnly = makeXlsxSheetXml([['日期', '节次']], null, null, false);
  out.xlsxHeaderOnly = /<row r="1">/.test(headerOnly) && !/<row r="2">/.test(headerOnly)
    && /<autoFilter ref="A1:B1"\/>/.test(headerOnly);
  out.xlsxControlChars = !/[\u0000-\u0008\u000B\u000C]/.test(xmlEscape('a\u0001b\u0008c'));

  const blob = buildXlsxBlob([['日期'], ['2026-11-02']], '实验安排', [12], null, [['键', '值'], ['班级', 'Z1']]);
  out.xlsxBlobSize = blob instanceof Blob && blob.size > 1000;
  out.xlsxBlobType = /spreadsheetml/.test(blob.type);

  // 导出文件名带日期后，导入仍要能剥回班级名
  out.fileClassPlain = classIdFromFileName('Z1.json');
  out.fileClassDated = classIdFromFileName('Z1-数据-2026-11-14.json');
  out.fileClassFiltered = classIdFromFileName('Z1-筛选-数据-2026-11-14.json');
  out.fileClassXlsx = classIdFromFileName('Z1-实验安排-2026-11-14.xlsx');
  out.fileClassBad = classIdFromFileName('readme.txt');
  return out;
});

const cases = [
  ['parseDate 解析', r.parseDate, [2026, 11, 6]],
  ['parseDate 非日期字符串为 NaN', r.parseDateGarbage, true],
  ['parseDate 越界月份按 JS 规则进位（现状记录）', r.parseDateRollover, [2027, 1, 1]],
  ['parseDate 返回克隆，不污染缓存', r.parseDateCacheClone, 2026],
  ['startOfWeekMonday(周六)', r.startOfWeekMonday, '2026-11-09'],
  ['dayDiff', r.dayDiff, 2],
  ['weekNoOf', r.weekNo, 12],
  ['weekNoOf 学期开始前为 null', r.weekNoBeforeTerm, null],
  ['节次区间 第3-4节', r.ranges, [[3, 4]]],
  ['节次区间 第3、4节 拆成两个单节', r.rangesList, [[3, 3], [4, 4]]],
  ['节次区间 第3-8节', r.rangesSpan, [[3, 8]]],
  ['节次区间 倒序归一', r.rangesReversed, [[3, 8]]],
  ['节次无法解析返回 null', r.rangesUnparsable, null],
  ['节次包含关系算重叠', r.overlapYes, true],
  ['相邻节次不算重叠', r.overlapNo, false],
  ['全角/长横线归一', r.normKeyText, '第3-4节'],
  ['parseWeekNo', r.weekNoText, 7],
  ['parseWeekNo 中文数字不支持', r.weekNoBad, null],
  ['parseWeekday 星期一', r.weekdayCn, 1],
  ['parseWeekday 0 = 星期日', r.weekdayZero, 7],
  ['expIdentity 归一后相等', r.identitySame, true],
  ['冲突分组', r.conflictGroups, [[0, 1]]],
  ['冲突行索引数量', r.conflictIndexed, 2],
  ['ICS 首尾', r.icsStartsEnds, true],
  ['ICS 事件数', r.icsEvents, 1],
  ['ICS 含提前 30 分钟提醒', r.icsAlarm, true],
  ['ICS 5-6 节从 13:30 开始', r.icsPeriod5, true],
  ['ICS 转义分号与逗号', r.icsEscapedSummary, true],
  ['ICS 换行转义为 \\n', r.icsEscapedNote, true],
  ['ICS 节次映射到时间', r.icsTime, true],
  ['ICS 无法解析节次退化为全天', r.icsAllDay, true],
  ['ICS 只有 CRLF', r.icsCrlfOnly, true],
  ['xmlEscape', r.xmlEscape, '&lt;a href=&quot;x&quot;&gt;&amp;'],
  ['cleanText 去控制字符', r.cleanText, 'ab'],
  ['cleanNote 统一换行并 trim', r.cleanNote, 'x\ny'],
  ['导入疑似重复按 日期+节次+名称 判定', r.dupeRows, 1],
  ['periodTimes 只保留合法项', r.periodTimesShape, '{"5-6":["13:30","15:10"]}'],
  // xlsx 生成（导出路径）
  ['xlsx 单元格 XML 转义', r.xlsxEscaped, true],
  ['xlsx 表头不加高亮样式', r.xlsxHeaderNoStyle, true],
  ['xlsx 冲突行加 s="1"、其他行不加', r.xlsxHighlighted, true],
  ['xlsx 前后空格用 xml:space 保留', r.xlsxPreserveSpace, true],
  ['xlsx 冻结首行 + autoFilter + 列宽', r.xlsxStructure, true],
  ['xlsx 无高亮/无列宽时不生成多余节点', r.xlsxNoHighlightNoCols, true],
  ['xlsx 只有表头时范围是 A1:B1', r.xlsxHeaderOnly, true],
  ['xmlEscape 去掉控制字符', r.xlsxControlChars, true],
  ['buildXlsxBlob 产出非空 Blob', r.xlsxBlobSize, true],
  ['buildXlsxBlob 的 MIME 是 spreadsheetml', r.xlsxBlobType, true],
  // 导出文件名带日期后仍可导入
  ['文件名 Z1.json → Z1', r.fileClassPlain, 'Z1'],
  ['文件名带日期 → Z1', r.fileClassDated, 'Z1'],
  ['文件名 筛选+日期 → Z1-筛选', r.fileClassFiltered, 'Z1-筛选'],
  ['文件名 xlsx 用途标签 → Z1', r.fileClassXlsx, 'Z1'],
  ['非备份文件名返回空', r.fileClassBad, '']
];

let failed = 0;
for (const [name, actual, expected] of cases) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}
assert.ok(r.icsMaxLineBytes <= 75, `iCalendar 单行超过 75 字节：${r.icsMaxLineBytes}`);
assert.deepEqual(pageErrors, [], '页面脚本不应有报错');

// 订阅文件必须与页面现场生成的 .ics 一致，否则同一节课会在日历里出现两条
const icsPath = path.join(root, 'calendars', 'Z1.ics');
assert.ok(fs.existsSync(icsPath), '缺少 calendars/Z1.ics：先运行 python tools/build.py');
const fileIcs = fs.readFileSync(icsPath, 'utf8');
const pageIcs = await page.evaluate(() => buildIcsText(experiments, 'Z1'));
const pickIcsKeys = text => (text.match(/^(?:UID|DTSTART|DTEND|SUMMARY|LOCATION)[^\r]*$/gm) || []).sort();
assert.deepEqual(pickIcsKeys(pageIcs), pickIcsKeys(fileIcs),
  '页面生成的 .ics 与构建产物 Z1.ics 不一致（UID/时间/标题必须相同）');
assert.deepEqual(
  (fileIcs.match(/^UID:[^\r]+$/gm) || []).sort(),
  (pageIcs.match(/^UID:[^\r]+$/gm) || []).sort(),
  'UID 必须完全一致，否则订阅后旧事件不会被替换'
);

await browser.close();
if (failed) {
  console.error(`\nlogic tests: ${cases.length - failed}/${cases.length} 通过`);
  process.exit(1);
}
console.log(`logic tests OK (${cases.length} cases, ${browserName})`);
