import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = pathToFileURL(path.join(root, 'index.html')).href;
const browserName = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const browserType = browserName === 'webkit' ? webkit : chromium;
const channel = browserName === 'chromium'
  ? (process.env.PLAYWRIGHT_CHANNEL === 'bundled' ? undefined : (process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined)))
  : undefined;
const browser = await browserType.launch({ headless: true, ...(channel ? { channel } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.stack || error.message));

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-ui-'));
const fixture = path.join(fixtureDir, 'Z1.json');

// ---- 轮询断言：不再靠固定 sleep 猜渲染时机 ----
async function poll(check, message, timeout = 4000) {
  const startedAt = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch (e) { ok = false; }
    if (ok) return;
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${message}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const waitValue = (locator, expected) => poll(async () => (await locator.inputValue()) === String(expected), `inputValue = ${expected}`);
const waitNotValue = (locator, expected) => poll(async () => (await locator.inputValue()) !== String(expected), `inputValue ≠ ${expected}`);
const waitText = (locator, pattern) => poll(async () => pattern.test(await locator.innerText()), `innerText 匹配 ${pattern}`);
const waitAttr = (locator, name, expected) => poll(async () => (await locator.getAttribute(name)) === expected, `${name} = ${expected}`);
const waitCount = (locator, expected) => poll(async () => (await locator.count()) === expected, `count = ${expected}`);

// 对比度：深色下「下一次」行曾因规则特异性变成 1.12:1；这里留一条与真实日期无关的恒定断言
function relLum(rgb) {
  const parts = (rgb.match(/\d+/g) || []).slice(0, 3).map(Number).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
function contrastRatio(fg, bg) {
  const a = relLum(fg), c = relLum(bg);
  const hi = Math.max(a, c), lo = Math.min(a, c);
  return (hi + 0.05) / (lo + 0.05);
}
const waitVisible = (locator, expected) => poll(async () => (await locator.isVisible()) === expected, `visible = ${expected}`);
// 焦点归位走 setTimeout(0)，必须轮询，不能点完立刻断言
const waitFocus = (page, id) => poll(async () => (await page.evaluate(() => document.activeElement.id)) === id, `focus = ${id}`);

// 撤销入口：优先点状态栏按钮（覆盖交互），被跨标签页消息覆盖时直接调撤销逻辑（覆盖行为）
async function clickUndo(page) {
  const button = page.getByRole('button', { name: '撤销' });
  if (await button.count()) {
    await button.first().click();
    return;
  }
  await page.evaluate(() => undoClassOperation());
}
async function settle(page) {  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'Z1-import.json'), fixture);

async function setWeek1(value) {
  await page.evaluate(v => {
    const input = document.getElementById('week1Input');
    input.value = v;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

try {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(appUrl);
  await page.waitForSelector('#tbody tr');
  // 测试数据由 data/ 决定：条数与全局 week1 都从磁盘读，改一条实验不需要改测试。
  const globalWeek1 = JSON.parse(fs.readFileSync(path.join(root, 'data', '设置.json'), 'utf8')).week1;
  const totalZ1 = Number((await page.locator('#recentCount').innerText()).match(/共\s*(\d+)/)[1]);
  await page.uncheck('#recentFilter');
  await settle(page);

  // 表格基础语义：caption、列头 scope、移动端摘要和冲突文本。
  assert.match(await page.locator('#tableCaption').innerText(), /班级 Z1 实验安排/);
  assert.equal(await page.locator('th[scope="col"]').count(), 7);
  assert.match(await page.locator('td.cell-mobile').first().getAttribute('aria-label'), /地点/);
  assert.ok(await page.locator('tr.row-conflict .sr-only').count() > 0);
  assert.equal(await page.locator('main#main').count(), 1);
  assert.equal(await page.locator('#scheduleTable').getAttribute('tabindex'), '0');
  assert.equal(await page.locator('#tbody tr').first().getAttribute('tabindex'), '0');
  assert.match(await page.locator('#scheduleTable').getAttribute('aria-describedby'), /tableHeaderSummary/);
  assert.match(await page.locator('#tableHeaderSummary').innerText(), /日期.*周次.*星期.*节次.*实验名称.*实验地点/);
  assert.doesNotMatch(await page.locator('#tableHeaderSummary').innerText(), /删除标记/);
  assert.equal(await page.locator('#scheduleTable thead').getAttribute('aria-hidden'), null);
  assert.ok(await page.locator('#tbody tr').first().getAttribute('aria-label'));
  assert.equal(await page.locator('th.col-mark').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('td.cell-mark').first().getAttribute('aria-hidden'), 'true');
  const desktopAria = await page.locator('#scheduleTable').ariaSnapshot();
  assert.doesNotMatch(desktopAria, /删除标记|cell "操作"/);
  assert.doesNotMatch(desktopAria, /^\s*- cell$/m);
  await page.locator('#scheduleTable').focus();
  await waitFocus(page, 'scheduleTable');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TR');
  assert.ok(await page.evaluate(() => document.activeElement.getAttribute('aria-label')));
  await page.keyboard.press('Shift+Tab');
  await waitFocus(page, 'scheduleTable');
  await page.keyboard.press('ArrowDown');
  const firstFocusedRow = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    label: document.activeElement.getAttribute('aria-label')
  }));
  assert.equal(firstFocusedRow.tag, 'TR');
  assert.match(firstFocusedRow.label, /日期 .*；周次 第\d+周；星期 星期[一二三四五六日]；节次 .+；实验名称 .*；实验地点 .*；备注 .*；状态 /);
  await page.keyboard.press('ArrowDown');
  const secondRowDate = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  assert.notEqual(secondRowDate, firstFocusedRow.label);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), firstFocusedRow.label);
  await page.keyboard.press('Escape');
  await waitFocus(page, 'scheduleTable');
  await page.keyboard.press('ArrowDown');
  const rovingLabel = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  assert.equal(rovingLabel, firstFocusedRow.label);
  // roving tabindex：整张表只有 1 个行级 Tab 停靠点，Tab 直接离开表格
  const rowTabStops = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tbody tr')).filter(row => row.tabIndex === 0).length);
  assert.equal(rowTabStops, 1, 'roving tabindex 应只有 1 个行级 Tab 停靠点');
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'TR',
    'roving tabindex 下 Tab 应离开表格而不是逐行前进');
  await page.locator('#scheduleTable').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), rovingLabel);
  await page.keyboard.press('Escape');

  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#printHead').isVisible(), true);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('thead')).display), 'none');
  const printLayout = await page.evaluate(() => ({
    mark: getComputedStyle(document.querySelector('th.col-mark')).display,
    tableWidth: document.querySelector('table').getBoundingClientRect().width,
    viewportWidth: document.documentElement.clientWidth
  }));
  assert.equal(printLayout.mark, 'none');
  assert.ok(printLayout.tableWidth > printLayout.viewportWidth * 0.8, '打印表格未铺满页面宽度');
  await page.emulateMedia({ media: 'screen' });

  console.log('\u00a71 week1：非星期一被拒绝，合法的周一按班保存。');

  // 1. week1：非星期一被拒绝，合法的周一按班保存。
  const initialWeek1 = await page.locator('#week1Input').inputValue();
  assert.equal(initialWeek1, globalWeek1);

  await setWeek1('2026-09-08');
  await waitValue(page.locator('#week1Input'), initialWeek1);
  assert.match(await page.locator('#importStatus').innerText(), /不是星期一/);
  assert.match(await page.locator('#liveStatus').innerText(), /不是星期一/);

  await setWeek1('2026-09-07');
  await waitValue(page.locator('#week1Input'), '2026-09-07');

  await page.selectOption('#classSelect', 'Z2');
  await waitValue(page.locator('#week1Input'), globalWeek1);
  await page.selectOption('#classSelect', 'Z1');
  await waitValue(page.locator('#week1Input'), '2026-09-07');

  console.log('\u00a72 搜索和浏览器原生清除输入（通过 fill() 模拟清空）。');

  // 2. 搜索和浏览器原生清除输入（通过 fill('') 模拟清空）。
  await page.locator('#actionsToggle').click();
  await page.locator('#searchInput').fill('A206');
  await waitText(page.locator('#recentCount'), new RegExp(`显示 1 / 共 ${totalZ1}`));
  assert.equal(await page.locator('#tbody tr').count(), 1);
  await page.emulateMedia({ media: 'print' });
  assert.match(await page.locator('#printHead').innerText(), /1 条/);
  assert.equal(await page.locator('#tbody tr').count(), 1);
  await page.emulateMedia({ media: 'screen' });

  await page.locator('#exportBtn').click();
  await page.waitForSelector('#exportMask.show');
  assert.equal(await page.locator('#exportScopeAll').isChecked(), true);
  assert.equal(await page.locator('#exportAllCount').innerText(), String(totalZ1));
  assert.equal(await page.locator('#exportFilteredCount').innerText(), '1');
  await page.locator('#exportScopeFiltered').check();
  const filteredDownloadPromise = page.waitForEvent('download');
  await page.locator('#exportJsonChoice').click();
  const filteredDownload = await filteredDownloadPromise;
  assert.match(filteredDownload.suggestedFilename(), /^Z1-筛选-数据-\d{4}-\d{2}-\d{2}\.json$/);
  const filteredPath = await filteredDownload.path();

  // 筛选备份导入：显示警告，替换前二次确认，取消后不写入。
  await page.locator('#fileInput').setInputFiles({
    name: 'Z1-筛选.json',
    mimeType: 'application/json',
    buffer: fs.readFileSync(filteredPath)
  });
  await page.waitForSelector('#importMask.show');
  assert.equal(await page.locator('#importScopeWarning').isVisible(), true);
  assert.match(await page.locator('#importScopeWarning').innerText(), /当前筛选.*不是完整班级/);
  await page.locator('.mode-card[data-mode="replace"]').click();
  await page.locator('#importConfirm').click();
  await page.waitForSelector('#confirmMask.show');
  assert.match(await page.locator('#confirmDetail').innerText(), /替换会清空/);
  await page.locator('#confirmCancel').click();
  await settle(page);
  await page.locator('#importCancel').click();
  await waitVisible(page.locator('#importMask'), false);

  // xlsx 筛选备份同样识别导出范围并警告。
  await page.locator('#exportBtn').click();
  await page.waitForSelector('#exportMask.show');
  await page.locator('#exportScopeFiltered').check();
  const filteredXlsxPromise = page.waitForEvent('download');
  await page.locator('#exportXlsxChoice').click();
  const filteredXlsx = await filteredXlsxPromise;
  assert.match(filteredXlsx.suggestedFilename(), /^Z1-筛选-实验安排-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const filteredXlsxPath = await filteredXlsx.path();
  await page.locator('#fileInput').setInputFiles({
    name: 'Z1-筛选.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: fs.readFileSync(filteredXlsxPath)
  });
  await page.waitForSelector('#importMask.show');
  assert.equal(await page.locator('#importScopeWarning').isVisible(), true);
  assert.match(await page.locator('#importScopeWarning').innerText(), /当前筛选.*不是完整班级/);
  await page.locator('#importCancel').click();
  await settle(page);

  // 日历导出：标准 VCALENDAR，每条实验一个事件 + 提前 2 小时提醒。
  const icsTotal = Number((await page.locator('#recentCount').innerText()).match(/共\s*(\d+)/)[1]);
  const icsPromise = page.waitForEvent('download');
  await page.locator('#icsBtn').click();
  const icsFile = await icsPromise;
  assert.match(icsFile.suggestedFilename(), /^Z1-实验课-\d{4}-\d{2}-\d{2}\.ics$/);
  const icsText = fs.readFileSync(await icsFile.path(), 'utf8');
  assert.match(icsText, /^BEGIN:VCALENDAR\r\n/);
  assert.match(icsText, /BEGIN:VTIMEZONE/);
  assert.match(icsText, /DTSTART;TZID=Asia\/Shanghai:\d{8}T\d{6}/);
  assert.match(icsText, /BEGIN:VALARM/);
  assert.equal((icsText.match(/BEGIN:VEVENT/g) || []).length, icsTotal);
  assert.ok(icsText.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(Math.max(...icsText.split('\r\n').map(line => Buffer.byteLength(line, 'utf8'))) <= 75,
    'iCalendar 单行不能超过 75 字节');

  // 诊断信息：复制成功给状态提示；剪贴板不可用时退化为可手动复制的文本框
  await page.locator('#diagBtn').click();
  await poll(async () => {
    if (await page.locator('#copyMask').isVisible()) return true;
    const status = await page.locator('#importStatus').innerText().catch(() => '');
    return status.includes('诊断信息已复制');
  }, '诊断信息应复制成功或弹出兜底文本框');
  if (await page.locator('#copyMask').isVisible()) {
    assert.match(await page.locator('#copyFallbackText').inputValue(), /诊断信息/);
    await page.locator('#copyFallbackDone').click();
    await waitVisible(page.locator('#copyMask'), false);
  }

  await page.locator('#searchInput').fill('');  await waitText(page.locator('#recentCount'), new RegExp(`显示 25 / 共 ${totalZ1}`));

  console.log('\u00a73 导出格式选择器：初始焦点、Tab 循环、Esc 关闭并回到触发按钮。');

  // 3. 导出格式选择器：初始焦点、Tab 循环、Esc 关闭并回到触发按钮。
  await page.locator('#exportBtn').click();
  await page.waitForSelector('#exportMask.show');
  await settle(page);
  await waitFocus(page, 'exportXlsxChoice');
  assert.equal(await page.locator('#exportScopeAll').isChecked(), true);
  assert.equal(await page.locator('#exportAllCount').innerText(), String(totalZ1));
  assert.equal(await page.locator('#exportFilteredCount').innerText(), '25');
  await page.locator('#exportCancel').focus();
  await page.keyboard.press('Tab');
  await waitFocus(page, 'exportClose');
  await page.keyboard.press('Escape');
  await waitVisible(page.locator('#exportMask'), false);
  await waitFocus(page, 'exportBtn');

  await page.locator('#exportBtn').click();
  await page.waitForSelector('#exportMask.show');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportJsonChoice').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^Z1-数据-\d{4}-\d{2}-\d{2}\.json$/);

  console.log('\u00a74 导入 JSON，再用“撤销导入”恢复导入前的班级。');

  // 4. 导入 JSON，再用“撤销导入”恢复导入前的班级。
  await page.locator('#fileInput').setInputFiles(fixture);
  await page.waitForSelector('#importMask.show');
  assert.match(await page.locator('#importSummary').innerText(), /有效记录 1 条/);
  assert.match(await page.locator('#importSummary').innerText(), /来源：JSON/);
  assert.match(await page.locator('#importSummary').innerText(), /week1：2026-09-07（不变）/);
  await page.locator('#importConfirm').click();
  await waitText(page.locator('#importStatus'), /撤销导入/);
  assert.equal(await page.locator('#week1Input').inputValue(), '2026-09-07');
  assert.equal(await page.locator('#tbody').innerText().then(t => t.includes('UI冒烟实验')), true);

  await page.getByRole('button', { name: '撤销导入' }).click();
  await waitText(page.locator('#recentCount'), new RegExp(`显示 25 / 共 ${totalZ1}`));
  assert.equal(await page.locator('#tbody').innerText().then(t => t.includes('UI冒烟实验')), false);
  assert.equal(await page.locator('#week1Input').inputValue(), '2026-09-07');

  console.log('\u00a74 表格按列关联表头；编辑/删除按钮读出完整实验数据。');

  // 4. 表格按列关联表头；编辑/删除按钮读出完整实验数据。
  assert.equal(await page.locator('th#col-date[scope="col"]').count(), 1);
  assert.equal(await page.locator('th#col-place[scope="col"]').count(), 1);
  const firstRowHeaders = await page.locator('#tbody tr').first().locator('td').evaluateAll(
    cells => cells.map(td => td.getAttribute('headers'))
  );
  assert.ok(firstRowHeaders.includes('col-date'));
  assert.ok(firstRowHeaders.includes('col-week'));
  assert.ok(firstRowHeaders.includes('col-weekday'));
  assert.ok(firstRowHeaders.includes('col-period'));
  assert.ok(firstRowHeaders.includes('col-name'));
  assert.ok(firstRowHeaders.includes('col-place'));

  await page.locator('#editModeBtn').click();
  await waitAttr(page.locator('th.col-mark'), 'aria-hidden', null);
  assert.equal(await page.locator('td.cell-mark').first().getAttribute('aria-hidden'), null);
  await page.locator('#tbody tr').first().focus();
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(() => document.activeElement.className), /edit-row-btn/);
  const firstEditBtn = page.locator('.edit-row-btn').first();
  const editLabel = await firstEditBtn.getAttribute('aria-label');
  assert.match(editLabel, /日期 .*；周次 第\d+周；星期 .+；节次 .+；实验名称 .*；实验地点 .*；备注 .*；状态 /);
  await firstEditBtn.click();
  await page.waitForSelector('#modalMask.show');
  assert.match(await page.locator('#editA11ySummary').innerText(), /日期 .*周次.*节次.*实验名称/);
  assert.equal(await page.locator('#modalMask .modal').getAttribute('aria-describedby'), 'editA11ySummary');
  await page.locator('#modalClose').click();
  await settle(page);
  await page.locator('#editModeBtn').click();
  await settle(page);
  assert.equal(await page.locator('td.cell-mark').first().getAttribute('aria-hidden'), 'true');

  await page.locator('#deleteModeBtn').click();
  await waitAttr(page.locator('th.col-mark'), 'aria-hidden', null);
  await page.locator('#tbody tr').first().focus();
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(() => document.activeElement.className), /mark-btn/);
  const firstMarkBtn = page.locator('.mark-btn').first();
  const markLabel = await firstMarkBtn.getAttribute('aria-label');
  assert.match(markLabel, /标记为待删除：日期 .*；周次 第\d+周；星期 .+；节次 .+；实验名称 .*；实验地点 .*；备注 .*；状态 /);
  await firstMarkBtn.click();
  assert.equal(await firstMarkBtn.getAttribute('aria-pressed'), 'true');
  assert.match(await firstMarkBtn.getAttribute('aria-label'), /取消删除标记：日期 .*；实验名称/);
  await firstMarkBtn.click();
  assert.equal(await firstMarkBtn.getAttribute('aria-pressed'), 'false');
  await page.locator('#deleteModeBtn').click();
  await waitAttr(page.locator('th.col-mark'), 'aria-hidden', 'true');

  console.log('\u00a73 5 表单校验：错误必须绑到具体字段（aria-invalid + aria-describedby）');

  // 3. 5 表单校验：错误必须绑到具体字段（aria-invalid + aria-describedby），并聚焦第一个出错项。
  //     只给 live region 播报是不够的——读屏用户回到输入框时就听不到原因了。
  await page.locator('#actionsToggle').click();
  if (!(await page.locator('#addBtn').isVisible())) {
    // 面板本来就是开着的：再点一次会关掉，补一次
    await page.locator('#actionsToggle').click();
  }
  await page.locator('#addBtn').click();
  await page.waitForSelector('#modalMask.show');
  await page.locator('#modalSubmit').click();
  await settle(page);
  assert.equal(await page.locator('#formPeriod').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#formName').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#formName').getAttribute('aria-describedby'), 'formError');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'formPeriod');
  assert.equal(await page.locator('#formDate').getAttribute('aria-invalid'), null);
  // 动手改过的字段立刻解除自己的错误标记，另一个字段保持不变
  await page.locator('#formPeriod').fill('第3-4节');
  await settle(page);
  assert.equal(await page.locator('#formPeriod').getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#formName').getAttribute('aria-invalid'), 'true');
  await page.locator('#modalCancel').click();
  await settle(page);
  // 收起操作面板，免得挡住后面要点的班级按钮
  if (await page.locator('#addBtn').isVisible()) {
    await page.locator('#actionsToggle').click();
    await settle(page);
  }

  console.log('\u00a74 班级管理：新建、重命名、删除本机班级；内置班级只提示。');

  // 4. 班级管理：新建、重命名、删除本机班级；内置班级只提示。
  await page.locator('#newClassBtn').click();
  await page.waitForSelector('#classMask.show');
  await page.locator('#classPromptInput').fill('测试班');
  await page.locator('#classPromptOk').click();
  await waitValue(page.locator('#classSelect'), '测试班');

  await page.locator('#renameClassBtn').click();
  await page.waitForSelector('#classMask.show');
  assert.equal(await page.locator('#classPromptInput').inputValue(), '测试班');
  await page.locator('#classPromptInput').fill('测试班2');
  await page.locator('#classPromptOk').click();
  await waitValue(page.locator('#classSelect'), '测试班2');

  await page.locator('#deleteClassBtn').click();
  await page.waitForSelector('#confirmMask.show');
  await page.locator('#confirmOk').click();
  await waitNotValue(page.locator('#classSelect'), '测试班2');
  assert.equal(await page.locator('#classSelect option[value="测试班2"]').count(), 0);

  await page.selectOption('#classSelect', 'Z1');

  console.log('\u00a75 复制兜底：强制剪贴板失败，出现只读文本框。');

  // 5. 复制兜底：强制剪贴板失败，出现只读文本框。
  await page.evaluate(() => {
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) }
      });
    } catch (e) {}
    document.execCommand = () => false;
  });
  await page.locator('#copyWeekBtn').click();
  await page.waitForSelector('#copyMask.show');
  assert.match(await page.locator('#copyFallbackText').inputValue(), /实验课提醒/);
  await page.locator('#copyFallbackDone').click();
  await waitVisible(page.locator('#copyMask'), false);

  // 5b. 纠错回路：剪贴板不可用时同样退化成只读文本框，
  //     内容必须能直接贴进群里（班级 + 页面 + 具体某一条 + 待补充项）。
  await page.locator('#feedbackBtn').click();
  await page.waitForSelector('#copyMask.show');
  const feedbackText = await page.locator('#copyFallbackText').inputValue();
  assert.match(feedbackText, /【CrseCue · 反馈】/);
  assert.match(feedbackText, /班级：Z1/);
  assert.match(feedbackText, /我看到的是：\d{4}-\d{2}-\d{2}/);
  assert.match(feedbackText, /应该改为：/);
  await page.locator('#copyFallbackDone').click();
  await waitVisible(page.locator('#copyMask'), false);

  console.log('\u00a76 跨标签页：另一个页面修改 Z1 week1，当前页自动同步。');

  // 6. 跨标签页：另一个页面修改 Z1 week1，当前页自动同步。
  const secondPage = await page.context().newPage();
  await secondPage.goto(appUrl);
  await secondPage.waitForSelector('#tbody tr');
  await secondPage.evaluate(() => {
    const input = document.getElementById('week1Input');
    input.value = '2026-09-14';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitValue(page.locator('#week1Input'), '2026-09-14');

  await secondPage.evaluate(() => {
    saveClassStored('Z1', [{
      date: '2026-12-01',
      period: '第1-2节',
      name: '跨标签数据',
      place: 'A101',
      note: ''
    }]);
  });
  await waitText(page.locator('#tbody'), /跨标签数据/);

  await secondPage.close();

  // 班级切换提示放在独立上下文，避免影响后续主页面状态。
  const switchContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const switchA = await switchContext.newPage();
  const switchB = await switchContext.newPage();
  await Promise.all([switchA.goto(appUrl), switchB.goto(appUrl)]);
  await Promise.all([switchA.waitForSelector('#tbody tr'), switchB.waitForSelector('#tbody tr')]);
  await switchB.selectOption('#classSelect', 'Z2');
  await waitText(switchA.locator('#importStatus'), /另一个标签页已切换到 Z2/);
  await switchContext.close();

  console.log('\u00a77 手机端只显示“导入/导出”，且无横向滚动。');

  // 7. 手机端只显示“导入/导出”，且无横向滚动。
  await page.setViewportSize({ width: 320, height: 844 });
  await page.reload();
  await page.waitForSelector('#tbody tr');
  await page.locator('#actionsToggle').click();
  assert.equal((await page.locator('#importBtn').innerText()).trim(), '导入');
  assert.equal((await page.locator('#exportBtn').innerText()).trim(), '导出');
  const theadDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('thead')).display);
  assert.notEqual(theadDisplay, 'none');
  assert.equal(await page.locator('#scheduleTable thead').getAttribute('aria-hidden'), null);
  assert.match(await page.locator('#scheduleTable').getAttribute('aria-describedby'), /tableHeaderSummary/);
  assert.equal(await page.locator('#tableHeaderSummary').getAttribute('aria-hidden'), null);
  assert.ok(await page.locator('#tbody tr').first().getAttribute('aria-label'));
  assert.ok(await page.locator('#tbody td[headers]').count() > 0);
  assert.equal(await page.locator('td.cell-mobile').first().locator(':scope > *').first().getAttribute('aria-hidden'), 'true');
  const mobileAria = await page.locator('#scheduleTable').ariaSnapshot();
  assert.match(mobileAria, /columnheader/);
  assert.doesNotMatch(mobileAria, /^\s*- cell$/m);
  await page.selectOption('#classSelect', 'Z2');
  await waitAttr(page.locator('#scheduleTable thead'), 'aria-hidden', null);
  assert.ok(await page.locator('#tbody tr').first().getAttribute('aria-label'));
  assert.ok(await page.locator('#tbody td[headers]').count() > 0);
  await page.selectOption('#classSelect', 'Z1');
  await settle(page);
  await page.setViewportSize({ width: 1200, height: 900 });
  await waitAttr(page.locator('#scheduleTable thead'), 'aria-hidden', null);
  assert.match(await page.locator('#scheduleTable').getAttribute('aria-describedby'), /tableHeaderSummary/);
  assert.equal(await page.locator('#tableHeaderSummary').getAttribute('aria-hidden'), null);
  assert.ok(await page.locator('#tbody tr').first().getAttribute('aria-label'));
  assert.ok(await page.locator('#tbody td[headers]').count() > 0);
  assert.equal(await page.locator('td.cell-mobile').first().locator(':scope > *').first().getAttribute('aria-hidden'), 'true');
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  assert.ok(sizes.scrollWidth <= sizes.clientWidth, `320px 横向滚动: ${sizes.scrollWidth} > ${sizes.clientWidth}`);
  const toolBox = await page.locator('#newClassBtn').boundingBox();
  assert.ok(toolBox && toolBox.width >= 36 && toolBox.height >= 36, '班级图标热区小于 36px');

  assert.deepEqual(pageErrors, []);

  console.log('\u00a78 内置班级：警告后可重命名/删除（本机隐藏），并支持撤销与恢复。');

  // 8. 内置班级：警告后可重命名/删除（本机隐藏），并支持撤销与恢复。
  const builtPage = await context.newPage();
  await builtPage.goto(appUrl);
  await builtPage.waitForSelector('#tbody tr');
  await builtPage.selectOption('#classSelect', 'Z1');

  await builtPage.locator('#renameClassBtn').click();
  await builtPage.waitForSelector('#confirmMask.show');
  assert.match(await builtPage.locator('#confirmDetail').innerText(), /隐藏原班/);
  await builtPage.locator('#confirmOk').click();
  await builtPage.waitForSelector('#classMask.show');
  await builtPage.locator('#classPromptInput').fill('Z1本机');
  await builtPage.locator('#classPromptOk').click();
  await waitValue(builtPage.locator('#classSelect'), 'Z1本机');
  assert.equal(await builtPage.locator('#classSelect option[value="Z1"]').count(), 0);
  // 状态栏可能被跨标签页同步消息随时覆盖，所以断言应用内部的"可撤销快照"，
  // 有按钮就点按钮（覆盖交互），没有就直接调用撤销逻辑（覆盖行为）。
  await poll(() => builtPage.evaluate(() => !!lastClassUndo), '重命名后应存在可撤销快照');
  await clickUndo(builtPage);
  await waitValue(builtPage.locator('#classSelect'), 'Z1');
  assert.equal(await builtPage.locator('#classSelect option[value="Z1"]').count(), 1);
  assert.equal(await builtPage.locator('#classSelect option[value="Z1本机"]').count(), 0);

  await builtPage.locator('#deleteClassBtn').click();
  await builtPage.waitForSelector('#confirmMask.show');
  assert.match(await builtPage.locator('#confirmDetail').innerText(), /隐藏/);
  await builtPage.locator('#confirmOk').click();
  await waitCount(builtPage.locator('#classSelect option[value="Z1"]'), 0);
  // 状态栏可能被跨标签页消息覆盖，这里只断言"班级已被隐藏"，撤销走统一入口
  await poll(() => builtPage.evaluate(() => !!lastClassUndo), '删除后应存在可撤销快照');
  await clickUndo(builtPage);
  await waitValue(builtPage.locator('#classSelect'), 'Z1');

  // 删除到没有班级：允许空状态，并可撤销最后一次隐藏。
  for (const id of ['Z1', 'Z2', 'Z5']) {
    await builtPage.locator('#deleteClassBtn').click();
    await builtPage.waitForSelector('#confirmMask.show');
    await builtPage.locator('#confirmOk').click();
    await settle(builtPage);
  }
  assert.equal(await builtPage.locator('#classSelect').inputValue(), '');
  assert.match(await builtPage.locator('#classSelect').innerText(), /无班级/);
  assert.equal(await builtPage.locator('#recentCount').innerText(), '显示 0 / 共 0');
  assert.equal(await builtPage.locator('#addBtn').isDisabled(), true);
  await clickUndo(builtPage);
  await waitValue(builtPage.locator('#classSelect'), 'Z5');

  // 重命名不能占用已隐藏的内置班名称。
  await builtPage.locator('#newClassBtn').click();
  await builtPage.waitForSelector('#classMask.show');
  await builtPage.locator('#classPromptInput').fill('测试重名');
  await builtPage.locator('#classPromptOk').click();
  await waitValue(builtPage.locator('#classSelect'), '测试重名');
  await builtPage.locator('#renameClassBtn').click();
  await builtPage.waitForSelector('#classMask.show');
  await builtPage.locator('#classPromptInput').fill('Z1');
  await builtPage.locator('#classPromptOk').click();
  await builtPage.waitForSelector('#confirmMask.show');
  assert.match(await builtPage.locator('#confirmDetail').innerText(), /必须先删除这个同名班级/);
  await builtPage.locator('#confirmOk').click();
  await waitValue(builtPage.locator('#classSelect'), 'Z1');

  // 同名本机班存在时，恢复隐藏班会报错并要求先删除。
  await builtPage.locator('#restoreToolBtn').click();
  await builtPage.waitForSelector('#restoreMask.show');
  await builtPage.getByRole('button', { name: '恢复 Z1' }).click();
  await waitText(builtPage.locator('#restoreError'), /请先删除该班/);
  await builtPage.locator('#restoreDone').click();

  // 删除同名本机班后，隐藏的内置班才能恢复。
  await builtPage.locator('#deleteClassBtn').click();
  await builtPage.waitForSelector('#confirmMask.show');
  await builtPage.locator('#confirmOk').click();
  await settle(builtPage);
  await builtPage.locator('#restoreToolBtn').click();
  await builtPage.waitForSelector('#restoreMask.show');
  await builtPage.getByRole('button', { name: '恢复 Z1' }).click();
  await waitValue(builtPage.locator('#classSelect'), 'Z1');
  assert.equal(await builtPage.locator('#classSelect option[value="Z1"]').count(), 1);

  await builtPage.locator('#restoreToolBtn').click();
  await builtPage.waitForSelector('#restoreMask.show');
  assert.equal(await builtPage.locator('#restoreDefaultBtn').isDisabled(), false);
  await builtPage.locator('#restoreDefaultBtn').click();
  await builtPage.waitForSelector('#confirmMask.show');
  await builtPage.locator('#confirmOk').click();
  await waitText(builtPage.locator('#importStatus'), /恢复为默认数据/);

  // 隐藏/空状态刷新后仍保持，并可从恢复弹窗找回。
  while (await builtPage.locator('#classSelect').inputValue()) {
    await builtPage.locator('#deleteClassBtn').click();
    await builtPage.waitForSelector('#confirmMask.show');
    await builtPage.locator('#confirmOk').click();
    await settle(builtPage);
  }
  await builtPage.reload();
  await builtPage.waitForSelector('#tbody tr');
  assert.equal(await builtPage.locator('#classSelect').inputValue(), '');
  assert.match(await builtPage.locator('#classSelect').innerText(), /无班级/);
  assert.equal(await builtPage.locator('#recentCount').innerText(), '显示 0 / 共 0');
  await builtPage.locator('#restoreToolBtn').click();
  await builtPage.waitForSelector('#restoreMask.show');
  assert.match(await builtPage.locator('#restoreHiddenList').innerText(), /Z1/);
  await builtPage.getByRole('button', { name: '恢复 Z1' }).click();
  await waitValue(builtPage.locator('#classSelect'), 'Z1');
  await builtPage.close();

  // 键盘 /：展开面板并聚焦搜索框；在输入框里按 / 不应被劫持
  const searchPage = await context.newPage();
  await searchPage.goto(appUrl);
  await searchPage.waitForSelector('#tbody tr');
  assert.equal(await searchPage.locator('#actionPanel').isVisible(), false);
  await searchPage.keyboard.press('/');
  await searchPage.waitForSelector('#actionPanel:not([hidden])');
  await waitFocus(searchPage, 'searchInput');
  await searchPage.keyboard.press('/');
  assert.equal(await searchPage.locator('#searchInput').inputValue(), '/');
  await searchPage.close();

  // 首次访问提示：全新 context（无 localStorage）时出现，切班后消失且不再打扰
  const freshCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshCtx.newPage();
  await freshPage.goto(appUrl);
  await freshPage.waitForSelector('#tbody tr');
  assert.equal(await freshPage.locator('#firstRunHint').isVisible(), true);
  assert.match(await freshPage.locator('#firstRunHint').innerText(), /班级/);
  await freshPage.selectOption('#classSelect', 'Z2');
  await waitVisible(freshPage.locator('#firstRunHint'), false);
  await freshPage.reload();
  await freshPage.waitForSelector('#tbody tr');
  assert.equal(await freshPage.locator('#firstRunHint').isVisible(), false);
  await freshCtx.close();

  console.log('\u00a79 只读链接 ?mode=ro：不写本机数据，隐藏所有编辑入口，并显示"只读"徽标。');

  // 9. 只读链接 ?mode=ro：不写本机数据，隐藏所有编辑入口，并显示"只读"徽标。
  const roPage = await context.newPage();
  await roPage.goto(`${appUrl}?mode=ro`);
  await roPage.waitForSelector('#tbody tr');
  assert.equal(await roPage.evaluate(() => document.body.classList.contains('readonly')), true);
  assert.equal(await roPage.locator('#modeBadge').innerText(), '只读');
  assert.equal(await roPage.locator('#newClassBtn').isVisible(), false);
  assert.equal(await roPage.locator('#addBtn').isVisible(), false);
  assert.equal(await roPage.locator('#importBtn').isVisible(), false);
  assert.equal(await roPage.locator('#week1Input').isVisible(), false);
  // 操作面板默认收起：展开后确认"实验"整组被隐藏、"导出"仍在
  await roPage.locator('#actionsToggle').click();
  await roPage.waitForSelector('#actionPanel:not([hidden])');
  assert.equal(await roPage.locator('#exportBtn').isVisible(), true);
  assert.equal(await roPage.locator('#icsBtn').isVisible(), true);
  assert.equal(await roPage.locator('.action-group-edit').isVisible(), false);
  await roPage.close();

  console.log('\u00a710 横屏（640×360）：两列卡片布局下交互仍然可用。');

  // 10. 横屏（640×360）：两列卡片布局下交互仍然可用。
  //     这类问题视觉冒烟看不出来（它只量几何），必须真的点一遍。
  const landCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const landPage = await landCtx.newPage();
  const landErrors = [];
  landPage.on('pageerror', error => landErrors.push(error.message));
  await landPage.goto(`${appUrl}?class=Z1`);
  await landPage.waitForSelector('#tbody tr');
  const landLayout = await landPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#tbody tr')).filter(r => !r.classList.contains('note-row'));
    const lefts = Array.from(new Set(rows.map(r => Math.round(r.getBoundingClientRect().left)))).sort((a, b) => a - b);
    const weekStarts = rows.filter(r => r.classList.contains('week-start'));
    return {
      cols: lefts.length,
      // 换周必须落到新一行的左列（否则两列会把不同周并排）
      weekStartOnRight: weekStarts.filter(r => Math.round(r.getBoundingClientRect().left) !== lefts[0]).length,
      // 卡片不许有 margin：两列里任何 margin 都会把同一排的另一张顶歪
      margins: Array.from(new Set(rows.map(r => getComputedStyle(r).marginTop)))
    };
  });
  assert.equal(landLayout.cols, 2, '横屏应为两列卡片');
  assert.equal(landLayout.weekStartOnRight, 0, '换周应掉到新一行的左列');
  assert.deepEqual(landLayout.margins, ['0px'], `卡片不应有 margin-top：${landLayout.margins.join(',')}`);
  // 编辑模式下的行首铅笔可点开弹窗
  await landPage.locator('#actionsToggle').click();
  await landPage.locator('#editModeBtn').click();
  await landPage.waitForSelector('.edit-row-btn', { state: 'visible' });
  await landPage.locator('.edit-row-btn').first().click();
  await landPage.waitForSelector('#modalMask.show');
  assert.equal(await landPage.locator('#modalTitle').innerText(), '编辑实验');
  await landPage.locator('#modalCancel').click();
  await landPage.locator('#editModeBtn').click();
  assert.deepEqual(landErrors, [], '横屏下有脚本错误');
  await landCtx.close();

  console.log('\u00a711 链接里的班级不存在 → 跳 404 说明情况，不要静默换成别的班。');

  // 11. 链接里的班级不存在 → 跳 404 说明情况，不要静默换成别的班。
  const badCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const badPage = await badCtx.newPage();
  await badPage.goto(`${appUrl}?class=不存在的班级`);
  await badPage.waitForURL(url => url.pathname.endsWith('/404.html'), { timeout: 8000 });
  assert.match(await badPage.locator('#errTitle').innerText(), /班级链接失效了/);
  assert.match(await badPage.locator('#errDesc').innerText(), /不存在的班级/);
  await badCtx.close();

  console.log('\u00a712 跨天自动刷新：页面挂一夜后，时钟、"今天/明天"标签、提示条必须一起对齐。');

  // 12. 跨天自动刷新：页面挂一夜后，时钟、"今天/明天"标签、提示条必须一起对齐。
  const midnightCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const midnightPage = await midnightCtx.newPage();
  await midnightPage.clock.install({ time: new Date('2026-11-14T22:00:00') });
  await midnightPage.addInitScript(() => {
    localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify([
      { date: '2026-11-14', period: '第5-6节', name: '跨天实验A', place: 'A101', note: '' },
      { date: '2026-11-15', period: '第3-4节', name: '跨天实验B', place: 'A102', note: '' }
    ]));
  });
  await midnightPage.goto(`${appUrl}?class=Z1`);
  await midnightPage.waitForSelector('#tbody tr');
  const badgeOf = name => midnightPage.evaluate(n => {
    const row = Array.from(document.querySelectorAll('#tbody tr')).find(r => r.textContent.includes(n));
    if (!row) return null;
    const tag = row.querySelector('.tag-today, .tag-tomorrow, .tag-past, .tag-next');
    return tag ? tag.textContent : '';
  }, name);
  assert.equal(await badgeOf('跨天实验A'), '今天');
  assert.equal(await badgeOf('跨天实验B'), '明天');
  await midnightPage.clock.fastForward('03:00:00');   // 跨到 11-15 01:00
  await midnightPage.waitForTimeout(900);
  assert.match(await midnightPage.locator('#clock').innerText(), /2026-11-15/);
  assert.equal(await badgeOf('跨天实验A'), '已结束');
  assert.equal(await badgeOf('跨天实验B'), '今天');
  assert.match(await midnightPage.locator('#cueText').innerText(), /第3-4节/);
  await midnightCtx.close();

  console.log('\u00a713 冲突（卡片布局）：2px 方角描边 + 同组最短连线，不靠文字表达。');

  // 13. 冲突（卡片布局）：2px 方角描边 + 同组最短连线，不靠文字表达。
  const confCtx = await browser.newContext({ viewport: { width: 800, height: 900 } });
  const confPage = await confCtx.newPage();
  await confPage.goto(`${appUrl}?class=Z2`);
  await confPage.waitForSelector('#tbody tr');
  await confPage.waitForTimeout(350);
  const conflict = await confPage.evaluate(() => {
    const row = document.querySelector('tr.row-conflict');
    const cs = row ? getComputedStyle(row) : null;
    const lines = Array.from(document.querySelectorAll('.conflict-link-line')).map(line => Math.hypot(
      Number(line.getAttribute('x2')) - Number(line.getAttribute('x1')),
      Number(line.getAttribute('y2')) - Number(line.getAttribute('y1'))
    ));
    return {
      borderWidth: cs ? cs.borderTopWidth : null,
      borderStyle: cs ? cs.borderTopStyle : null,
      radius: cs ? cs.borderTopLeftRadius : null,
      shadow: cs ? cs.boxShadow : null,
      lines: lines.map(n => Number(n.toFixed(1)))
    };
  });
  // 视觉 2px = 1px 边框 + 1px 内阴影；用 2px 边框会让相邻卡片文字错位 1px
  assert.equal(conflict.borderWidth, '1px', '冲突卡边框应为 1px（视觉 2px 由内阴影补足）');
  assert.match(conflict.shadow, /inset/, '冲突卡应有内阴影补足视觉厚度');
  assert.equal(conflict.borderStyle, 'solid');
  assert.equal(conflict.radius, '0px', '卡片是方角，描边也跟着方角');
  assert.ok(conflict.lines.length >= 1, '冲突组应画出连线');
  assert.ok(conflict.lines.every(n => n <= 40), `连线应是最短线段：${conflict.lines.join(',')}`);
  await confCtx.close();

  console.log('\u00a714 按钮只用"文字色 + 边框色"表达：亮色底纯白、暗色底纯黑，不允许彩色填充。');

  // 14. 按钮只用"文字色 + 边框色"表达：亮色底纯白、暗色底纯黑，不允许彩色填充。
  const styleCtx = await browser.newContext({ viewport: { width: 360, height: 792 } });
  const stylePage = await styleCtx.newPage();
  await stylePage.emulateMedia({ colorScheme: 'light' });
  await stylePage.goto(`${appUrl}?class=Z2`);
  await stylePage.waitForSelector('#tbody tr');
  await stylePage.locator('#actionsToggle').click();
  await stylePage.locator('#editModeBtn').click();
  // 按钮有 .15s 的颜色过渡：读样式前必须等它走完，否则读到的是插值色
  await stylePage.waitForTimeout(400);
  const btnColors = () => stylePage.evaluate(() => {
    const take = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor };
    };
    return {
      add: take('#addBtn'),
      importBtn: take('#importBtn'),
      editActive: take('#editModeBtn'),
      del: take('#deleteModeBtn'),
      ghost: take('#exportBtn'),
      toggle: take('#actionsToggle'),
      rowIcon: take('.edit-row-btn')
    };
  });
  const light = await btnColors();
  for (const [name, value] of Object.entries(light)) {
    if (!value) continue;
    assert.equal(value.bg, 'rgb(255, 255, 255)', `亮色按钮 ${name} 底色应为纯白，实际 ${value.bg}`);
    assert.notEqual(value.fg, value.bg, `亮色按钮 ${name} 的文字不能和底色相同`);
  }
  // 主操作 / 激活态必须是"有色边框 + 同色文字"
  assert.equal(light.add.fg, light.add.border, '添加实验的边框与文字应同色');
  assert.equal(light.editActive.fg, light.editActive.border, '编辑激活态的边框与文字应同色');

  await stylePage.emulateMedia({ colorScheme: 'dark' });
  await stylePage.waitForTimeout(400);
  const dark = await btnColors();
  for (const [name, value] of Object.entries(dark)) {
    if (!value) continue;
    assert.equal(value.bg, 'rgb(0, 0, 0)', `暗色按钮 ${name} 底色应为纯黑，实际 ${value.bg}`);
    assert.notEqual(value.fg, value.bg, `暗色按钮 ${name} 的文字不能和底色相同`);
  }
  await styleCtx.close();

  console.log('\u00a715 冷启动定位：能看见就不动（只标记），看不全才用最小距离滚到"那天所有条都完整可见"。');

  // 15. 冷启动定位：能看见就不动（只标记），看不全才用最小距离滚到"那天所有条都完整可见"。
  const locateRows = [];
  for (let d = 9; d <= 13; d += 1) {
    locateRows.push({ date: `2026-11-${d}`, period: '第1-2节', name: `本周A${d}`, place: 'P', note: '' });
    locateRows.push({ date: `2026-11-${d}`, period: '第5-6节', name: `本周B${d}`, place: 'P', note: '' });
  }
  locateRows.push({ date: '2026-11-20', period: '第1-2节', name: '目标A', place: 'Q', note: '' });
  locateRows.push({ date: '2026-11-20', period: '第3-4节', name: '目标B', place: 'Q', note: '' });

  async function openLocated(viewport, data, viewState) {
    const locateCtx = await browser.newContext({ viewport });
    const locatePage = await locateCtx.newPage();
    await locatePage.clock.install({ time: new Date('2026-11-14T12:00:00') });
    await locatePage.addInitScript(([rows, view]) => {
      localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
      if (view) localStorage.setItem('ghpages:zhizao2402:view:v1', view);
    }, [data, viewState]);
    const read = () => locatePage.evaluate(() => {
      const rects = Array.from(document.querySelectorAll('tbody tr[data-idx]'))
        .filter(row => /目标/.test(row.textContent))
        .map(row => row.getBoundingClientRect());
      return {
        scrollY: Math.round(window.scrollY),
        count: rects.length,
        allVisible: rects.every(rect => rect.top >= -1 && rect.bottom <= window.innerHeight + 1)
      };
    });
    await locatePage.goto(`${appUrl}?class=Z1`);
    await locatePage.waitForSelector('tbody tr[data-idx]');
    await poll(async () => (await locatePage.evaluate(() => document.readyState)) === 'complete', '页面加载完成');
    await locatePage.waitForTimeout(400);
    return { locateCtx, locatePage, read };
  }

  console.log('\u00a715 1 小屏：目标在折叠下方 → 必须滚，而且滚完那一天的所有条都完整可见');

  // 15. 1 小屏：目标在折叠下方 → 必须滚，而且滚完那一天的所有条都完整可见
  {
    const { locateCtx, read } = await openLocated({ width: 360, height: 640 }, locateRows);
    const state = await read();
    assert.equal(state.count, 2);
    assert.ok(state.scrollY > 0, `小屏应滚动到目标，实际 scrollY=${state.scrollY}`);
    assert.ok(state.allVisible, '滚动后目标日的所有条都应完整可见');
    await locateCtx.close();
  }

  console.log('\u00a715 2 大屏：目标本来就完整可见 → 一行都不该滚，但要闪一下作为"定位到了"的反馈');

  // 15. 2 大屏：目标本来就完整可见 → 一行都不该滚，但要闪一下作为"定位到了"的反馈
  {
    const { locateCtx, locatePage, read } = await openLocated({ width: 360, height: 1600 }, locateRows);
    const state = await read();
    assert.ok(state.allVisible);
    assert.equal(state.scrollY, 0, `目标已可见时不应滚动，实际 scrollY=${state.scrollY}`);
    const flashed = await locatePage.evaluate(() => document.querySelectorAll('tbody tr.is-flash').length);
    assert.ok(flashed >= 1, '目标已可见时也应闪一下（不滚的唯一反馈）');
    await locateCtx.close();
  }

  console.log('\u00a715 3 桌面表格：吸顶表头以下的区域算安全区，仍然是最小滚动');

  // 15. 3 桌面表格：吸顶表头以下的区域算安全区，仍然是最小滚动
  {
    const { locateCtx, read } = await openLocated({ width: 1440, height: 700 }, locateRows);
    const state = await read();
    assert.ok(state.scrollY > 0, '桌面上目标在折叠下方时应滚动');
    assert.ok(state.allVisible, '滚动后目标应完整落在吸顶表头下方');
    await locateCtx.close();
  }

  console.log('\u00a715 4 全是已结束 / 课表视图 → 不动');

  // 15. 4 全是已结束 / 课表视图 → 不动
  {
    // 放在本周之内：默认筛选会隐藏本周之前的已结束实验，那样列表是空的、测不到东西
    const past = [{ date: '2026-11-10', period: '第1-2节', name: '旧实验', place: 'A', note: '' }];
    const pastRun = await openLocated({ width: 360, height: 640 }, past);
    assert.equal((await pastRun.read()).scrollY, 0, '没有今天及以后的实验时不应滚动');
    await pastRun.locateCtx.close();

    const weekRun = await openLocated({ width: 1440, height: 950 }, locateRows, 'week');
    assert.equal((await weekRun.read()).scrollY, 0, '课表视图不应滚动');
    await weekRun.locateCtx.close();
  }

  console.log('\u00a715 5 刷新（浏览器恢复滚动位置）后，目标仍然完整可见');

  // 15. 5 刷新（浏览器恢复滚动位置）后，目标仍然完整可见
  {
    const { locateCtx, locatePage, read } = await openLocated({ width: 360, height: 640 }, locateRows);
    await locatePage.reload();
    await locatePage.waitForSelector('tbody tr[data-idx]');
    await poll(async () => (await locatePage.evaluate(() => document.readyState)) === 'complete', '刷新完成');
    await locatePage.waitForTimeout(400);
    const state = await read();
    assert.ok(state.allVisible, `刷新后目标仍应完整可见，实际 scrollY=${state.scrollY}`);
    await locateCtx.close();
  }
  console.log('\u00a716 提示条跳转：能看见就只闪不滚，看不全才最小移动（不再跳到屏幕正中）');
  // 16. 提示条跳转：能看见就只闪不滚，看不全才最小移动（不再跳到屏幕正中）
  {
    const cueCtx = await browser.newContext({ viewport: { width: 360, height: 640 }, reducedMotion: 'reduce' });
    const cuePage = await cueCtx.newPage();
    await cuePage.clock.install({ time: new Date('2026-11-14T12:00:00') });
    await cuePage.addInitScript(rows => {
      localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
    }, locateRows);
    await cuePage.goto(`${appUrl}?class=Z1`);
    await cuePage.waitForSelector('tbody tr[data-idx]');
    await cuePage.waitForTimeout(400);

    const cueGeom = () => cuePage.evaluate(() => {
      const idx = Number(document.getElementById('cueText').dataset.idx);
      const rect = document.querySelector(`tr[data-idx="${idx}"]`).getBoundingClientRect();
      return {
        scrollY: Math.round(window.scrollY),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        innerH: window.innerHeight
      };
    });
    // 用 DOM click：Playwright 的 .click() 会先把提示条滚进视口，把测量搞乱
    const clickCue = () => cuePage.evaluate(() => document.getElementById('cueText').click());

    console.log('\u00a716 1 目标在折叠下方 → 只把底边贴到视口底，居中会滚得更远');

    // 16. 1 目标在折叠下方 → 只把底边贴到视口底，居中会滚得更远
    await cuePage.evaluate(() => window.scrollTo(0, 0));
    await cuePage.waitForTimeout(150);
    const hiddenBefore = await cueGeom();
    assert.ok(hiddenBefore.bottom > hiddenBefore.innerH, '前置条件：目标应先在折叠下方');
    await clickCue();
    await cuePage.waitForTimeout(400);
    const hiddenAfter = await cueGeom();
    assert.ok(Math.abs(hiddenAfter.bottom - hiddenAfter.innerH) <= 1,
      `应把目标底边贴到视口底部，实际底边 ${hiddenAfter.bottom} / 视口 ${hiddenAfter.innerH}`);
    const centeredScroll = hiddenBefore.top - Math.round((hiddenBefore.innerH - hiddenBefore.height) / 2);
    assert.ok(hiddenAfter.scrollY < centeredScroll,
      `滚动量应小于居中所需（${hiddenAfter.scrollY} < ${centeredScroll}）`);

    console.log('\u00a716 2 目标已完整可见 → 一点都不要动');

    // 16. 2 目标已完整可见 → 一点都不要动
    await cuePage.evaluate(() => {
      const idx = Number(document.getElementById('cueText').dataset.idx);
      const row = document.querySelector('tr[data-idx="' + idx + '"]');
      window.scrollTo(0, window.scrollY + row.getBoundingClientRect().top - 300);
    });
    await cuePage.waitForTimeout(150);
    const visibleBefore = await cueGeom();
    assert.ok(visibleBefore.top >= 0 && visibleBefore.bottom <= visibleBefore.innerH, '前置条件：目标应已完整可见');
    await clickCue();
    await cuePage.waitForTimeout(400);
    const visibleAfter = await cueGeom();
    assert.equal(visibleAfter.scrollY, visibleBefore.scrollY, '目标已可见时点提示条不应滚动');
    await cueCtx.close();
  }
  console.log('\u00a715 6 只差几像素时不滚（SCROLL_EPSILON = 8）：直接调可见性工具函数，');
  // 15. 6 只差几像素时不滚（SCROLL_EPSILON = 8）：直接调可见性工具函数，
  // 避免不同引擎的字体/行高把"差 6px"变成"差 11px"而误判。
  {
    const epsilonCtx = await browser.newContext({ viewport: { width: 360, height: 640 } });
    const epsilonPage = await epsilonCtx.newPage();
    await epsilonPage.goto(`${appUrl}?class=Z2`);
    await epsilonPage.waitForSelector('tbody tr[data-idx]');
    const epsilon = await epsilonPage.evaluate(() => {
      window.scrollTo(0, 0);
      const viewport = window.innerHeight;
      const nearMiss = scrollRangeIntoView(100, viewport + 6, false);   // 差 6px
      const realMiss = scrollRangeIntoView(100, viewport + 40, false);  // 差 40px
      return { nearMiss, realMiss, scrollY: Math.round(window.scrollY) };
    });
    assert.equal(epsilon.nearMiss, false, '差 6px 时不应滚动');
    assert.equal(epsilon.realMiss, true, '差 40px 时应滚动');
    assert.ok(epsilon.scrollY > 0, '差 40px 时确实滚了');
    await epsilonCtx.close();
  }
  console.log('\u00a717 提示条的目标被筛选挡住：点一下要清掉筛选、定位并播报，而不是静默无反应');
  // 17. 提示条的目标被筛选挡住：点一下要清掉筛选、定位并播报，而不是静默无反应
  {
    const filterCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const filterPage = await filterCtx.newPage();
    await filterPage.goto(`${appUrl}?class=Z2`);
    await filterPage.waitForSelector('tbody tr[data-idx]');
    await filterPage.locator('#actionsToggle').click();
    await filterPage.fill('#searchInput', 'zzz不存在zzz');
    await filterPage.waitForTimeout(300);
    assert.equal(await filterPage.locator('tbody tr[data-idx]').count(), 0, '前置条件：搜索应把列表清空');

    await filterPage.evaluate(() => document.getElementById('cueText').click());
    await filterPage.waitForTimeout(500);
    const recovered = await filterPage.evaluate(() => ({
      rows: document.querySelectorAll('tbody tr[data-idx]').length,
      search: document.getElementById('searchInput').value,
      flashed: document.querySelectorAll('tbody tr.is-flash').length,
      status: document.getElementById('liveStatus').textContent || ''
    }));
    assert.ok(recovered.rows > 0, '清掉筛选后应重新出现实验行');
    assert.equal(recovered.search, '', '搜索词应被清空');
    assert.equal(recovered.flashed, 1, '跳转后目标行应闪烁');
    assert.match(recovered.status, /已清除筛选.*定位到/, `状态栏应说明发生了什么，实际「${recovered.status}」`);
    await filterCtx.close();
  }
  console.log('\u00a718 操作面板按钮：放不下要换行，不能被压到裁字（361–440px 曾把 8 个按钮挤成一行）');
  // 18. 操作面板按钮：放不下要换行，不能被压到裁字（361–440px 曾把 8 个按钮挤成一行）
  {
    for (const width of [390, 664]) {
      const panelCtx = await browser.newContext({ viewport: { width, height: 900 } });
      const panelPage = await panelCtx.newPage();
      await panelPage.goto(`${appUrl}?class=Z2`);
      await panelPage.waitForSelector('tbody tr[data-idx]');
      await panelPage.locator('#actionsToggle').click();
      await panelPage.waitForTimeout(250);
      const panel = await panelPage.evaluate(() => {
        const btns = [...document.querySelectorAll('.action-groups button')];
        return {
          rows: new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size,
          clipped: btns.filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent.trim()),
          minHeight: Math.min(...btns.map(b => Math.round(b.getBoundingClientRect().height))),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
      });
      assert.deepEqual(panel.clipped, [], `${width}px 下按钮文字被裁：${panel.clipped.join('、')}`);
      assert.equal(panel.overflowX, 0, `${width}px 下不应横向溢出`);
      assert.ok(panel.minHeight >= 44, `${width}px 下按钮高度应 ≥44px，实际 ${panel.minHeight}`);
      if (width === 390) assert.ok(panel.rows >= 2, `390px 下按钮应换行，实际只有 ${panel.rows} 行`);
      await panelCtx.close();
    }
  }
  console.log('\u00a719 可点目标不小于 24×24（WCAG 2.2 · 2.5.8）：页脚两个反馈按钮曾只有 20px 高');
  // 19. 可点目标不小于 24×24（WCAG 2.2 · 2.5.8）：页脚两个反馈按钮曾只有 20px 高
  {
    for (const width of [320, 390]) {
      const targetCtx = await browser.newContext({ viewport: { width, height: 900 } });
      const targetPage = await targetCtx.newPage();
      await targetPage.goto(`${appUrl}?class=Z2`);
      await targetPage.waitForSelector('tbody tr[data-idx]');
      await targetPage.waitForTimeout(250);
      const small = await targetPage.evaluate(() => Array.from(document.querySelectorAll('button'))
        .filter(el => el.offsetParent !== null)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { id: el.id || el.className.split(' ')[0], w: Math.round(rect.width), h: Math.round(rect.height) };
        })
        .filter(item => item.w < 24 || item.h < 24));
      assert.deepEqual(small, [], `${width}px 下存在小于 24×24 的可点目标：${JSON.stringify(small)}`);
      await targetCtx.close();
    }
  }
  console.log('\u00a720 周分隔线只表达"换周"：即使换周那行正好是今天/明天，线也必须是中性灰');
  // 20. 周分隔线只表达"换周"：即使换周那行正好是今天/明天，线也必须是中性灰
  {
    const sepRows = [
      { date: '2026-11-09', period: '第1-2节', name: '上周实验', place: 'A1', note: '' },
      { date: '2026-11-16', period: '第1-2节', name: '今天实验', place: 'A2', note: '' }
    ];
    for (const [scheme, expected] of [['light', 'rgb(208, 215, 222)'], ['dark', 'rgb(48, 54, 61)']]) {
      const sepCtx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: scheme });
      const sepPage = await sepCtx.newPage();
      await sepPage.clock.install({ time: new Date('2026-11-16T12:00:00') });   // 周一，让"今天"正好是换周那行
      await sepPage.addInitScript(rows => {
        localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
      }, sepRows);
      await sepPage.goto(`${appUrl}?class=Z1`);
      await sepPage.waitForSelector('tbody tr[data-idx]');
      await sepPage.locator('#recentFilter').uncheck();
      await sepPage.waitForTimeout(350);
      const sep = await sepPage.evaluate(() => {
        const row = Array.from(document.querySelectorAll('tbody tr')).find(r => /今天实验/.test(r.textContent));
        const cell = row.querySelector('td.cell-mobile');
        return {
          isWeekStart: row.classList.contains('week-start'),
          isToday: row.classList.contains('row-today'),
          mobile: getComputedStyle(cell, '::before').backgroundColor
        };
      });
      assert.equal(sep.isWeekStart, true, '前置条件：今天那行应同时是换周行');
      assert.equal(sep.isToday, true, '前置条件：该行应标记为今天');
      assert.equal(sep.mobile, expected, `${scheme} 下换周线不应跟随今天变红/绿，实际 ${sep.mobile}`);
      await sepCtx.close();
    }
  }
  console.log('\u00a721 「下一次」让位给「今天 / 明天」：最近一次就在今天或明天时，不再叠加蓝框与 N 天后徽标');
  // 21. 「下一次」让位给「今天 / 明天」：最近一次就在今天或明天时，不再叠加蓝框与 N 天后徽标
  {
    const cases = [
      { label: '明天', time: '2026-11-15T12:00:00', date: '2026-11-16', name: '明天实验', expectNext: false },
      { label: '今天', time: '2026-11-16T12:00:00', date: '2026-11-16', name: '今天实验', expectNext: false },
      { label: '三天后', time: '2026-11-15T12:00:00', date: '2026-11-18', name: '三天后实验', expectNext: true }
    ];
    for (const item of cases) {
      const nextCtx = await browser.newContext({ viewport: { width: 390, height: 900 } });
      const nextPage = await nextCtx.newPage();
      await nextPage.clock.install({ time: new Date(item.time) });
      await nextPage.addInitScript(rows => {
        localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
      }, [{ date: item.date, period: '第3-4节', name: item.name, place: 'A1', note: '' }]);
      await nextPage.goto(`${appUrl}?class=Z1`);
      await nextPage.waitForSelector('tbody tr[data-idx]');
      await nextPage.waitForTimeout(300);
      const state = await nextPage.evaluate(() => {
        const row = document.querySelector('tbody tr[data-idx]');
        const legend = document.getElementById('nextLegend');
        return {
          isNextRow: row.classList.contains('row-next'),
          nextBadge: row.querySelectorAll('.next-badge').length,
          tag: (row.querySelector('.tag') || {}).textContent || '',
          legendHidden: legend ? legend.hidden : null
        };
      });
      if (item.expectNext) {
        assert.equal(state.isNextRow, true, `${item.label}：3 天后应保留 row-next`);
        assert.ok(state.nextBadge >= 1, `${item.label}：3 天后应有 N 天后徽标（桌面/卡片各一个）`);
        assert.equal(state.legendHidden, false, `${item.label}：图例「下一次」应可见`);
        // 与真实日期无关的深色对比度守护：视觉冒烟在"最近一次是今天/明天"时会跳过「下一次」那项
        const contrastCtx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: 'dark' });
        const contrastPage = await contrastCtx.newPage();
        await contrastPage.clock.install({ time: new Date(item.time) });
        await contrastPage.addInitScript(rows => {
          localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
        }, [{ date: item.date, period: '第3-4节', name: item.name, place: 'A1', note: '' }]);
        await contrastPage.goto(`${appUrl}?class=Z1`);
        await contrastPage.waitForSelector('tbody tr[data-idx].row-next');
        const colors = await contrastPage.evaluate(() => {
          const cell = document.querySelector('tbody tr.row-next td.cell-mobile');
          const row = document.querySelector('tbody tr.row-next');
          const fg = getComputedStyle(cell).color;
          let bg = getComputedStyle(cell).backgroundColor;
          if (/rgba\(0, 0, 0, 0\)/.test(bg)) bg = getComputedStyle(row).backgroundColor;
          return { fg, bg };
        });
        const ratio = contrastRatio(colors.fg, colors.bg);
        assert.ok(ratio >= 4.5, `深色「下一次」行对比度 ${ratio.toFixed(2)} < 4.5（${colors.fg} on ${colors.bg}）`);
        await contrastCtx.close();
      } else {
        assert.equal(state.isNextRow, false, `${item.label}：已有今天/明天标记时不应再加 row-next`);
        assert.equal(state.nextBadge, 0, `${item.label}：不应再显示 N 天后徽标`);
        assert.equal(state.tag, item.label, `${item.label}：应保留今天/明天标签`);
        assert.equal(state.legendHidden, true, `${item.label}：没有行在用蓝色时图例应隐藏「下一次」`);
      }
      await nextCtx.close();
    }
  }
  console.log('\u00a722 深色模式不许出现浅色块：任何一种状态下，可见元素的不透明背景亮度都要 ≤0.45');
  // 22. 深色模式不许出现浅色块：任何一种状态下，可见元素的不透明背景亮度都要 ≤0.45
  //     （删除模式里"已标记"的行、状态栏的撤销按钮、导入弹窗的几块浅底都曾整块发白。）
  {
    const states = [
      ['基础列表', async () => {}],
      ['操作面板', async page => { await page.locator('#actionsToggle').click(); }],
      ['编辑模式', async page => {
        await page.locator('#actionsToggle').click();
        await page.locator('#editModeBtn').click();
      }],
      ['删除模式+已标记', async page => {
        await page.locator('#actionsToggle').click();
        await page.locator('#deleteModeBtn').click();
        await page.waitForTimeout(250);
        await page.evaluate(() => document.querySelector('tbody tr[data-idx] .mark-btn').click());
      }],
      ['删除后的撤销条', async page => {
        await page.locator('#actionsToggle').click();
        await page.locator('#deleteModeBtn').click();
        await page.waitForTimeout(250);
        await page.evaluate(() => document.querySelector('tbody tr[data-idx] .mark-btn').click());
        await page.waitForTimeout(150);
        await page.locator('#deleteModeBtn').click();
        await page.waitForTimeout(700);
      }],
      ['导出弹窗', async page => {
        await page.locator('#actionsToggle').click();
        await page.locator('#exportBtn').click();
        await page.waitForTimeout(350);
      }],
      ['课表视图', async page => {
        await page.evaluate(() => setView('week', false));
        await page.waitForTimeout(400);
      }],
      // CI 跑在 UTC：时区提示条常驻，必须也有深色版
      ['时区提示（UTC）', async () => {}, { timezoneId: 'UTC' }]
    ];
    for (const [label, setup, options] of states) {
      const darkCtx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: 'dark', ...(options || {}) });
      const darkPage = await darkCtx.newPage();
      await darkPage.goto(`${appUrl}?class=Z2`);
      await darkPage.waitForSelector('tbody tr[data-idx]');
      await setup(darkPage);
      await darkPage.waitForTimeout(200);
      const lightBlocks = await darkPage.evaluate(() => {
        const toLum = parts => {
          const q = parts.map(Number).map(v => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2];
        };
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('svg')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          const m = cs.backgroundColor.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
          if (!m) continue;
          const alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (alpha < 0.5) continue;
          if (toLum([m[1], m[2], m[3]]) > 0.45) {
            out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.')) + ' ' + cs.backgroundColor);
          }
        }
        return Array.from(new Set(out)).slice(0, 6);
      });
      assert.deepEqual(lightBlocks, [], `深色「${label}」出现浅色块：${lightBlocks.join('；')}`);
      await darkCtx.close();
    }
  }
  console.log('\u00a723 文字对比度：所有可见文字按 WCAG 1.4.3 检查（正文 4.5:1、大字 3:1）');
  // 23. 文字对比度：所有可见文字按 WCAG 1.4.3 检查（正文 4.5:1、大字 3:1）
  //     这轮靠它抓出 15 处：深色时钟 1.18、深色表单标签 1.92、浅色已标记行 1.89…
  {
    const combos = [
      { width: 390, scheme: 'light', state: 'base' },
      { width: 390, scheme: 'light', state: 'marked' },
      { width: 390, scheme: 'light', state: 'week' },
      { width: 1440, scheme: 'light', state: 'marked' },
      { width: 390, scheme: 'dark', state: 'base' },
      { width: 390, scheme: 'dark', state: 'marked' },
      { width: 390, scheme: 'dark', state: 'undo' },
      { width: 1440, scheme: 'dark', state: 'marked' }
    ];
    for (const combo of combos) {
      const contrastCtx = await browser.newContext({ viewport: { width: combo.width, height: 950 }, colorScheme: combo.scheme });
      const contrastPage = await contrastCtx.newPage();
      await contrastPage.goto(`${appUrl}?class=Z2`);
      await contrastPage.waitForSelector('tbody tr[data-idx]');
      if (combo.state === 'week') {
        await contrastPage.evaluate(() => setView('week', false));
        await contrastPage.waitForTimeout(400);
      }
      if (combo.state === 'marked' || combo.state === 'undo') {
        await contrastPage.locator('#actionsToggle').click();
        await contrastPage.locator('#deleteModeBtn').click();
        await contrastPage.waitForTimeout(260);
        await contrastPage.evaluate(() => document.querySelector('tbody tr[data-idx] .mark-btn').click());
        if (combo.state === 'undo') {
          await contrastPage.waitForTimeout(150);
          await contrastPage.locator('#deleteModeBtn').click();
          await contrastPage.waitForTimeout(700);
        }
      }
      await contrastPage.waitForTimeout(150);
      const low = await contrastPage.evaluate(() => {
        const parse = c => {
          const m = String(c).match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
          return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
        };
        const lum = ({ r, g, b }) => {
          const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        const ratio = (a, c) => { const l1 = Math.max(lum(a), lum(c)), l2 = Math.min(lum(a), lum(c)); return (l1 + 0.05) / (l2 + 0.05); };
        const effectiveBg = el => {
          let cur = el;
          const stack = [];
          while (cur && cur !== document.documentElement) {
            const c = parse(getComputedStyle(cur).backgroundColor);
            if (c && c.a > 0) stack.push(c);
            if (c && c.a >= 0.999) break;
            cur = cur.parentElement;
          }
          let base = { r: 255, g: 255, b: 255, a: 1 };
          const htmlBg = parse(getComputedStyle(document.documentElement).backgroundColor);
          const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
          if (htmlBg && htmlBg.a > 0.5) base = htmlBg;
          if (bodyBg && bodyBg.a > 0.5) base = bodyBg;
          for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i], base);
          return base;
        };
        const hasOwnText = el => Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('svg') || el.closest('.sr-only')) continue;
          if (!hasOwnText(el)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          if (el.closest(':disabled, [aria-disabled="true"], .is-disabled')) continue;
          if (Number(cs.opacity) < 0.9) continue;
          const fg = parse(cs.color);
          if (!fg) continue;
          const bg = effectiveBg(el);
          const composed = fg.a < 1 ? blend(fg, bg) : fg;
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
          const need = large ? 3 : 4.5;
          const r = ratio(composed, bg);
          if (r < need) {
            out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.')) + ' ' + r.toFixed(2) + ' < ' + need + '（fg ' + cs.color + '）');
          }
        }
        return Array.from(new Set(out)).slice(0, 5);
      });
      assert.deepEqual(low, [], `${combo.width}px ${combo.scheme} ${combo.state} 对比度不足：${low.join('；')}`);
      await contrastCtx.close();
    }
  }
  console.log('\u00a724 状态栏文案要截断：名称/地点可到 200 字，整段塞进状态栏会撑成大色块');
  // 24. 状态栏文案要截断：名称/地点可到 200 字，整段塞进状态栏会撑成大色块
  {
    const statusCtx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const statusPage = await statusCtx.newPage();
    await statusPage.goto(`${appUrl}?class=Z2`);
    await statusPage.waitForSelector('tbody tr[data-idx]');
    await statusPage.locator('#actionsToggle').click();
    await statusPage.locator('#addBtn').click();
    await statusPage.waitForSelector('#modalMask.show');
    await statusPage.fill('#formPeriod', '第1-2节');
    await statusPage.fill('#formName', '长'.repeat(180));
    await statusPage.fill('#formPlace', '地点'.repeat(90));
    await statusPage.locator('#modalSubmit').click();
    await statusPage.waitForTimeout(600);
    const bar = await statusPage.evaluate(() => {
      const el = document.querySelector('.import-status.show');
      return {
        visible: (el.querySelector('.status-text') || el).textContent.length,
        title: (el.title || '').length,
        live: document.getElementById('liveStatus').textContent.length,
        height: Math.round(el.getBoundingClientRect().height)
      };
    });
    assert.ok(bar.visible <= 81, `状态栏可见文字应截到 80 字以内，实际 ${bar.visible}`);
    assert.ok(bar.title > bar.visible, '完整文案应保留在 title 里');
    assert.ok(bar.live > bar.visible, '读屏播报保留全文');
    assert.ok(bar.height <= 120, `状态栏不应撑太高，实际 ${bar.height}px`);

    // E1：截断时可点「展开」看全文；再点收起；整条状态栏也能点
    const toggleState = () => statusPage.evaluate(() => {
      const bar = document.querySelector('.import-status.show');
      const span = bar.querySelector('.status-text');
      const toggle = bar.querySelector('.status-toggle');
      return {
        len: span.textContent.length,
        label: toggle.textContent,
        expanded: toggle.getAttribute('aria-expanded'),
        height: Math.round(bar.getBoundingClientRect().height),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    const collapsed = await toggleState();
    assert.equal(collapsed.label, '展开', '截断时应出现「展开」按钮');
    assert.equal(collapsed.expanded, 'false', '初始应为收起');
    await statusPage.locator('.status-toggle').click();
    await statusPage.waitForTimeout(150);
    const expanded = await toggleState();
    assert.ok(expanded.len > 200, `展开后应显示全文，实际 ${expanded.len} 字`);
    assert.equal(expanded.label, '收起', '展开后按钮应变成「收起」');
    assert.equal(expanded.expanded, 'true', '展开后 aria-expanded=true');
    assert.ok(expanded.height <= 440, `展开后不应无限撑高，实际 ${expanded.height}px`);
    assert.equal(expanded.overflowX, 0, '展开后不应横向溢出');
    await statusPage.locator('.status-toggle').click();
    await statusPage.waitForTimeout(150);
    const recollapsed = await toggleState();
    assert.ok(recollapsed.len <= 81, '再次点击应收起');
    assert.equal(recollapsed.label, '展开', '收起后按钮文字应恢复');

    // 点状态栏空白处也能展开
    await statusPage.evaluate(() => {
      const bar = document.querySelector('.import-status.show');
      const r = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 2 }));
    });
    await statusPage.waitForTimeout(150);
    assert.ok((await toggleState()).len > 200, '点状态栏本身也应展开');

    // 同一批长文案也不能把「下一节」提示条撑成十几行（单行截断）
    const cue = await statusPage.evaluate(() => {
      const bar = document.getElementById('cueBar');
      const txt = document.getElementById('cueText');
      if (!bar || bar.hidden) return null;
      return {
        barH: Math.round(bar.getBoundingClientRect().height),
        ws: getComputedStyle(txt).whiteSpace,
        clipped: txt.scrollWidth > txt.clientWidth + 2
      };
    });
    if (cue) {
      assert.ok(cue.barH <= 60, `提示条应保持单行，实际 ${cue.barH}px`);
      assert.equal(cue.ws, 'nowrap', '提示条文字必须单行截断');
      assert.ok(cue.clipped, '超长文案应被省略号截断');
    }
    await statusCtx.close();
  }
  console.log('\u00a725 打印分页：表头跨页重复、行不被切断、单行放得下一页、打印时隐藏界面元素');
  // 25. 打印分页：表头跨页重复、行不被切断、单行放得下一页、打印时隐藏界面元素
  //     A4 去掉 12mm 上下边距后可用高 ≈ 1032px（96dpi）
  {
    const printCtx = await browser.newContext({ viewport: { width: 703, height: 1032 } });
    const printPage = await printCtx.newPage();
    await printPage.clock.install({ time: new Date('2026-11-15T12:00:00') });
    await printPage.addInitScript(() => {
      const rows = [];
      for (let i = 0; i < 90; i += 1) {
        const d = new Date(Date.UTC(2026, 10, 16 + i));
        rows.push({
          date: d.toISOString().slice(0, 10),
          period: `第${(i % 5) * 2 + 1}-${(i % 5) * 2 + 2}节`,
          name: '打印测试' + i,
          place: 'A' + (i % 9 + 1),
          note: i % 10 === 0 ? '备注一行' : ''
        });
      }
      localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
    });
    await printPage.goto(`${appUrl}?class=Z1`);
    await printPage.waitForSelector('tbody tr[data-idx]');
    await printPage.evaluate(() => { recentOnly = false; render(); });
    await printPage.waitForTimeout(300);
    await printPage.emulateMedia({ media: 'print' });
    await printPage.waitForTimeout(300);
    const print = await printPage.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr[data-idx]'));
      const thead = document.querySelector('thead');
      const heights = rows.map(r => Math.round(r.getBoundingClientRect().height));
      const pageContent = 1032;   // A4 297mm - 24mm 边距 ≈ 273mm @96dpi
      return {
        rowCount: rows.length,
        theadDisplay: getComputedStyle(thead).display,
        theadHeight: Math.round(thead.getBoundingClientRect().height),
        breakInside: rows.length ? getComputedStyle(rows[0]).breakInside : null,
        maxRowHeight: Math.max(...heights),
        pageContent,
        hidden: ['#cueBar', '.action-panel', '.legend', '.clock', '.diag-row'].map(sel => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).display === 'none' : true;
        })
      };
    });
    assert.ok(print.rowCount >= 80, `前置条件：打印时应渲染足够多的行，实际 ${print.rowCount}`);
    assert.equal(print.theadDisplay, 'table-header-group', '表头必须是 table-header-group 才会跨页重复');
    assert.equal(print.breakInside, 'avoid', '数据行必须 break-inside: avoid，不能被页边界切成两半');
    assert.ok(print.maxRowHeight < print.pageContent - print.theadHeight,
      `单行高 ${print.maxRowHeight}px 必须小于每页可用高 ${print.pageContent - print.theadHeight}px`);
    assert.deepEqual(print.hidden, [true, true, true, true, true], '打印时必须隐藏提示条/操作面板/图例/时钟/页脚按钮');
    await printCtx.close();

    // 深色模式打印：必须仍然是白纸黑字（深色块的 body 规则在打印块之后，曾把整页染黑）
    for (const scheme of ['light', 'dark']) {
      const colorCtx = await browser.newContext({ viewport: { width: 794, height: 1123 }, colorScheme: scheme });
      const colorPage = await colorCtx.newPage();
      await colorPage.clock.install({ time: new Date('2026-11-15T12:00:00') });
      await colorPage.addInitScript(() => localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify([
        { date: '2026-11-15', period: '第3-4节', name: '今天实验', place: 'A102', note: '' },
        { date: '2026-11-20', period: '第7-8节', name: '未来实验', place: 'A103', note: '' }
      ])));
      await colorPage.goto(`${appUrl}?class=Z1`);
      await colorPage.waitForSelector('tbody tr[data-idx]');
      await colorPage.evaluate(() => { recentOnly = false; render(); });
      await colorPage.emulateMedia({ media: 'print' });
      await colorPage.waitForTimeout(250);
      const colors = await colorPage.evaluate(() => {
        const g = (sel, prop) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el)[prop] : null;
        };
        return {
          bodyBg: g('body', 'backgroundColor'),
          bodyColor: g('body', 'color'),
          wrapBg: g('.wrap', 'backgroundColor'),
          headColor: g('.print-head', 'color'),
          thColor: g('th', 'color')
        };
      });
      assert.equal(colors.bodyBg, 'rgb(255, 255, 255)', `${scheme} 打印时页面底色必须是白的`);
      assert.equal(colors.bodyColor, 'rgb(0, 0, 0)', `${scheme} 打印时正文必须是黑的`);
      assert.equal(colors.wrapBg, 'rgb(255, 255, 255)', `${scheme} 打印时卡片容器底色必须是白的`);
      assert.equal(colors.headColor, 'rgb(0, 0, 0)', `${scheme} 打印标题必须是黑的`);
      assert.equal(colors.thColor, 'rgb(0, 0, 0)', `${scheme} 打印表头文字必须是黑的`);
      await colorCtx.close();
    }
  }
  // A4/C4：打印态对比度 ≥4.5、焦点环对比度 ≥3
  {
    const contrastOf = (a, b) => {
      const lum = rgb => {
        const m = rgb.match(/\d+/g).map(Number).slice(0, 3);
        const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b));
      return (l1 + 0.05) / (l2 + 0.05);
    };
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 }, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(`${appUrl}?class=Z2`);
      await page.waitForSelector('tbody tr[data-idx]');
      await page.evaluate(() => { recentOnly = false; render(); });
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(250);
      const colors = await page.evaluate(() => {
        const g = (sel, prop) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el)[prop] : null;
        };
        return {
          bodyBg: g('body', 'backgroundColor'), bodyFg: g('body', 'color'),
          thBg: g('th', 'backgroundColor'), thFg: g('th', 'color'),
          metaFg: g('.print-meta', 'color')
        };
      });
      assert.ok(contrastOf(colors.bodyFg, colors.bodyBg) >= 4.5, `${scheme} 打印正文对比度不足`);
      assert.ok(contrastOf(colors.thFg, colors.thBg) >= 4.5, `${scheme} 打印表头对比度不足`);
      assert.ok(contrastOf(colors.metaFg, colors.bodyBg) >= 4.5, `${scheme} 打印元信息对比度不足`);
      await page.emulateMedia({ media: 'screen' });
      await ctx.close();
    }
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(`${appUrl}?class=Z2`);
      await page.waitForSelector('tbody tr[data-idx]');
      await page.locator('#actionsToggle').click();
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        const bg = getComputedStyle(document.body).backgroundColor;
        return { outline: cs.outlineColor, bg, width: cs.outlineWidth };
      });
      assert.ok(contrastOf(ring.outline, ring.bg) >= 3, `${scheme} 焦点环对比度不足（${ring.outline} on ${ring.bg}）`);
      await ctx.close();
    }
  }

  console.log('\u00a726 语义色与 token 表一致：改色必须同时改 tools/palette.json，否则这里会红');
  // 26. 语义色与 token 表一致：改色必须同时改 tools/palette.json，否则这里会红
  {
    const palette = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'palette.json'), 'utf8'));
    // palette.semantic 现在指向语义别名（--row-today-bg 等），别名再给出明暗两个色值
    const expect = (scheme, role) => {
      const alias = palette.semantic[role];
      const entry = palette.aliases[alias];
      return entry ? entry[scheme] : null;
    };
    const rgb = hex => {
      const v = hex.replace('#', '');
      const n = v.length === 3 ? v.split('').map(c => c + c).join('') : v.slice(0, 6);
      return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
    };
    const stateRows = [
      { date: '2026-11-08', period: '第1-2节', name: '过去实验', place: 'A101', note: '' },
      { date: '2026-11-15', period: '第3-4节', name: '今天实验', place: 'A102', note: '' },
      { date: '2026-11-16', period: '第3-4节', name: '明天实验', place: 'A103', note: '' },
      { date: '2026-11-20', period: '第7-8节', name: '冲突甲', place: 'A105', note: '' },
      { date: '2026-11-20', period: '第7-8节', name: '冲突乙', place: 'A106', note: '' }
    ];

    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 950 }, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.clock.install({ time: new Date('2026-11-15T12:00:00') });
      await page.addInitScript(rows => {
        localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify(rows));
      }, stateRows);
      await page.goto(`${appUrl}?class=Z1`);
      await page.waitForSelector('tbody tr[data-idx]');
      await page.evaluate(() => { recentOnly = false; render(); });
      await page.waitForTimeout(300);
      const actual = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tbody tr[data-idx]'));
        const byName = n => rows.find(r => r.textContent.includes(n));
        const parse = c => {
          const m = String(c).match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
          return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
        };
        const blend = (fg, bg) => ({
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1
        });
        // 行内可能有多层（tr / td），取"视觉上真正看到的底色"
        const effectiveBg = el => {
          if (!el) return null;
          let cur = el;
          const stack = [];
          while (cur && cur !== document.documentElement) {
            const c = parse(getComputedStyle(cur).backgroundColor);
            if (c && c.a > 0) stack.push(c);
            if (c && c.a >= 0.999) break;
            cur = cur.parentElement;
          }
          let base = { r: 255, g: 255, b: 255, a: 1 };
          const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
          if (bodyBg && bodyBg.a > 0.5) base = bodyBg;
          for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i], base);
          return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
        };
        const rowBg = name => {
          const row = byName(name);
          if (!row) return null;
          const cell = row.querySelector('td.cell-mobile') || row.querySelector('td');
          return effectiveBg(cell || row);
        };
        const conflict = byName('冲突甲');
        return {
          pageBg: getComputedStyle(document.body).backgroundColor,
          textMain: getComputedStyle(document.body).color,
          rowPastBg: rowBg('过去实验'),
          rowTodayBg: rowBg('今天实验'),
          rowTomorrowBg: rowBg('明天实验'),
          conflictBorder: conflict ? getComputedStyle(conflict).borderTopColor : null,
          conflictBg: rowBg('冲突甲')
        };
      });
      assert.equal(actual.pageBg, rgb(expect(scheme, 'pageBg')), `${scheme} 页面底色应为 token 值`);
      assert.equal(actual.textMain, rgb(expect(scheme, 'textMain')), `${scheme} 主文字色应为 token 值`);
      assert.equal(actual.rowPastBg, rgb(expect(scheme, 'rowPastBg')), `${scheme} 已结束行底色应为 token 值`);
      assert.equal(actual.rowTodayBg, rgb(expect(scheme, 'rowTodayBg')), `${scheme} 今天行底色应为 token 值`);
      assert.equal(actual.rowTomorrowBg, rgb(expect(scheme, 'rowTomorrowBg')), `${scheme} 明天行底色应为 token 值`);
      assert.equal(actual.conflictBorder, rgb(expect(scheme, 'conflictBorder')), `${scheme} 冲突描边应为 token 值`);
      assert.equal(actual.conflictBg, rgb(expect(scheme, 'conflictBg')), `${scheme} 冲突底色应为 token 值`);

      // 下一次（≥2 天）与状态栏单独构造
      // 最近一次要在 ≥2 天后才不会被「今天/明天」让位抑制
      await page.evaluate(() => {
        experiments = [{ date: '2026-11-18', period: '第3-4节', name: '下次实验', place: 'B', note: '' }];
        recentOnly = false;
        render();
      });
      await page.waitForTimeout(250);
      const nextBg = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('tbody tr[data-idx]')).find(r => r.textContent.includes('下次实验'));
        if (!row) return null;
        const cell = row.querySelector('td.cell-mobile') || row.querySelector('td');
        const parse = c => {
          const m = String(c).match(/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/);
          return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
        };
        const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        let cur = cell;
        const stack = [];
        while (cur && cur !== document.documentElement) {
          const c = parse(getComputedStyle(cur).backgroundColor);
          if (c && c.a > 0) stack.push(c);
          if (c && c.a >= 0.999) break;
          cur = cur.parentElement;
        }
        let base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i], base);
        return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
      });
      assert.equal(nextBg, rgb(expect(scheme, 'rowNextBg')), `${scheme} 下一次行底色应为 token 值`);

      await page.evaluate(() => showStatus('ok', '测试状态栏'));
      await page.waitForTimeout(120);
      const status = await page.evaluate(() => {
        const el = document.querySelector('.import-status.show');
        return { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color };
      });
      assert.equal(status.bg, rgb(expect(scheme, 'statusOkBg')), `${scheme} 成功状态底色应为 token 值`);
      assert.equal(status.fg, rgb(expect(scheme, 'statusOkText')), `${scheme} 成功状态文字应为 token 值`);
      await ctx.close();
    }
  }
  // F5：404 页也要能用（CSP 允许、有返回入口、无脚本错误）
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    const url = pathToFileURL(path.join(root, '404.html')).href;
    await page.goto(url);
    await page.waitForTimeout(200);
    const info = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 120),
      back: !!document.querySelector('a[href="index.html"], a[href="./index.html"], a[href="/"]'),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    assert.ok(info.text.length > 0, '404 页应有提示文字');
    assert.ok(info.back, '404 页应提供返回入口');
    assert.equal(info.overflowX, 0, '404 页不应横向溢出');
    assert.deepEqual(errs, [], '404 页不应有脚本错误');
    await ctx.close();
  }

  // 27. 兼容性：现代内核必须隐藏"浏览器过旧"提示条；<noscript> 兜底存在
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr[data-idx]');
    const info = await page.evaluate(() => {
      const banner = document.querySelector('.browser-warning');
      const noscript = document.querySelector('noscript');
      return {
        bannerDisplay: banner ? getComputedStyle(banner).display : null,
        bannerText: banner ? banner.textContent.trim().length : 0,
        hasNoscript: !!noscript,
        supportsCustomProps: CSS.supports('--css: variables')
      };
    });
    assert.equal(info.supportsCustomProps, true, '现代内核应支持 CSS 变量（前置条件）');
    assert.equal(info.bannerDisplay, 'none', '现代内核必须隐藏过旧浏览器提示条');
    assert.ok(info.bannerText > 10, '提示条应有可读文案（给不支持变量的浏览器看）');
    assert.equal(info.hasNoscript, true, '应有 <noscript> 兜底提示');
    await ctx.close();
  }

  // 28. 两列布局下，同一行的普通卡与冲突卡必须横向对齐（边框厚度不能吃掉 1px）
  {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 900 } });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date('2026-11-15T12:00:00') });
    await page.addInitScript(() => {
      localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify([
        { date: '2026-11-16', period: '第1-2节', name: '普通实验', place: 'A101', note: '' },
        { date: '2026-11-20', period: '第5-6节', name: '冲突甲', place: 'A104', note: '' },
        { date: '2026-11-20', period: '第5-6节', name: '冲突乙', place: 'A105', note: '' }
      ]));
    });
    await page.goto(`${appUrl}?class=Z1`);
    await page.waitForSelector('tbody tr[data-idx]');
    await page.evaluate(() => { recentOnly = false; render(); });
    await page.waitForTimeout(500);
    const geom = await page.evaluate(() => {
      return [...document.querySelectorAll('tbody tr[data-idx]')].map(r => {
        const td = r.querySelector('td.cell-mobile');
        return {
          conflict: r.classList.contains('row-conflict'),
          top: Math.round(r.getBoundingClientRect().top * 10) / 10,
          contentTop: td ? Math.round(td.getBoundingClientRect().top * 10) / 10 : null
        };
      });
    });
    const normal = geom.find(g => !g.conflict);
    const conflicts = geom.filter(g => g.conflict);
    assert.ok(normal && conflicts.length, '前置条件：需要普通卡与冲突卡');
    const sideBySide = conflicts.find(c => c.top === normal.top);
    assert.ok(sideBySide, '前置条件：普通卡与冲突卡应落在同一网格行');
    assert.equal(sideBySide.contentTop, normal.contentTop, '同一行两张卡的文字必须横向对齐');
    await ctx.close();
  }

  console.log('UI smoke OK');
} finally {
  fs.rmSync(fixtureDir, { force: true, recursive: true });
  await browser.close();
}

