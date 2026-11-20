import * as H from './harness.mjs';
const { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 } = H;

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
  // 不写死班级列表：页面里可能有任意新增班级（如 test），动态删到空。
  const deletedIds = [];
  let guard = 0;
  while (true) {
    const ids = await builtPage.$$eval('#classSelect option', (opts) => opts.map((o) => o.value).filter(Boolean));
    if (!ids.length) break;
    const current = ids[0];
    await builtPage.selectOption('#classSelect', current);
    await builtPage.locator('#deleteClassBtn').click();
    await builtPage.waitForSelector('#confirmMask.show');
    await builtPage.locator('#confirmOk').click();
    await settle(builtPage);
    deletedIds.push(current);
    if (++guard > 50) throw new Error('删除班级循环未收敛');
  }
  assert.ok(deletedIds.length >= 3, '应至少删除内置班级');
  assert.equal(await builtPage.locator('#classSelect').inputValue(), '');
  assert.match(await builtPage.locator('#classSelect').innerText(), /无班级/);
  assert.equal(await builtPage.locator('#recentCount').innerText(), '显示 0 / 共 0');
  assert.equal(await builtPage.locator('#addBtn').isDisabled(), true);
  await clickUndo(builtPage);
  await waitValue(builtPage.locator('#classSelect'), deletedIds[deletedIds.length - 1]);

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

