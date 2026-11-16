import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'release.mjs');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-release-'));
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

function ceremony(dir, { exp = '2099-01-01', signer = 'admin', release = 1 } = {}) {
  const key = path.join(dir, 'root.pem');
  assert.equal(run(dir, ['keygen', '--out', key, '--keyid', 'root-test']).code, 0);
  assert.equal(run(dir, ['roster-init', '--keyid', 'root-test', '--exp', exp, '--key', key]).code, 0);
  assert.equal(run(dir, ['manifest', '--release', String(release), '--signer', signer]).code, 0);
  const sign = run(dir, ['sign', '--key', key, '--signer', signer]);
  return { key, sign };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('完整仪式 + 验签通过', () => {
  const dir = makeRepo();
  const { sign } = ceremony(dir);
  assert.equal(sign.code, 0, sign.out);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 0, verify.out);
  assert.match(verify.out, /release=1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('篡改受保护文件 → 拒绝', () => {
  const dir = makeRepo();
  ceremony(dir);
  fs.writeFileSync(path.join(dir, 'src', 'a.css'), 'css-v2');
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /与签名不符/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('新增未登记文件 → 拒绝', () => {
  const dir = makeRepo();
  ceremony(dir);
  fs.writeFileSync(path.join(dir, 'data', 'sneaky.json'), '{}');
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /未签名文件/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('篡改授权名册 → 拒绝', () => {
  const dir = makeRepo();
  ceremony(dir);
  const roster = JSON.parse(fs.readFileSync(path.join(dir, 'keys', 'roster.json'), 'utf8'));
  roster.signers[0].scope.push('everything');
  fs.writeFileSync(path.join(dir, 'keys', 'roster.json'), JSON.stringify(roster, null, 2));
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /名册签名无效/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('签名者不在名册 → 拒绝', () => {
  const dir = makeRepo();
  const { key } = ceremony(dir);
  run(dir, ['manifest', '--release', '2', '--signer', 'stranger']);
  const sign = run(dir, ['sign', '--key', key, '--signer', 'stranger']);
  // sign 本身会因名册缺失而失败；无论哪种，verify 必须拒绝
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /不在授权名册|签名者不在|scalar/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('签名者授权过期 → 拒绝', () => {
  const dir = makeRepo();
  ceremony(dir, { exp: '2000-01-01' });
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /过期/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重放旧清单（回滚）→ 拒绝', () => {
  const dir = makeRepo();
  const { key } = ceremony(dir);
  const m1 = fs.readFileSync(path.join(dir, 'release', 'manifest.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'a.txt'), 'data-v2');
  assert.equal(run(dir, ['manifest', '--release', '2']).code, 0);
  assert.equal(run(dir, ['sign', '--key', key]).code, 0);
  // 把清单换回 release 1（日志仍是 release 2）
  fs.writeFileSync(path.join(dir, 'release', 'manifest.json'), m1);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /不在发布日志|计数器/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('撤销签名者后旧清单失效', () => {
  const dir = makeRepo();
  const { key } = ceremony(dir);
  assert.equal(run(dir, ['roster-revoke', '--id', 'admin', '--key', key]).code, 0);
  const verify = run(dir, ['verify']);
  assert.equal(verify.code, 1);
  assert.match(verify.out, /不在授权名册|撤销/);
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
  console.error('发布签名测试失败：' + failed + ' / ' + cases.length);
  process.exit(1);
}
console.log('release tests OK (' + cases.length + ' cases)');
