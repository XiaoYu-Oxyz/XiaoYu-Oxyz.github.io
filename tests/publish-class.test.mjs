import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon } from '../tools/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'publish-class.mjs');

function run(root, args) {
  const res = spawnSync(process.execPath, [TOOL, ...args, '--root', root], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function makeRepo({ exp = '2099-01-01', keyId = 'Z1-pub' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-pub-'));
  fs.mkdirSync(path.join(dir, 'keys', 'publishers'), { recursive: true });
  // 根钥（Ed25519）签 publishers.json
  const root = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'keys', 'root.pub'), root.publicKey.export({ type: 'spki', format: 'pem' }));
  // 班级钥（P-256）
  const klass = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const classPub = path.join(dir, 'keys', 'publishers', 'Z1.pub');
  fs.writeFileSync(classPub, klass.publicKey.export({ type: 'spki', format: 'pem' }));
  const roster = {
    schema: 1,
    publishers: [{
      class: 'Z1', id: 'Z1-publisher', keyId, exp,
      pubkey: fs.readFileSync(classPub, 'utf8')
    }]
  };
  fs.writeFileSync(path.join(dir, 'keys', 'publishers.json'), JSON.stringify(roster, null, 2));
  const sig = edSign(null, Buffer.from(canon(roster), 'utf8'), root.privateKey).toString('base64');
  fs.writeFileSync(path.join(dir, 'keys', 'publishers.sig'), JSON.stringify({ schema: 1, sig }));
  const key = path.join(dir, 'Z1.pem');
  fs.writeFileSync(key, klass.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const data = path.join(dir, 'Z1.json');
  fs.writeFileSync(data, JSON.stringify({
    format: 'crsecue-class-backup', version: 2, class: 'Z1', week1: '2026-09-01',
    experiments: [{ date: '2026-11-20', period: '第5-6节', name: '测试', place: 'A101', note: '' }]
  }, null, 2));
  return { dir, key, data };
}

function signedPath(root) {
  return path.join(root, 'Z1.publish.json');
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('签发 + 验证通过', () => {
  const { dir, key, data } = makeRepo();
  const sign = run(dir, ['sign', '--class', 'Z1', '--key', key, '--in', data, '--out', signedPath(dir)]);
  assert.equal(sign.code, 0, sign.out);
  const verify = run(dir, ['verify', '--in', signedPath(dir)]);
  assert.equal(verify.code, 0, verify.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('篡改班级 → 拒绝', () => {
  const { dir, key, data } = makeRepo();
  run(dir, ['sign', '--class', 'Z1', '--key', key, '--in', data, '--out', signedPath(dir)]);
  const obj = JSON.parse(fs.readFileSync(signedPath(dir), 'utf8'));
  obj._publish.class = 'Z2';
  fs.writeFileSync(signedPath(dir), JSON.stringify(obj));
  const verify = run(dir, ['verify', '--in', signedPath(dir)]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /名册里没有班级|签名无效/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('换钥 → 拒绝', () => {
  const { dir, key, data } = makeRepo();
  run(dir, ['sign', '--class', 'Z1', '--key', key, '--in', data, '--out', signedPath(dir)]);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(path.join(dir, 'keys', 'publishers', 'Z1.pub'), other.publicKey.export({ type: 'spki', format: 'pem' }));
  const verify = run(dir, ['verify', '--in', signedPath(dir)]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /签名无效/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('授权过期 → 拒绝', () => {
  const { dir, key, data } = makeRepo({ exp: '2000-01-01' });
  run(dir, ['sign', '--class', 'Z1', '--key', key, '--in', data, '--out', signedPath(dir)]);
  const verify = run(dir, ['verify', '--in', signedPath(dir)]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /过期/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('越界班级（名册没有 Z2）→ 签发即拒绝', () => {
  const { dir, key, data } = makeRepo();
  const sign = run(dir, ['sign', '--class', 'Z2', '--key', key, '--in', data, '--out', path.join(dir, 'Z2.publish.json')]);
  assert.equal(sign.code, 1);
  assert.match(sign.out, /名册里没有|Z2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keyId 与名册不一致 → 拒绝', () => {
  const { dir, key, data } = makeRepo({ keyId: 'other-key' });
  run(dir, ['sign', '--class', 'Z1', '--key', key, '--in', data, '--out', signedPath(dir)]);
  const obj = JSON.parse(fs.readFileSync(signedPath(dir), 'utf8'));
  obj._publish.keyId = 'Z1-pub';
  fs.writeFileSync(signedPath(dir), JSON.stringify(obj));
  const verify = run(dir, ['verify', '--in', signedPath(dir)]);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /keyId|签名无效/);
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
  console.error('publish-class 测试失败：' + failed + ' / ' + cases.length);
  process.exit(1);
}
console.log('publish-class tests OK (' + cases.length + ' cases)');
