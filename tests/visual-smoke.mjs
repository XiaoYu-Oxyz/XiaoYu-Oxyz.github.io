// 视觉冒烟：结构断言 + 固定配色断言 + 截图产物（不做像素基线，避免跨系统字体差异导致假红）
// 运行：node tests/visual-smoke.mjs [--webkit]
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

const outDir = path.join(root, 'test-results', 'visual');
fs.mkdirSync(outDir, { recursive: true });

// 图例色是纯 CSS，不随日期变化，适合做固定断言
const PALETTE = {
  'dot-today': 'rgb(255, 215, 213)',
  'dot-tomorrow': 'rgb(211, 245, 217)',
  'dot-past': 'rgb(234, 238, 242)',
  'dot-conflict': 'rgb(255, 230, 166)',
  'dot-next': 'rgb(234, 243, 255)'
};

const cases = [
  // 360×640 = vivo Y66i 这类 5.5 寸 720p 老机型
  { name: 'mobile-360', width: 360, height: 640 },
  // 横屏手机：头部折叠后首行约 191px（折叠前 262px）
  { name: 'landscape-640', width: 640, height: 360 },
  { name: 'mobile-320', width: 320, height: 640 },
  { name: 'mobile-list', width: 390, height: 844 },
  { name: 'mobile-dark', width: 390, height: 844, dark: true },
  { name: 'tablet-list', width: 768, height: 1024 },
  { name: 'desktop-list', width: 1440, height: 950 },
  { name: 'desktop-week', width: 1440, height: 950, week: true }
];

const browser = await browserType.launch({ headless: true, ...(channel ? { channel } : {}) });
const failures = [];
const report = [];

for (const item of cases) {
  const context = await browser.newContext({
    viewport: { width: item.width, height: item.height },
    colorScheme: item.dark ? 'dark' : 'light'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(appUrl + '?class=Z1');
  await page.waitForSelector('#tbody tr');
  if (item.week) {
    await page.click('#viewWeekBtn');
    await page.waitForSelector('.week-grid');
  }
  await page.waitForTimeout(200);
  // 小屏上「打开页面定位到今天」会自动滚动，先回到顶部再量首屏几何
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const firstRow = document.querySelector('#tbody tr');
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      rows: document.querySelectorAll('#tbody tr').length,
      firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null,
      headerVisible: !!document.querySelector('h1') && document.querySelector('h1').getBoundingClientRect().height > 0,
      cueBar: (() => {
        const el = document.getElementById('cueBar');
        if (!el || el.hidden) return 0;
        // 含下边距：隐藏它以后首行回落的量 = 高度 + margin
        return el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginBottom || '0');
      })(),
      weekGrid: !!document.querySelector('.week-grid'),
      // 深色模式对比度：曾因 row-next 的浅色规则特异性过高导致 1.12:1（白底白字）
      contrasts: (() => {
        const lum = c => {
          const parts = c.match(/[\d.]+/g).slice(0, 3).map(Number);
          const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
          const [r, g, b] = parts.map(f);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (fg, bg) => {
          const a = lum(fg);
          const b = lum(bg);
          return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
        };
        const bgOf = el => {
          let node = el;
          while (node) {
            const bg = getComputedStyle(node).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
            node = node.parentElement;
          }
          return 'rgb(0, 0, 0)';
        };
        const pick = sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return ratio(cs.color, bgOf(el));
        };
        return {
          cue: pick('#cueText'),
          next: pick('tr.row-next td.cell-mobile') ?? pick('tr.row-next td'),
          body: pick('.wrap')
        };
      })(),
      dots: Object.fromEntries(['dot-today', 'dot-tomorrow', 'dot-past', 'dot-conflict', 'dot-next']
        .map(name => {
          const el = document.querySelector('.' + name);
          return [name, el ? getComputedStyle(el).backgroundColor : null];
        }))
    };
  });

  const shot = path.join(outDir, `${item.name}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  // 首屏几何：关掉提示条后首行应回落「提示条高度」那么多（防止头部悄悄变高）
  let afterCueClose = null;
  if (!item.week && !item.dark && metrics.cueBar > 0) {
    await page.click('#cueClose');
    await page.waitForTimeout(120);
    afterCueClose = await page.evaluate(() => Math.round(document.querySelector('#tbody tr').getBoundingClientRect().top));
  }

  try {
    assert.ok(metrics.overflowX <= 1, `横向溢出 ${metrics.overflowX}px`);
    assert.ok(metrics.rows > 0, '没有渲染任何行');
    assert.ok(metrics.headerVisible, '标题不可见');
    assert.ok(metrics.firstRowTop !== null && metrics.firstRowTop < item.height, '首行跑到视口外');
    // 头部高度守卫：超过这个数说明又堆了一层东西。
    // 字体差异很大：CI 是 Linux + Noto CJK，同一页面比 Windows + 微软雅黑高约 90px
    // （实测：360×640 Win 317 / Linux ≈408；320×640 Win 363 / Linux ≈454）。
    // 所以这里只是"别再加一层东西"的粗上限；精确约束交给
    // 横向溢出、关提示条回落量、深色对比度、以及 ui-smoke 里的两列对齐断言。
    if (!item.week) assert.ok(metrics.firstRowTop <= 480, `首屏首行过高：${metrics.firstRowTop}px > 480px`);
    if (afterCueClose !== null) {
      const delta = metrics.firstRowTop - afterCueClose;
      assert.ok(
        Math.abs(delta - metrics.cueBar) <= 4,
        `关闭提示条只应回落到提示条高度：回落 ${delta}px，提示条 ${Math.round(metrics.cueBar)}px`
      );
    }
    if (item.week) assert.ok(metrics.weekGrid, '课表没有渲染');
    // 深色模式：关键区域对比度必须过 WCAG AA（4.5:1）
    if (item.dark) {
      const c = metrics.contrasts || {};
      if (c.cue !== null && c.cue !== undefined) assert.ok(c.cue >= 4.5, `深色提示条对比度 ${c.cue} < 4.5`);
      if (c.next !== null && c.next !== undefined) assert.ok(c.next >= 4.5, `深色「下一次」行对比度 ${c.next} < 4.5`);
      if (c.body !== null && c.body !== undefined) assert.ok(c.body >= 4.5, `深色正文对比度 ${c.body} < 4.5`);
    }
    for (const [name, expected] of Object.entries(PALETTE)) {
      // 深色模式下配色会整套替换，只校验浅色
      if (item.dark) continue;
      const actual = metrics.dots[name];
      if (actual === null) continue; // 图例项可能被隐藏（无冲突/无下一次）
      assert.equal(actual, expected, `图例色 ${name} 变了`);
    }
    assert.equal(pageErrors.length, 0, `脚本错误：${pageErrors.join(' | ')}`);
    report.push(`  ✓ ${item.name.padEnd(14)} ${item.width}×${item.height}  首行 ${metrics.firstRowTop}px${afterCueClose === null ? '' : `（关提示条 ${afterCueClose}px）`}  溢出 ${metrics.overflowX}px${item.dark ? `  对比度 提示条 ${metrics.contrasts.cue} / 下一次 ${metrics.contrasts.next}` : ''}`);
  } catch (error) {
    failures.push(`${item.name}: ${error.message}`);
    report.push(`  ✗ ${item.name.padEnd(14)} ${error.message}`);
  }
  await context.close();
}

// 深色弹窗守卫：以前的视觉冒烟只拍主页面，弹窗在暗色下有没有白底、标题还看不看得清，
// 没有人看着。这里打开两个真实入口，断言"弹窗里没有亮底色块"+"文字对比度过 AA"，
// 截图留在 test-results/visual，改样式时坏了会直接红。
const darkModalCases = [
  { name: 'add', open: page => page.click('#addBtn') },
  { name: 'export', open: page => page.click('#exportBtn') }
];

for (const item of darkModalCases) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark'
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(appUrl + '?class=Z1');
    await page.waitForSelector('#tbody tr');
    await page.click('#actionsToggle');
    await page.waitForTimeout(150);
    await item.open(page);
    await page.waitForSelector('.modal-mask.show .modal', { timeout: 5000 });
    await page.waitForTimeout(250);

    const audit = await page.evaluate(() => {
      const lum = c => {
        const parts = c && c.match(/[\d.]+/g);
        if (!parts) return null;
        const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        const [r, g, b] = parts.slice(0, 3).map(Number).map(f);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg, bg) => {
        const a = lum(fg);
        const b = lum(bg);
        if (a === null || b === null) return null;
        return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
      };
      const bgOf = el => {
        let node = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          node = node.parentElement;
        }
        return 'rgb(0, 0, 0)';
      };
      const mask = document.querySelector('.modal-mask.show');
      const bright = [];
      for (const el of mask.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const bg = cs.backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
        const box = el.getBoundingClientRect();
        const L = lum(bg);
        if (L !== null && L > 0.5 && box.width >= 8 && box.height >= 8) {
          bright.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + bg);
        }
      }
      const box = mask.querySelector('.modal');
      const title = mask.querySelector('.modal-head h2') || mask.querySelector('h2');
      // 只量"可交互"的输入框：WCAG 1.4.3 豁免不可用控件，禁用态的灰字本来就不该按 4.5 要求。
      const input = [...mask.querySelectorAll(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select, textarea'
      )].find(el => !el.disabled && !el.readOnly && getComputedStyle(el).display !== 'none');
      const modalBg = box ? getComputedStyle(box).backgroundColor : null;
      return {
        bright: bright.slice(0, 5),
        modalLum: modalBg ? Number(lum(modalBg).toFixed(3)) : null,
        titleRatio: title ? ratio(getComputedStyle(title).color, bgOf(title)) : null,
        inputRatio: input ? ratio(getComputedStyle(input).color, bgOf(input)) : null
      };
    });

    await page.screenshot({ path: path.join(outDir, `dark-modal-${item.name}.png`), fullPage: false });

    assert.deepEqual(audit.bright, [], `深色弹窗里出现亮底色块：${audit.bright.join(' | ')}`);
    if (audit.modalLum !== null) assert.ok(audit.modalLum < 0.3, `弹窗底色不够深：亮度 ${audit.modalLum}`);
    if (audit.titleRatio !== null) assert.ok(audit.titleRatio >= 4.5, `弹窗标题对比度 ${audit.titleRatio} < 4.5`);
    if (audit.inputRatio !== null) assert.ok(audit.inputRatio >= 4.5, `弹窗输入框对比度 ${audit.inputRatio} < 4.5`);
    assert.equal(pageErrors.length, 0, `脚本错误：${pageErrors.join(' | ')}`);
    report.push(`  ✓ dark-modal-${item.name.padEnd(7)} 无亮底色块  标题 ${audit.titleRatio}  输入框 ${audit.inputRatio}`);
  } catch (error) {
    failures.push(`dark-modal-${item.name}: ${error.message}`);
    report.push(`  ✗ dark-modal-${item.name} ${error.message}`);
  }
  await context.close();
}

await browser.close();
console.log(report.join('\n'));
console.log(`截图产物：${path.relative(root, outDir)}/`);
if (failures.length) {
  console.error(`\n视觉冒烟失败 ${failures.length} 项：\n` + failures.join('\n'));
  process.exit(1);
}
console.log(`visual smoke OK (${browserName})`);
