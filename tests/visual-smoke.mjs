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
    // 头部高度守卫：超过这个数说明又堆了一层东西（历史上 320px 曾因搜索图标 +16px）
    if (!item.week) assert.ok(metrics.firstRowTop <= 340, `首屏首行过高：${metrics.firstRowTop}px > 340px`);
    if (afterCueClose !== null) {
      const delta = metrics.firstRowTop - afterCueClose;
      assert.ok(
        Math.abs(delta - metrics.cueBar) <= 4,
        `关闭提示条只应回落到提示条高度：回落 ${delta}px，提示条 ${Math.round(metrics.cueBar)}px`
      );
    }
    if (item.week) assert.ok(metrics.weekGrid, '课表没有渲染');
    for (const [name, expected] of Object.entries(PALETTE)) {
      // 深色模式下配色会整套替换，只校验浅色
      if (item.dark) continue;
      const actual = metrics.dots[name];
      if (actual === null) continue; // 图例项可能被隐藏（无冲突/无下一次）
      assert.equal(actual, expected, `图例色 ${name} 变了`);
    }
    assert.equal(pageErrors.length, 0, `脚本错误：${pageErrors.join(' | ')}`);
    report.push(`  ✓ ${item.name.padEnd(14)} ${item.width}×${item.height}  首行 ${metrics.firstRowTop}px${afterCueClose === null ? '' : `（关提示条 ${afterCueClose}px）`}  溢出 ${metrics.overflowX}px`);
  } catch (error) {
    failures.push(`${item.name}: ${error.message}`);
    report.push(`  ✗ ${item.name.padEnd(14)} ${error.message}`);
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
