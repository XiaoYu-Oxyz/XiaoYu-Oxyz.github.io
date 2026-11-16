import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'sign-export.mjs');

function run(args) {
  const res = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function fixture(dir) {
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(file, JSON.stringify({
    format: 'crsecue-class-backup',
    version: 2,
    class: 'Z1',
    week1: '2026-09-01',
    experiments: [
      { date: '2026-11-20', period: '第5-6节', name: '测试实验', place: 'A101', note: '' },
      { date: '2026-11-27', period: '第5-6节', name: '测试实验二', place: 'A102', note: '' }
    ]
  }, null, 2));
  return file;
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('keygen + sign + verify 通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-sign-'));
  const src = fixture(dir);
  const key = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'data.pub');
  assert.equal(run(['keygen', '--out', key, '--pub', pub, '--keyid', 'test-key']).code, 0);
  const signed = path.join(dir, 'signed.json');
  assert.equal(run(['sign', '--key', key, '--in', src, '--out', signed, '--signer', 'admin', '--keyid', 'test-key']).code, 0);
  const verify = run(['verify', '--pub', pub, '--in', signed]);
  assert.equal(verify.code, 0, verify.out);
  assert.match(verify.out, /签名有效/);
  const obj = JSON.parse(fs.readFileSync(signed, 'utf8'));
  assert.equal(Buffer.from(obj._crsecue.sig, 'base64').length, 64, '签名必须是 raw r||s 64 字节（WebCrypto 兼容）');
  assert.match(obj._crsecue.issuedAt, /^\d{4}-\d{2}-\d{2}$/, '应写入签发日期');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('篡改内容 -> 验签失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-sign-'));
  const src = fixture(dir);
  const key = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'data.pub');
  run(['keygen', '--out', key, '--pub', pub, '--keyid', 'test-key']);
  const signed = path.join(dir, 'signed.json');
  run(['sign', '--key', key, '--in', src, '--out', signed, '--signer', 'admin', '--keyid', 'test-key']);
  const obj = JSON.parse(fs.readFileSync(signed, 'utf8'));
  obj.experiments[0].name = '被改过的实验';
  fs.writeFileSync(signed, JSON.stringify(obj, null, 2));
  const verify = run(['verify', '--pub', pub, '--in', signed]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /签名无效/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('换一把公钥 -> 验签失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-sign-'));
  const src = fixture(dir);
  const key = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'data.pub');
  const otherKey = path.join(dir, 'other.pem');
  const otherPub = path.join(dir, 'other.pub');
  run(['keygen', '--out', key, '--pub', pub, '--keyid', 'test-key']);
  run(['keygen', '--out', otherKey, '--pub', otherPub, '--keyid', 'other']);
  const signed = path.join(dir, 'signed.json');
  run(['sign', '--key', key, '--in', src, '--out', signed, '--keyid', 'test-key']);
  const verify = run(['verify', '--pub', otherPub, '--in', signed]);
  assert.equal(verify.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未签名文件 -> 拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-sign-'));
  const src = fixture(dir);
  const pub = path.join(dir, 'data.pub');
  run(['keygen', '--out', path.join(dir, 'key.pem'), '--pub', pub, '--keyid', 'test-key']);
  const verify = run(['verify', '--pub', pub, '--in', src]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /未签名/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('字段顺序变化不影响签名（canonical JSON）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-sign-'));
  const src = fixture(dir);
  const key = path.join(dir, 'key.pem');
  const pub = path.join(dir, 'data.pub');
  run(['keygen', '--out', key, '--pub', pub, '--keyid', 'test-key']);
  const signed = path.join(dir, 'signed.json');
  run(['sign', '--key', key, '--in', src, '--out', signed, '--keyid', 'test-key']);
  const obj = JSON.parse(fs.readFileSync(signed, 'utf8'));
  const reordered = {
    experiments: obj.experiments,
    week1: obj.week1,
    class: obj.class,
    version: obj.version,
    format: obj.format,
    _crsecue: obj._crsecue
  };
  fs.writeFileSync(signed, JSON.stringify(reordered, null, 2));
  const verify = run(['verify', '--pub', pub, '--in', signed]);
  assert.equal(verify.code, 0, verify.out);
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
  console.error('签名数据包测试失败：' + failed + ' / ' + cases.length);
  process.exit(1);
}
console.log('sign-export tests OK (' + cases.length + ' cases)');
