import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sign-grant.mjs');

function run(args) {
  const res = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function keys(dir) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'key.pub');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('签发 + 验证通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-grant-'));
  const { priv, pub } = keys(dir);
  const out = path.join(dir, 'grant.json');
  const issue = run(['issue', '--key', priv, '--out', out, '--sub', '学委', '--scope', 'Z1,Z2', '--exp', '2099-01-01', '--keyid', 'test']);
  assert.equal(issue.code, 0, issue.out);
  const grant = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(Buffer.from(grant.sig, 'base64').length, 64, '签名必须是 raw r||s 64 字节');
  const verify = run(['verify', '--pub', pub, '--in', out]);
  assert.equal(verify.code, 0, verify.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('篡改 scope → 拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-grant-'));
  const { priv, pub } = keys(dir);
  const out = path.join(dir, 'grant.json');
  run(['issue', '--key', priv, '--out', out, '--sub', '学委', '--scope', 'Z1', '--exp', '2099-01-01', '--keyid', 'test']);
  const grant = JSON.parse(fs.readFileSync(out, 'utf8'));
  grant.scope = ['Z1', 'Z2', 'Z5'];
  fs.writeFileSync(out, JSON.stringify(grant));
  const verify = run(['verify', '--pub', pub, '--in', out]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /签名无效/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('换公钥 → 拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-grant-'));
  const a = keys(dir);
  const otherDir = path.join(dir, 'other');
  fs.mkdirSync(otherDir);
  const b = keys(otherDir);
  const out = path.join(dir, 'grant.json');
  run(['issue', '--key', a.priv, '--out', out, '--sub', '学委', '--scope', 'Z1', '--exp', '2099-01-01', '--keyid', 'test']);
  const verify = run(['verify', '--pub', b.pub, '--in', out]);
  assert.equal(verify.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.error('  ✗ ' + name + '\n    ' + String(error && error.message ? error.message : error).split('\n')[0]);
  }
}
if (failed) {
  console.error('grant 测试失败：' + failed + ' / ' + cases.length);
  process.exit(1);
}
console.log('sign-grant tests OK (' + cases.length + ' cases)');
