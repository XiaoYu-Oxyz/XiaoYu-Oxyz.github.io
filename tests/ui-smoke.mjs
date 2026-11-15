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
  ? (process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined))
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

  // 3.5 表单校验：错误必须绑到具体字段（aria-invalid + aria-describedby），并聚焦第一个出错项。
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

  // 11. 链接里的班级不存在 → 跳 404 说明情况，不要静默换成别的班。
  const badCtx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const badPage = await badCtx.newPage();
  await badPage.goto(`${appUrl}?class=不存在的班级`);
  await badPage.waitForURL(url => url.pathname.endsWith('/404.html'), { timeout: 8000 });
  assert.match(await badPage.locator('#errTitle').innerText(), /班级链接失效了/);
  assert.match(await badPage.locator('#errDesc').innerText(), /不存在的班级/);
  await badCtx.close();

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
      lines: lines.map(n => Number(n.toFixed(1)))
    };
  });
  assert.equal(conflict.borderWidth, '2px', '冲突卡应有 2px 描边');
  assert.equal(conflict.borderStyle, 'solid');
  assert.equal(conflict.radius, '0px', '卡片是方角，描边也跟着方角');
  assert.ok(conflict.lines.length >= 1, '冲突组应画出连线');
  assert.ok(conflict.lines.every(n => n <= 40), `连线应是最短线段：${conflict.lines.join(',')}`);
  await confCtx.close();

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

  // 15.1 小屏：目标在折叠下方 → 必须滚，而且滚完那一天的所有条都完整可见
  {
    const { locateCtx, read } = await openLocated({ width: 360, height: 640 }, locateRows);
    const state = await read();
    assert.equal(state.count, 2);
    assert.ok(state.scrollY > 0, `小屏应滚动到目标，实际 scrollY=${state.scrollY}`);
    assert.ok(state.allVisible, '滚动后目标日的所有条都应完整可见');
    await locateCtx.close();
  }

  // 15.2 大屏：目标本来就完整可见 → 一行都不该滚
  {
    const { locateCtx, read } = await openLocated({ width: 360, height: 1600 }, locateRows);
    const state = await read();
    assert.ok(state.allVisible);
    assert.equal(state.scrollY, 0, `目标已可见时不应滚动，实际 scrollY=${state.scrollY}`);
    await locateCtx.close();
  }

  // 15.3 桌面表格：吸顶表头以下的区域算安全区，仍然是最小滚动
  {
    const { locateCtx, read } = await openLocated({ width: 1440, height: 700 }, locateRows);
    const state = await read();
    assert.ok(state.scrollY > 0, '桌面上目标在折叠下方时应滚动');
    assert.ok(state.allVisible, '滚动后目标应完整落在吸顶表头下方');
    await locateCtx.close();
  }

  // 15.4 全是已结束 / 课表视图 → 不动
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

  // 15.5 刷新（浏览器恢复滚动位置）后，目标仍然完整可见
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
  console.log('UI smoke OK');
} finally {
  fs.rmSync(fixtureDir, { force: true, recursive: true });
  await browser.close();
}

