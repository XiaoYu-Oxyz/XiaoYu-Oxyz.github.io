import * as H from './harness.mjs';
const { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 } = H;

  // 13. 冲突（卡片布局）：2px 方角描边 + 同组最短连线，不靠文字表达。
  const confCtx = await browser.newContext({ viewport: { width: 800, height: 900 } });
  const confPage = await confCtx.newPage();
  // 不依赖默认 Z2 数据里恰好有冲突：注入两条同一天同节次的实验，保证 §13 稳定
  await confPage.addInitScript(() => {
    localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z2', JSON.stringify([
      { date: '2026-11-20', period: '第5-6节', name: '冲突甲', place: 'A104', note: '' },
      { date: '2026-11-20', period: '第5-6节', name: '冲突乙', place: 'A105', note: '' }
    ]));
  });
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
  assert.equal(conflict.borderWidth, '1px', '冲突卡边框应为 1px（与普通卡同宽，只换颜色）');
  assert.doesNotMatch(conflict.shadow, /0px 0px 0px 1px inset/, '不允许用内阴影加粗边框（会让同行卡片错位）');
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

export { conflict, light, dark };
