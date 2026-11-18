#!/usr/bin/env node
/**
 * 新班级上线向导。
 *
 * 用法：
 *   node tools/new-class.mjs add --class Z6 --from Z6.xlsx [--data-dir data]
 *   node tools/new-class.mjs keygen --class Z6 [--key ../review/publishers/Z6.pem] [--pub keys/publishers/Z6.pub]
 *   node tools/new-class.mjs --help
 *
 * add 只负责把导出的 xlsx 放进 data/，不会自动改 release；
 * keygen 生成班级发布密钥（P-256），并打印用根钥登记 publishers.json 的命令。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argOf(argv, name, fallback = '') {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) return fallback;
  return v;
}

function fail(msg) {
  console.error('失败：' + msg);
  process.exit(1);
}

function validClass(id) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

function help() {
  console.log(`新班级上线向导

A. 把页面导出的 xlsx 放进仓库：
  node tools/new-class.mjs add --class Z6 --from "Z6-数据-2026-12-01.xlsx"
  可选 --data-dir data（默认 data/）
  成功后继续：
    python tools/build.py
    node tools/release.mjs manifest
    node tools/release.mjs sign --key <root.pem>
    node tools/release.mjs verify
    然后提交 data/Z6.xlsx + index.html + calendars/Z6.ics + release/* 并开 PR

B. 生成班级发布密钥（让班委自助发布）：
  node tools/new-class.mjs keygen --class Z6
  默认私钥写到 ../review/publishers/Z6.pem（仓库外），公钥写到 keys/publishers/Z6.pub
  之后用根钥登记：
    node tools/sign-publishers.mjs sign --key <root.pem>
  并把私钥 + grant 私聊发给该班班委，不要发群。

注意：add 不会自动改 release，也不会自动生成班委密钥；两步都需要管理员确认。`);
}

function cmdAdd(argv) {
  const cls = argOf(argv, '--class');
  const from = argOf(argv, '--from');
  const dataDir = argOf(argv, '--data-dir', 'data');
  if (!cls) fail('缺少 --class');
  if (!validClass(cls)) fail('班级 id 只能包含字母、数字、下划线、短横线（1-32 位）');
  if (!from) fail('缺少 --from（页面导出的 .xlsx）');
  const src = path.resolve(ROOT, from);
  if (!fs.existsSync(src)) fail('找不到源文件：' + src);
  if (!/\.xlsx$/i.test(src)) fail('只接受 .xlsx 文件；JSON 请先在页面导出为 xlsx');
  const destDir = path.resolve(ROOT, dataDir);
  const dest = path.join(destDir, cls + '.xlsx');
  if (fs.existsSync(dest)) fail(`data/${cls}.xlsx 已存在；要替换请先删除或改名`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`已添加：data/${cls}.xlsx`);
  console.log('');
  console.log('下一步（管理员）：');
  console.log('  python tools/build.py');
  console.log('  node tools/release.mjs manifest');
  console.log('  node tools/release.mjs sign --key <root.pem>');
  console.log('  node tools/release.mjs verify');
  console.log(`  提交 data/${cls}.xlsx、index.html、calendars/${cls}.ics、release/* 并开 PR`);
  console.log('  若要让班委自助发布，再执行：node tools/new-class.mjs keygen --class ' + cls);
}

function cmdKeygen(argv) {
  const cls = argOf(argv, '--class');
  if (!cls) fail('缺少 --class');
  if (!validClass(cls)) fail('班级 id 只能包含字母、数字、下划线、短横线（1-32 位）');
  const keyPath = path.resolve(ROOT, argOf(argv, '--key', path.join('..', 'review', 'publishers', cls + '.pem')));
  const pubPath = path.resolve(ROOT, argOf(argv, '--pub', path.join('keys', 'publishers', cls + '.pub')));
  if (fs.existsSync(keyPath)) fail('私钥已存在：' + keyPath + '（先确认是否要换钥）');
  if (fs.existsSync(pubPath)) fail('公钥已存在：' + pubPath + '（先确认是否要换钥）');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'publish-class.mjs'), 'keygen',
    '--class', cls, '--out', keyPath, '--pub', pubPath
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log('');
  console.log('已生成：');
  console.log('  私钥：' + keyPath);
  console.log('  公钥：' + pubPath);
  console.log('');
  console.log('下一步（管理员）：');
  console.log('  1) 在 keys/publishers.json 的 publishers 里加入：');
  console.log(`     {"class":"${cls}","id":"${cls}-publisher","keyId":"${cls}-pub","pubkey":"keys/publishers/${cls}.pub","exp":"2027-06-30"}`);
  console.log('  2) 用根钥重签名册：');
  console.log('     node tools/sign-publishers.mjs sign --key <root.pem>');
  console.log('  3) 重签 release 并合并 PR');
  console.log('  4) 把私钥和对应 grant 私聊发给班委，不要发群');
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  help();
} else if (cmd === 'add') {
  cmdAdd(argv.slice(1));
} else if (cmd === 'keygen') {
  cmdKeygen(argv.slice(1));
} else {
  help();
  process.exit(1);
}
