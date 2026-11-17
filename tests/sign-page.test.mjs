import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify as ecVerify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { canon } from '../tools/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(path.join(ROOT, 'sign.html')).href;

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' })
  };
}

const channel = process.env.PLAYWRIGHT_CHANNEL === 'bundled'
  ? undefined
  : (process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined));
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(PAGE);
await page.waitForSelector('#signBtn');

// 1) CSP 不报错，内联脚本确实执行（按钮事件已绑定）
assert.deepEqual(errors, [], 'sign.html 不应有 CSP/脚本错误');

// 2) 与 publish-class.mjs 完全一致的签名格式（raw r||s、canonical、_publish 字段）
const { privPem, pubPem } = makeKeys();
const payload = {
  format: 'crsecue-class-backup', version: 2, class: 'Z1',
  experiments: [{ date: '2026-11-20', period: '第5-6节', name: '签名页测试', place: 'A101', note: '' }]
};
const meta = { v: 1, class: 'Z1', signer: 'test-signer', keyId: 'test-key', issuedAt: '2026-01-01T00:00:00.000Z' };
const signedText = await page.evaluate(async ({ keyPem, jsonText, meta }) => {
  return window.__signRawForTest(keyPem, jsonText, meta);
}, { keyPem: privPem, jsonText: JSON.stringify(payload), meta });

const signed = JSON.parse(signedText);
assert.equal(signed._publish.v, 1);
assert.equal(signed._publish.class, 'Z1');
assert.equal(signed._publish.signer, 'test-signer');
assert.equal(signed._publish.keyId, 'test-key');
assert.equal(signed._publish.issuedAt, meta.issuedAt);
assert.equal(Buffer.from(signed._publish.sig, 'base64').length, 64, '签名必须是 raw r||s 64 字节');

const body = { ...signed };
delete body._publish;
const ok = ecVerify('sha256',
  Buffer.from(canon({ payload: body, publish: meta }), 'utf8'),
  { key: createPublicKey(pubPem), dsaEncoding: 'ieee-p1363' },
  Buffer.from(signed._publish.sig, 'base64'));
assert.equal(ok, true, '页面签名必须能被 Node 用同一 canonical 规则验过');

// 3) 私钥与班级不匹配时给出明确错误（用测试密钥冒充 Z1）
await page.locator('#classSelect').selectOption('Z1');
await page.locator('#keyInput').setInputFiles({ name: 'fake.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(privPem) });
await page.locator('#jsonInput').setInputFiles({ name: 'Z1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
await page.locator('#signBtn').click();
await page.waitForFunction(() => {
  const el = document.getElementById('status');
  return el.classList.contains('show');
});
const mismatch = await page.locator('#status').innerText();
assert.match(mismatch, /私钥与所选班级不匹配/);

// 4) 非 JSON 文件给出明确错误
await page.locator('#jsonInput').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
await page.locator('#signBtn').click();
await page.waitForFunction(() => /签名失败/.test(document.getElementById('status').textContent));
assert.match(await page.locator('#status').innerText(), /JSON|签名失败/);

await browser.close();
console.log('sign-page tests OK');
