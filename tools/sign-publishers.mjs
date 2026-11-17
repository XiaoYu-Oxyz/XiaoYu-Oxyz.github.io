#!/usr/bin/env node
/**
 * 用管理员根钥（Ed25519）给 keys/publishers.json 签名，生成 keys/publishers.sig。
 * 班级发布名册的信任根：root.pub 验证 publishers.sig，CI 才信任 publishers.json 里的班级公钥。
 *
 * 用法：
 *   node tools/sign-publishers.mjs sign --key C:\Users\<你>\.crsecue\root-ed25519.pem
 *   node tools/sign-publishers.mjs verify
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from './release.mjs';

const ROOT = process.cwd();
const ROSTER = 'keys/publishers.json';
const SIG = 'keys/publishers.sig';
const ROOT_PUB = 'keys/root.pub';

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function cmdSign(argv) {
  const keyPath = argOf(argv, '--key') || process.env.CRSECUE_ROOT_KEY;
  if (!keyPath) throw new Error('缺少根私钥：--key 或 CRSECUE_ROOT_KEY');
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, ROSTER), 'utf8'));
  const sig = edSign(null, Buffer.from(canon(roster), 'utf8'), createPrivateKey(fs.readFileSync(keyPath, 'utf8'))).toString('base64');
  fs.writeFileSync(path.join(ROOT, SIG), JSON.stringify({ schema: 1, signer: 'root', keyId: 'root', alg: 'ed25519', sig }, null, 2) + '\n', 'utf8');
  console.log('已签名 ' + SIG + '（publishers 条目 ' + (roster.publishers || []).length + '）');
}

function cmdVerify() {
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, ROSTER), 'utf8'));
  const sig = JSON.parse(fs.readFileSync(path.join(ROOT, SIG), 'utf8'));
  const pub = fs.readFileSync(path.join(ROOT, ROOT_PUB), 'utf8');
  const ok = edVerify(null, Buffer.from(canon(roster), 'utf8'), createPublicKey(pub), Buffer.from(sig.sig, 'base64'));
  if (!ok) throw new Error('publishers.sig 无效');
  console.log('OK: publishers 名册根签名有效（' + (roster.publishers || []).length + ' 个班级）');
}

const [cmd] = process.argv.slice(2);
try {
  if (cmd === 'sign') cmdSign(process.argv.slice(2));
  else if (cmd === 'verify') cmdVerify();
  else {
    console.error('用法: node tools/sign-publishers.mjs <sign|verify> [--key <root.pem>]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('失败：' + (error && error.message ? error.message : error));
  process.exitCode = 1;
}
