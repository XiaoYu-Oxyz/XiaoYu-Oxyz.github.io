import * as H from './harness.mjs';
const { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 } = H;
import { light, dark } from './sections-c.mjs';

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
    const recovered = await filterPage.evaluate(() => {
      const bar = document.querySelector('.import-status.show');
      return {
        rows: document.querySelectorAll('tbody tr[data-idx]').length,
        search: document.getElementById('searchInput').value,
        flashed: document.querySelectorAll('tbody tr.is-flash').length,
        live: document.getElementById('liveStatus').textContent || '',
        visibleStatus: bar ? bar.textContent.trim() : ''
      };
    });
    assert.ok(recovered.rows > 0, '清掉筛选后应重新出现实验行');
    assert.equal(recovered.search, '', '搜索词应被清空');
    assert.equal(recovered.flashed, 1, '跳转后目标行应闪烁');
    assert.match(recovered.live, /已清除筛选/, `读屏应播报筛选被清掉，实际「${recovered.live}」`);
    assert.equal(recovered.visibleStatus, '', '可见状态栏不应再出现“已定位到”之类提醒');
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
