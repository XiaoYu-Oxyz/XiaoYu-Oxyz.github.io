import * as H from './harness.mjs';
const { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 } = H;
import { theadDisplay } from './sections-a.mjs';
import { conflict, light, dark } from './sections-c.mjs';

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

  // 29. 卡片边框不变式：所有状态同一宽度（1px），同行内容顶必须一致
  {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 1100 } });
    const page = await ctx.newPage();
    await page.clock.install({ time: new Date('2026-11-15T12:00:00') });
    await page.addInitScript(() => {
      localStorage.setItem('ghpages:zhizao2402:classdata:v1:Z1', JSON.stringify([
        { date: '2026-11-15', period: '第1-2节', name: '今天课', place: 'T1', note: '' },
        { date: '2026-11-16', period: '第1-2节', name: '明天课', place: 'T2', note: '' },
        { date: '2026-11-18', period: '第1-2节', name: '下一次课', place: 'T3', note: '' },
        { date: '2026-11-20', period: '第5-6节', name: '冲突甲', place: 'A104', note: '' },
        { date: '2026-11-20', period: '第5-6节', name: '冲突乙', place: 'A105', note: '' },
        { date: '2026-11-10', period: '第1-2节', name: '过去课', place: 'P1', note: '' }
      ]));
    });
    await page.goto(`${appUrl}?class=Z1`);
    await page.waitForSelector('tbody tr[data-idx]');
    await page.evaluate(() => { recentOnly = false; render(); });
    await page.waitForTimeout(500);
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll('tbody tr[data-idx]')].map(r => {
        const cs = getComputedStyle(r);
        const td = r.querySelector('td.cell-mobile');
        return {
          cls: r.className,
          top: Math.round(r.getBoundingClientRect().top * 10) / 10,
          width: cs.borderTopWidth,
          ring: cs.boxShadow.includes('0px 0px 0px 1px inset'),
          contentTop: td ? Math.round(td.getBoundingClientRect().top * 10) / 10 : null
        };
      });
    });
    assert.ok(rows.length >= 5, '前置条件：应有多种状态的卡片');
    assert.deepEqual([...new Set(rows.map(r => r.width))], ['1px'], '所有状态卡片边框必须同为 1px');
    assert.equal(rows.filter(r => r.ring).length, 0, '不允许用内阴影加粗任意状态卡片的边框');
    const byTop = {};
    rows.forEach(r => { (byTop[r.top] = byTop[r.top] || []).push(r.contentTop); });
    const bad = Object.entries(byTop).filter(([, v]) => new Set(v).size > 1);
    assert.deepEqual(bad, [], '同一行卡片的内容顶必须完全一致');
    assert.ok(rows.some(r => r.cls.includes('row-conflict')), '前置条件：需要冲突卡');
    await ctx.close();
  }

  // 30. 导入验签：P-256 签名有效才接受；篡改/伪造签名一律拒绝
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr');

    const embedded = await page.evaluate(() => {
      const raw = JSON.parse(document.getElementById('defaultData').content.textContent);
      return (raw.dataKeys || []).map(k => k.id);
    });
    assert.ok(embedded.some(id => /data-admin/.test(id)), '构建应把管理员数据公钥注入页面');

    const cryptoCheck = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      const pem = '-----BEGIN PUBLIC KEY-----\n'
        + btoa(String.fromCharCode(...spki)).match(/.{1,64}/g).join('\n')
        + '\n-----END PUBLIC KEY-----\n';
      const payload = {
        format: 'crsecue-class-backup', version: 2, class: 'Z1',
        experiments: [{ date: '2026-11-20', period: '第5-6节', name: '签名测试', place: 'A101', note: '' }]
      };
      const data = new TextEncoder().encode(window.__crsecueCanonical(payload));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data));
      const obj = { ...payload, _crsecue: { v: 1, signer: 'admin', keyId: 'test-key', alg: 'ES256', sig: btoa(String.fromCharCode(...sig)) } };
      const keys = [{ id: 'test-key', pem }];
      const good = await window.__crsecueVerifyImport(obj, keys);
      const tampered = JSON.parse(JSON.stringify(obj));
      tampered.experiments[0].name = '被改过';
      let badMessage = '';
      try { await window.__crsecueVerifyImport(tampered, keys); } catch (error) { badMessage = error.message; }
      return { good, badMessage };
    });
    assert.equal(cryptoCheck.good, 'admin', '有效签名应返回签名者');
    assert.match(cryptoCheck.badMessage, /签名无效/, '篡改后的数据必须验签失败');

    await page.locator('#fileInput').setInputFiles({
      name: 'Z1.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'crsecue-class-backup', version: 2, class: 'Z1',
        experiments: [{ date: '2026-11-20', period: '第5-6节', name: '伪造签名', place: 'A101', note: '' }],
        _crsecue: { v: 1, signer: 'admin', keyId: 'data-admin.pub', alg: 'ES256', sig: 'AAAA' }
      }))
    });
    await poll(async () => /签名/.test(await page.locator('#importStatus').innerText()), '伪造签名应被拒绝', 8000);
    assert.match(await page.locator('#importStatus').innerText(), /签名无效|签名校验失败/);
    // 旧 bug：失败时用 textContent 还原，把长短两个 label span 一起冲掉
    assert.equal(await page.locator('#importBtn .label-long').count(), 1, '导入失败后仍应保留长文案 span');
    assert.equal(await page.locator('#importBtn .label-short').count(), 1, '导入失败后仍应保留短文案 span');
    const labelState = await page.evaluate(() => {
      const btn = document.getElementById('importBtn');
      return {
        long: getComputedStyle(btn.querySelector('.label-long')).display,
        short: getComputedStyle(btn.querySelector('.label-short')).display
      };
    });
    assert.equal(labelState.long, 'none', '900px 下应隐藏长文案');
    assert.equal(labelState.short, 'inline', '900px 下应显示短文案');

    // scope 写入层拦截：Z2 不在授权范围
    await page.evaluate(() => { window.__crsecueGrantForTest = { scope: ['Z1'], exp: '2099-01-01' }; });
    const scope = await page.evaluate(() => ({
      z1: window.__crsecueCanEditClass('Z1'),
      z2: window.__crsecueCanEditClass('Z2')
    }));
    assert.equal(scope.z1, true);
    assert.equal(scope.z2, false, 'Z2 不在授权范围');

    const blocked = await page.evaluate(() => {
      const key = 'ghpages:zhizao2402:classdata:v1:Z2';
      const before = localStorage.getItem(key);
      const ok = saveClassStored('Z2', []);
      return { ok, changed: localStorage.getItem(key) !== before };
    });
    assert.equal(blocked.ok, false, '直接写 Z2 必须被拦');
    assert.equal(blocked.changed, false, 'Z2 数据不能变');

    // 导入到 Z2：确认时被拒
    const z2File = { format: 'crsecue-class-backup', version: 2, class: 'Z2', experiments: [{ date: '2026-12-01', period: '第1-2节', name: '越权导入', place: 'X', note: '' }] };
    await page.locator('#fileInput').setInputFiles({ name: 'Z2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(z2File)) });
    await page.waitForSelector('#importMask.show');
    assert.equal(await page.locator('#importConfirm').isDisabled(), true, '未授权班的确认按钮应禁用');
    assert.match(await page.locator('#importScopeHint').innerText(), /将写入 Z2/);
    assert.match(await page.locator('#importScopeHint').innerText(), /不在编辑授权范围/);
    await page.locator('#importCancel').click();

    // 撤销导入到未授权班：被拒且数据不回滚
    const z1File = { format: 'crsecue-class-backup', version: 2, class: 'Z1', experiments: [{ date: '2026-12-02', period: '第1-2节', name: '授权导入', place: 'Y', note: '' }] };
    const rowsBefore = await page.locator('tbody tr[data-idx]').count();
    await page.locator('#fileInput').setInputFiles({ name: 'Z1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(z1File)) });
    await page.waitForSelector('#importMask.show');
    await page.locator('#importConfirm').dispatchEvent('click');
    await poll(async () => /撤销导入/.test(await page.locator('#importStatus').innerText()), '授权导入应成功', 8000);
    await page.evaluate(() => { window.__crsecueGrantForTest = { scope: [], exp: '2099-01-01' }; });
    await page.evaluate(() => { undoLastImport(); });
    await poll(async () => /该班不在编辑授权范围/.test(await page.locator('#importStatus').innerText()), '未授权班撤销应被拒', 8000);
    assert.equal(await page.locator('tbody tr[data-idx]').count(), rowsBefore + 1, '撤销被拒后应保持导入后的数据');
    await ctx.close();
  }

  // 31. 独立验证入口：只验签，不导入任何数据
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr');
    const before = await page.locator('tbody tr[data-idx]').count();

    await page.locator('#verifyFileBtn').click();
    await page.waitForSelector('#verifyMask.show');

    const unsigned = {
      format: 'crsecue-class-backup', version: 2, class: 'Z1',
      experiments: [{ date: '2026-11-20', period: '第5-6节', name: '验证入口测试', place: 'A101', note: '' }]
    };
    await page.locator('#verifyInput').setInputFiles({
      name: 'Z1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsigned))
    });
    await poll(async () => /未签名/.test(await page.locator('#verifyResult').innerText()), '应提示未签名', 8000);

    const forged = { ...unsigned, _crsecue: { v: 1, signer: 'admin', keyId: 'data-admin.pub', alg: 'ES256', sig: 'AAAA' } };
    await page.locator('#verifyInput').setInputFiles({
      name: 'Z1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(forged))
    });
    await poll(async () => /签名无效|签名校验失败/.test(await page.locator('#verifyResult').innerText()), '应拒绝伪造签名', 8000);

    const after = await page.locator('tbody tr[data-idx]').count();
    assert.equal(after, before, '验证入口不应导入数据');
    await page.locator('#verifyDone').click();
    await waitVisible(page.locator('#verifyMask'), false);
    await ctx.close();
  }

  // 32. 编辑授权：默认锁定、grant 验签（有效/伪造/过期）、解锁后恢复
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr');

    await page.evaluate(async () => { window.__crsecueTestLock = true; await window.__crsecueRefreshEditLock(); });
    assert.equal(await page.evaluate(() => document.body.classList.contains('edit-locked')), true);
    assert.equal(await page.locator('#editLockBadge').isVisible(), true);
    await page.locator('#addBtn').dispatchEvent('click');
    await poll(async () => /已锁定/.test(await page.locator('#importStatus').innerText()), '锁定时应提示', 5000);

    // 锁定态：导出/日历/订阅/清理仍可用，编辑类被锁
    for (const sel of ['#exportBtn', '#icsBtn', '#icsCopyBtn', '#wipeLocalBtn']) {
      assert.equal(await page.locator(sel).evaluate(el => getComputedStyle(el).pointerEvents), 'auto', sel + ' 锁定态应保持可点');
    }
    assert.equal(await page.locator('#addBtn').evaluate(el => getComputedStyle(el).pointerEvents), 'none', '添加应被锁');
    assert.equal(await page.locator('#importBtn').evaluate(el => getComputedStyle(el).pointerEvents), 'none', '导入应被锁');

    await page.locator('#actionsToggle').click();
    await waitVisible(page.locator('#actionPanel'), true);
    await page.locator('#exportBtn').click();
    await page.waitForSelector('#exportMask.show', { timeout: 5000 });
    await page.locator('#exportCancel').dispatchEvent('click');
    await page.evaluate(() => { document.getElementById('exportMask').classList.remove('show'); });
    await waitVisible(page.locator('#exportMask'), false);

    const dl = page.waitForEvent('download');
    await page.locator('#icsBtn').click();
    const icsFile = await dl;
    assert.match(icsFile.suggestedFilename(), /\.ics$/);

    await page.locator('#wipeLocalBtn').click();
    await page.waitForSelector('#confirmMask.show', { timeout: 5000 });
    await page.locator('#confirmCancel').dispatchEvent('click');
    await page.evaluate(() => { document.getElementById('confirmMask').classList.remove('show'); });
    await waitVisible(page.locator('#confirmMask'), false);

    const grantCheck = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      const pem = '-----BEGIN PUBLIC KEY-----\n' + btoa(String.fromCharCode(...spki)).match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n';
      const body = { v: 1, kind: 'edit-grant', sub: '测试', scope: ['Z1'], exp: '2099-01-01', keyId: 'test', alg: 'ES256' };
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(window.__crsecueCanonical(body))));
      const grant = { ...body, sig: btoa(String.fromCharCode(...sig)) };
      const keys = [{ id: 'test', pem }];
      const good = await window.__crsecueVerifyGrant(grant, keys);
      const forged = { ...grant, scope: ['Z1', 'Z2'] };
      let forgedError = '';
      try { await window.__crsecueVerifyGrant(forged, keys); } catch (e) { forgedError = e.message; }
      const expired = { ...grant, exp: '2000-01-01' };
      let expiredError = '';
      try { await window.__crsecueVerifyGrant(expired, keys); } catch (e) { expiredError = e.message; }
      return { good, forgedError, expiredError };
    });
    assert.equal(grantCheck.good, '测试');
    assert.match(grantCheck.forgedError, /签名无效/);
    assert.match(grantCheck.expiredError, /过期/);

    await page.evaluate(async () => { window.__crsecueTestLock = false; await window.__crsecueRefreshEditLock(); });
    assert.equal(await page.evaluate(() => document.body.classList.contains('edit-locked')), false);
    assert.equal(await page.locator('#editLockBadge').isVisible(), false);
    await ctx.close();
  }

  // 33. 未签名导入确认（默认取消）、验证弹窗 Esc、320px 页脚不溢出
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr');
    await page.evaluate(() => {
      window.__crsecueGrantForTest = { scope: ['Z1'], exp: '2099-01-01' };
      window.__crsecueTestUnsignedConfirm = true;
    });

    const unsigned = { format: 'crsecue-class-backup', version: 2, class: 'Z1',
      experiments: [{ date: '2026-12-03', period: '第1-2节', name: '未签名测试', place: 'A1', note: '' }] };
    await page.locator('#fileInput').setInputFiles({ name: 'Z1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsigned)) });
    await page.waitForSelector('#importMask.show');
    await page.locator('#importConfirm').dispatchEvent('click');
    await page.waitForSelector('#confirmMask.show');
    assert.match(await page.locator('#confirmTitle').innerText(), /未签名/);
    await page.locator('#confirmCancel').dispatchEvent('click');
    assert.equal(await page.locator('#importMask').evaluate(el => el.classList.contains('show')), true, '取消后应留在导入弹窗');
    await page.locator('#importCancel').click();
    await waitVisible(page.locator('#importMask'), false);

    await page.locator('#verifyFileBtn').click();
    await page.waitForSelector('#verifyMask.show');
    await page.keyboard.press('Escape');
    await waitVisible(page.locator('#verifyMask'), false);

    await page.evaluate(() => { window.__crsecueTestUnsignedConfirm = false; window.__crsecueGrantForTest = null; });
    await ctx.close();

    const small = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const p2 = await small.newPage();
    await p2.goto(appUrl);
    await p2.waitForSelector('tbody tr');
    const layout = await p2.evaluate(() => {
      const row = document.querySelector('.diag-row');
      const buttons = [...row.querySelectorAll('.diag-btn')];
      return {
        wrap: getComputedStyle(row).flexWrap,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visible: buttons.length === 4 && buttons.every(b => b.getBoundingClientRect().height > 0)
      };
    });
    assert.equal(layout.wrap, 'wrap');
    assert.equal(layout.overflowX, 0);
    assert.equal(layout.visible, true);
    await small.close();
  
  // 34. 通配授权：超级管理员可新建班级；普通授权新建被拒
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.waitForSelector('tbody tr');
    await page.evaluate(async () => {
      // 保持自动化默认解锁（锁定态会拦 #classPromptOk 的点击，走不到授权判断）
      window.__crsecueTestLock = false;
      window.__crsecueGrantForTest = { scope: ['*'], exp: '2099-01-01' };
      await window.__crsecueRefreshEditLock();
    });
    assert.equal(await page.evaluate(() => window.__crsecueCanEditClass('Z6')), true, '通配授权应允许新班');
    await page.locator('#newClassBtn').click();
    await page.waitForSelector('#classMask.show');
    await page.locator('#classPromptInput').fill('Z6');
    await page.locator('#classPromptOk').dispatchEvent('click');
    await page.waitForSelector('#classMask.show', { timeout: 5000 }).catch(() => {});
    await poll(async () => (await page.locator('#classSelect').inputValue()) === 'Z6', '应切到 Z6', 5000);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ghpages:zhizao2402:extra-classes:v1') || '[]').includes('Z6')), true);

    await page.reload();
    await page.waitForSelector('tbody tr');
    await poll(async () => (await page.locator('#classSelect').inputValue()) === 'Z6', '刷新后仍在 Z6', 5000);

    await page.evaluate(() => {
      window.__crsecueGrantForTest = { scope: ['Z2'], exp: '2099-01-01' };
    });
    await page.locator('#newClassBtn').click();
    await page.waitForSelector('#classMask.show');
    await page.locator('#classPromptInput').fill('Z9');
    await page.locator('#classPromptOk').dispatchEvent('click');
    await poll(async () => /不在编辑授权范围/.test(await page.locator('#importStatus').innerText()), '普通授权应拒绝建班', 5000);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#classSelect option')].some(o => o.value === 'Z9')), false);
    await page.evaluate(() => { window.__crsecueTestLock = false; window.__crsecueGrantForTest = null; });
    await ctx.close();
  }

}
