import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

export { pathToFileURL, fileURLToPath, assert, fs, os, path, root, appUrl, browserName, browserType, channel, browser, context, page, pageErrors, fixtureDir, fixture, poll, waitValue, waitNotValue, waitText, waitAttr, waitCount, waitVisible, waitFocus, relLum, contrastRatio, clickUndo, settle, setWeek1 };
