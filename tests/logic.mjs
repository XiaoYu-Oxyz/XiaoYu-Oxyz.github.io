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
  out.icsAlarm = /TRIGGER:-PT2H/.test(ics);
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
  ['ICS 含提前 2 小时提醒', r.icsAlarm, true],
  ['ICS 转义分号与逗号', r.icsEscapedSummary, true],
  ['ICS 换行转义为 \\n', r.icsEscapedNote, true],
  ['ICS 节次映射到时间', r.icsTime, true],
  ['ICS 无法解析节次退化为全天', r.icsAllDay, true],
  ['ICS 只有 CRLF', r.icsCrlfOnly, true],
  ['xmlEscape', r.xmlEscape, '&lt;a href=&quot;x&quot;&gt;&amp;'],
  ['cleanText 去控制字符', r.cleanText, 'ab'],
  ['cleanNote 统一换行并 trim', r.cleanNote, 'x\ny']
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
const icsPath = path.join(root, 'Z1.ics');
assert.ok(fs.existsSync(icsPath), '缺少 Z1.ics：先运行 python build-html.py');
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
