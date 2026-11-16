import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'release.mjs');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-drill-'));
  for (const sub of ['data', 'src', 'calendars']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v1');
  fs.writeFileSync(path.join(dir, 'src', 'a.css'), 'css-v1');
  fs.writeFileSync(path.join(dir, 'calendars', 'a.ics'), 'ics-v1');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>v1</html>');
  return dir;
}

function run(dir, args) {
  const res = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CRSECUE_REPO_ROOT: dir }
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function setup(dir) {
  const rootKey = path.join(dir, 'root.pem');
  assert.equal(run(dir, ['keygen', '--out', rootKey, '--keyid', 'root-1']).code, 0);
  assert.equal(run(dir, ['roster-init', '--keyid', 'root-1', '--exp', '2099-01-01', '--key', rootKey]).code, 0);
  assert.equal(run(dir, ['manifest', '--release', '1']).code, 0);
  assert.equal(run(dir, ['sign', '--key', rootKey]).code, 0);
  return rootKey;
}

function newKey(dir, name) {
  const key = path.join(dir, name + '.pem');
  const pub = path.join(dir, name + '.pub');
  assert.equal(run(dir, ['keygen', '--out', key, '--keyid', 'delegate-' + name, '--pub', pub]).code, 0);
  return { key, pub };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('受托人：管理员签发 roster → 受托人签名发布 → 验签通过', () => {
  const dir = makeRepo();
  const rootKey = setup(dir);
  const delegate = newKey(dir, 'z1');
  const add = run(dir, ['roster-add', '--key', rootKey, '--id', 'commissary-z1', '--pub', delegate.pub, '--scope', 'data:Z1', '--exp', '2099-01-01']);
  assert.equal(add.code, 0, add.out);
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v2');
  assert.equal(run(dir, ['manifest', '--release', '2', '--signer', 'commissary-z1']).code, 0);
  const sign = run(dir, ['sign', '--key', delegate.key, '--signer', 'commissary-z1']);
  assert.equal(sign.code, 0, sign.out);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 0, verify.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('受托人：撤销后旧发布失效', () => {
  const dir = makeRepo();
  const rootKey = setup(dir);
  const delegate = newKey(dir, 'z1');
  run(dir, ['roster-add', '--key', rootKey, '--id', 'commissary-z1', '--pub', delegate.pub, '--scope', 'data:Z1', '--exp', '2099-01-01']);
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v2');
  run(dir, ['manifest', '--release', '2', '--signer', 'commissary-z1']);
  run(dir, ['sign', '--key', delegate.key, '--signer', 'commissary-z1']);
  const revoke = run(dir, ['roster-revoke', '--key', rootKey, '--id', 'commissary-z1']);
  assert.equal(revoke.code, 0, revoke.out);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /不在授权名册|撤销/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('受托人：改内容不重签 → 验签失败', () => {
  const dir = makeRepo();
  const rootKey = setup(dir);
  const delegate = newKey(dir, 'z1');
  run(dir, ['roster-add', '--key', rootKey, '--id', 'commissary-z1', '--pub', delegate.pub, '--scope', 'data:Z1', '--exp', '2099-01-01']);
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v2');
  run(dir, ['manifest', '--release', '2', '--signer', 'commissary-z1']);
  run(dir, ['sign', '--key', delegate.key, '--signer', 'commissary-z1']);
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v3');
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /与签名不符/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('根密钥轮换：新根钥重签 roster + 新发布 → 验签通过', () => {
  const dir = makeRepo();
  const oldRoot = setup(dir);
  const nextRoot = path.join(dir, 'root-2.pem');
  assert.equal(run(dir, ['keygen', '--out', nextRoot, '--keyid', 'root-2']).code, 0);
  // 新根钥覆盖 keys/root.pub + FINGERPRINT，并重签 roster
  assert.equal(run(dir, ['roster-init', '--keyid', 'root-2', '--exp', '2099-01-01', '--key', nextRoot]).code, 0);
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v2');
  assert.equal(run(dir, ['manifest', '--release', '2']).code, 0);
  assert.equal(run(dir, ['sign', '--key', nextRoot]).code, 0);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 0, verify.out);
  // 旧根钥签的名单已失效（用旧钥再签一份名单 → 验签失败）
  assert.equal(run(dir, ['roster-init', '--keyid', 'root-1', '--exp', '2099-01-01', '--key', oldRoot]).code, 0);
  const stale = run(dir, ['verify']);
  assert.equal(stale.code, 1);
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
  console.error('安全演练失败：' + failed + ' / ' + cases.length);
  process.exit(1);
}
console.log('security drills OK (' + cases.length + ' cases)');
