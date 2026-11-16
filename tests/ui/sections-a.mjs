import * as H from './harness.mjs';
const { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 } = H;

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
  //    旧写法在部分 Chromium 上 defineProperty(navigator,'clipboard') 失败（属性不可配置），
  //    真实剪贴板写入成功 -> 兜底框永不出现 -> 30s 超时（这就是历史上的 flaky）。
  //    现在：实例 + 原型双保险，并断言覆盖真的生效；等待改成明确的长轮询。
  async function forceClipboardFailure(scope) {
    const installed = await scope.evaluate(() => {
      const fake = {
        writeText: () => Promise.reject(new Error('denied')),
        write: () => Promise.reject(new Error('denied'))
      };
      let ok = false;
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: fake });
        ok = true;
      } catch (error) {}
      if (!ok) {
        try {
          Object.defineProperty(Object.getPrototypeOf(navigator), 'clipboard', {
            configurable: true,
            get: () => fake
          });
          ok = true;
        } catch (error) {}
      }
      document.execCommand = () => false;
      return ok;
    });
    assert.ok(installed, '无法覆盖 navigator.clipboard（实例与原型都不可配置）');
    const probe = await scope.evaluate(() => navigator.clipboard.writeText('probe').then(() => 'resolved', () => 'rejected'));
    assert.equal(probe, 'rejected', 'clipboard 覆盖未生效，真实写入仍然成功');
  }

  async function waitCopyMask(scope, visible) {
    await poll(async () => (await scope.locator('#copyMask').isVisible()) === visible,
      visible ? '复制兜底框应出现' : '复制兜底框应关闭', 10000);
  }

  await forceClipboardFailure(page);
  await page.locator('#copyWeekBtn').scrollIntoViewIfNeeded();
  await page.locator('#copyWeekBtn').click();
  await waitCopyMask(page, true);
  await poll(async () => /实验课提醒/.test(await page.locator('#copyFallbackText').inputValue()),
    '兜底文本框应包含「实验课提醒」', 10000);
  await page.locator('#copyFallbackDone').click();
  await waitCopyMask(page, false);

  // 5b. 纠错回路：剪贴板不可用时同样退化成只读文本框，
  //     内容必须能直接贴进群里（班级 + 页面 + 具体某一条 + 待补充项）。
  await page.locator('#feedbackBtn').scrollIntoViewIfNeeded();
  await page.locator('#feedbackBtn').click();
  await waitCopyMask(page, true);
  await poll(async () => /【CrseCue · 反馈】/.test(await page.locator('#copyFallbackText').inputValue()),
    '兜底文本框应包含反馈模板', 10000);
  const feedbackText = await page.locator('#copyFallbackText').inputValue();
  assert.match(feedbackText, /【CrseCue · 反馈】/);
  assert.match(feedbackText, /班级：Z1/);
  assert.match(feedbackText, /我看到的是：\d{4}-\d{2}-\d{2}/);
  assert.match(feedbackText, /应该改为：/);
  await page.locator('#copyFallbackDone').click();
  await waitCopyMask(page, false);

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


export { theadDisplay };
