import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'new-class.mjs');

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8' });
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crsecue-new-class-'));
}

test('add：复制 xlsx 到 data/<class>.xlsx', () => {
  const dir = tmp();
  const src = path.join(dir, 'Z6-数据.xlsx');
  fs.writeFileSync(src, 'dummy-xlsx');
  const dataDir = path.join(dir, 'data');
  const r = run(['add', '--class', 'Z6', '--from', src, '--data-dir', dataDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dataDir, 'Z6.xlsx'), 'utf8'), 'dummy-xlsx');
  assert.match(r.stdout, /已添加/);
});

test('add：班级 id 非法时拒绝', () => {
  const dir = tmp();
  const src = path.join(dir, 'x.xlsx');
  fs.writeFileSync(src, 'x');
  const r = run(['add', '--class', '../Z6', '--from', src, '--data-dir', path.join(dir, 'data')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /班级 id/);
});

test('add：非 xlsx 拒绝', () => {
  const dir = tmp();
  const src = path.join(dir, 'Z6.json');
  fs.writeFileSync(src, '{}');
  const r = run(['add', '--class', 'Z6', '--from', src, '--data-dir', path.join(dir, 'data')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /只接受 \.xlsx/);
});

test('add：目标已存在时拒绝，不覆盖', () => {
  const dir = tmp();
  const src = path.join(dir, 'Z6.xlsx');
  fs.writeFileSync(src, 'new');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'Z6.xlsx'), 'old');
  const r = run(['add', '--class', 'Z6', '--from', src, '--data-dir', dataDir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /已存在/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'Z6.xlsx'), 'utf8'), 'old');
});

test('keygen：生成私钥与公钥，且不覆盖已有文件', () => {
  const dir = tmp();
  const key = path.join(dir, 'Z6.pem');
  const pub = path.join(dir, 'Z6.pub');
  const r = run(['keygen', '--class', 'Z6', '--key', key, '--pub', pub]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(key, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.match(fs.readFileSync(pub, 'utf8'), /BEGIN PUBLIC KEY/);
  const again = run(['keygen', '--class', 'Z6', '--key', key, '--pub', pub]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /已存在/);
});

test('--help 输出中文用法', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /新班级上线向导/);
  assert.match(r.stdout, /new-class\.mjs add/);
});
