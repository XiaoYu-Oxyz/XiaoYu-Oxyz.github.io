// 周视图（课表）自动化测试：行数上限、跨行、分栏、配色、交互。
// 运行：node tests/week-view.mjs [--webkit]
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserName = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const browserType = browserName === 'webkit' ? webkit : chromium;
const channel = browserName === 'chromium'
  ? (process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined))
  : undefined;
const appUrl = pathToFileURL(path.join(root, 'index.html')).href + '?class=Z1';

const browser = await browserType.launch({ headless: true, ...(channel ? { channel } : {}) });
// 课表只在 ≥1120px 出现
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.stack || error.message));

const STORAGE = 'ghpages:zhizao2402:';
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return addDays(d, -((d.getDay() + 6) % 7));
}

const today = new Date();
const todayStr = ymd(today);
const tomorrowStr = ymd(addDays(today, 1));
const monday = mondayOf(today);
const dayOf = offset => ymd(addDays(monday, offset));
const todayIsSunday = today.getDay() === 0;

// 每天只放一类样本：今日、明日、重叠对、超长节次各占一天，避免互相合并成一格
const usedDays = new Set([todayStr, tomorrowStr]);
let stackDay = null;
for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
  const candidate = dayOf(offset);
  if (!usedDays.has(candidate)) { stackDay = candidate; usedDays.add(candidate); break; }
}
let capDay = null;
for (const offset of [6, 5, 4, 3, 2, 1, 0]) {
  const candidate = dayOf(offset);
  if (!usedDays.has(candidate)) { capDay = candidate; usedDays.add(candidate); break; }
}

// 覆盖：今日/明日配色、跨 6 行、跨 3 行重叠、超长节次触发上限
const entries = [
  { date: todayStr, period: '第1-2节', name: '今天的课', place: 'A101', note: '' },
  { date: tomorrowStr, period: '第5-6节', name: '明天的课', place: 'B202', note: '' },
  { date: stackDay, period: '第3-8节', name: '跨六行实验', place: 'C303', note: '' },
  { date: stackDay, period: '第5-7节', name: '重叠实验', place: 'D404', note: '' },
  { date: capDay, period: '第1-20节', name: '超长节次', place: 'E505', note: '' }
];

async function loadWeekView(list) {
  await page.goto(appUrl);
  await page.waitForSelector('#classSelect');
  await page.evaluate(({ storage, items }) => {
    localStorage.setItem(storage + 'selected-class:v1', 'Z1');
    localStorage.setItem(storage + 'classdata:v1:Z1', JSON.stringify(items));
    sessionStorage.setItem(storage + 'view:v1', 'week');
  }, { storage: STORAGE, items: list });
  await page.reload();
  await page.waitForSelector('.week-grid');
  await page.waitForFunction(() => document.querySelectorAll('.wg-item').length > 0);
}

const check = (label, ok) => {
  assert.ok(ok, label);
  console.log(`  ✓ ${label}`);
};

await loadWeekView(entries);

// ---------- 1. 行数上限与截断标记 ----------
const rows = await page.evaluate(() => [...document.querySelectorAll('.wg-slot')].map(el => el.textContent));
check(`行数上限 14（实际 ${rows.length}）`, rows.length === 14);
check('行标签就是节次本身 1…14', rows[0] === '1' && rows[13] === '14');
const clipped = await page.evaluate(() => document.querySelectorAll('.wg-clipped').length);
check('超出上限的记录被标记为截断（…）', clipped === 1);

// ---------- 2. 跨行高度 ----------
const geo = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll('.wg-item').forEach(el => {
    out[el.querySelector('b').textContent] = {
      row: `${getComputedStyle(el).gridRowStart}-${getComputedStyle(el).gridRowEnd}`,
      top: el.style.top || '',
      height: el.style.height || '',
      px: Math.round(el.getBoundingClientRect().height)
    };
  });
  return out;
});
check('第1-2节占 2 行（grid-row 2→4）', geo['今天的课'].row === '2-4');
check('超长节次被截到第 14 行（grid-row 2→16）', geo['超长节次'].row === '2-16');
// 重叠时不能用 grid-row 定位（在 .wg-stack 里按百分比），改用高度验证
check('第3-8节占满这条堆垛（6 行）', geo['跨六行实验'].height === '100%');
check('第5-7节从第 3 行开始、占 3 行', Math.abs(parseFloat(geo['重叠实验'].top) - 33.333) < 0.5 && Math.abs(parseFloat(geo['重叠实验'].height) - 50) < 0.5);
check('6 行的高度约等于 3 行的两倍', Math.abs(geo['跨六行实验'].px / geo['重叠实验'].px - 2) < 0.15);

// ---------- 3. 重叠分栏（平分宽度） ----------
const stack = await page.evaluate(() => {
  const anchor = [...document.querySelectorAll('.wg-item')].find(el => el.querySelector('b').textContent === '跨六行实验');
  const wrapper = anchor ? anchor.closest('.wg-stack') : null;
  if (!wrapper) return null;
  return [...wrapper.children].map(el => ({
    name: el.querySelector('b').textContent,
    left: parseFloat(el.style.left),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height)
  }));
});
check('重叠的两条共用同一个 .wg-stack', Array.isArray(stack) && stack.length === 2);
check('第一条从 0% 开始，第二条接在后面', stack[0].left === 0 && Math.abs(stack[0].width - stack[1].left) < 0.01);
check('宽度之和 = 100%', Math.abs(stack[0].width + stack[1].width - 100) < 0.01);
check('冲突时平分宽度（各 50%）', Math.abs(stack[0].width - 50) < 0.01 && Math.abs(stack[1].width - 50) < 0.01);
check('每条的纵向高度按各自节次（6 行 > 3 行）', stack[0].height > stack[1].height);

// ---------- 4. 配色 ----------
const colors = await page.evaluate(() => {
  const result = {};
  document.querySelectorAll('.wg-item').forEach(el => {
    const name = el.querySelector('b').textContent;
    result[name] = { bg: getComputedStyle(el).backgroundColor, cls: el.className };
  });
  return result;
});
check('今天：#ffd7d5', colors['今天的课'].bg === 'rgb(255, 215, 213)');
check('今天带 st-today 类', colors['今天的课'].cls.includes('st-today'));
if (!todayIsSunday) {
  check('明天：#d3f5d9', colors['明天的课'].bg === 'rgb(211, 245, 217)');
}
check('重叠冲突：整格琥珀 #ffe6a6', colors['跨六行实验'].bg === 'rgb(255, 230, 166)' && colors['重叠实验'].bg === 'rgb(255, 230, 166)');
check('冲突带 is-conflict 类', colors['跨六行实验'].cls.includes('is-conflict'));

// ---------- 5. 课表内置灰「已结束仅显示本周」 ----------
check('课表里复选框被禁用', await page.evaluate(() => document.getElementById('recentFilter').disabled));
check('课表里复选框标签变灰', await page.evaluate(() => document.getElementById('recentFilter').closest('label').classList.contains('is-disabled')));
await page.click('#viewListBtn');
await page.waitForFunction(() => !document.body.classList.contains('view-week'));
check('切回列表后复选框恢复可用', await page.evaluate(() => !document.getElementById('recentFilter').disabled));
await page.click('#viewWeekBtn');
await page.waitForSelector('.week-grid');

// ---------- 6. 回到本周 ----------
const currentLabel = await page.evaluate(() => document.querySelector('.week-label').textContent);
check('本周没有「回到本周」按钮', await page.evaluate(() => !document.getElementById('weekTodayBtn')));
await page.click('#weekPrevBtn');
await page.waitForFunction(() => !!document.getElementById('weekTodayBtn'));
check('翻到上一周后出现「回到本周」', true);
await page.click('#weekTodayBtn');
await page.waitForFunction(() => !document.getElementById('weekTodayBtn'));
check('点击后回到本周', (await page.evaluate(() => document.querySelector('.week-label').textContent)) === currentLabel);

// ---------- 7. 点空格添加（预填日期 + 节次） ----------
// 找一个真正露在外面的空格（中心点命中的就是它自己，说明没被实验块盖住）
const emptyCell = await page.evaluate(() => {
  for (const cell of document.querySelectorAll('.wg-cell-add')) {
    const rect = cell.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit === cell) return { date: cell.dataset.date, period: cell.dataset.period };
  }
  return null;
});
check('能找到一个未被遮挡的空格', !!emptyCell);
await page.locator(`.wg-cell-add[data-date="${emptyCell.date}"][data-period="${emptyCell.period}"]`).click();
await page.waitForSelector('#modalMask.show');
const addForm = await page.evaluate(() => ({
  date: document.getElementById('formDate').value,
  period: document.getElementById('formPeriod').value,
  focused: document.activeElement.id,
  deleteHidden: document.getElementById('modalDelete').hidden
}));
check('空格预填了该格日期', addForm.date === emptyCell.date);
check('空格预填了该格节次', addForm.period === `第${emptyCell.period}节`);
check('焦点落在实验名称', addForm.focused === 'formName');
check('添加模式下没有删除按钮', addForm.deleteHidden === true);
await page.click('#modalCancel');
await page.waitForFunction(() => !document.getElementById('modalMask').classList.contains('show'));

// ---------- 8. 点实验块编辑（带删除按钮） ----------
await page.locator('.wg-item').first().click();
await page.waitForSelector('#modalMask.show');
const editForm = await page.evaluate(() => ({
  title: document.getElementById('modalTitle').textContent,
  name: document.getElementById('formName').value,
  submit: document.getElementById('modalSubmit').textContent,
  deleteHidden: document.getElementById('modalDelete').hidden
}));
check('点实验块打开「编辑实验」', editForm.title === '编辑实验');
check('表单已预填名称', editForm.name.length > 0);
check('编辑模式下显示「删除实验」按钮', editForm.deleteHidden === false);
check('提交按钮变成「保存修改」', editForm.submit === '保存修改');
await page.click('#modalCancel');
await page.waitForFunction(() => !document.getElementById('modalMask').classList.contains('show'));

// ---------- 8b. 键盘可达：Tab 能到、回车能开 ----------
const a11y = await page.evaluate(() => {
  const grid = document.querySelector('.week-grid');
  const items = [...document.querySelectorAll('.wg-item')];
  return {
    gridRole: grid.getAttribute('role'),
    gridLabel: grid.getAttribute('aria-label'),
    focusable: items.filter(el => el.tabIndex === 0).length,
    itemRole: items[0] ? items[0].getAttribute('role') : null,
    itemLabel: items[0] ? items[0].getAttribute('aria-label') : null,
    cellsHidden: [...document.querySelectorAll('.wg-cell-add')].every(el => el.getAttribute('aria-hidden') === 'true')
  };
});
check('网格有 role=group 与"第几周/几条"的标签', a11y.gridRole === 'group' && /本周课表/.test(a11y.gridLabel));
check('实验块进入 Tab 顺序（tabindex=0）', a11y.focusable >= 1);
check('实验块 role=button 且标签含日期/节次/名称', a11y.itemRole === 'button' && /^编辑：\d{4}-\d{2}-\d{2}/.test(a11y.itemLabel));
check('装饰性空格对读屏隐藏', a11y.cellsHidden);
await page.locator('.wg-item').first().focus();
await page.keyboard.press('Enter');
await page.waitForSelector('#modalMask.show');
check('回车键也能打开编辑弹窗', (await page.evaluate(() => document.getElementById('modalTitle').textContent)) === '编辑实验');
await page.click('#modalCancel');
await page.waitForFunction(() => !document.getElementById('modalMask').classList.contains('show'));

// ---------- 8c. 课表里点「编辑实验」应切回列表 ----------
await page.click('#actionsToggle');
await page.click('#editModeBtn');
await page.waitForFunction(() => !document.body.classList.contains('view-week'));
const switched = await page.evaluate(() => ({
  editing: document.body.classList.contains('editing'),
  tableVisible: getComputedStyle(document.querySelector('.table-wrap')).display !== 'none',
  editBtnText: document.getElementById('editModeBtn').textContent.trim()
}));
check('点「编辑实验」自动切回列表', switched.tableVisible);
check('切回后确实进入编辑模式', switched.editing && switched.editBtnText === '完成');
await page.click('#editModeBtn');
await page.waitForFunction(() => !document.body.classList.contains('editing'));
await page.click('#viewWeekBtn');
await page.waitForSelector('.week-grid');
check('编辑模式下切到课表会自动退出编辑', await page.evaluate(() => !document.body.classList.contains('editing')));

// ---------- 9. 页面无脚本错误 ----------
check('无页面脚本错误', pageErrors.length === 0);
if (pageErrors.length) console.error(pageErrors.join('\n'));

await browser.close();
console.log(`week view tests OK (${browserName})`);
