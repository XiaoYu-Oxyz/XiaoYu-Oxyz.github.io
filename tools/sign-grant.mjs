#!/usr/bin/env node
/**
 * CrseCue 本机编辑授权（edit grant）签发/验证工具。
 *
 * 默认情况下页面是"只能看"的；要改本机数据，必须导入一份由管理员 P-256 私钥
 * 签名的 grant。grant 里带 scope（允许改哪些班）和 exp（到期日），页面自己检查。
 *
 * 用法：
 *   node tools/sign-grant.mjs issue --key <管理员数据私钥> --out grant.json \
 *        --sub 学委名字 --scope Z1,Z2 --exp 2027-01-31 --keyid data-admin.pub
 *   node tools/sign-grant.mjs verify --pub keys/data-admin.pub --in grant.json
 */
import { createPrivateKey, createPublicKey, sign as ecSign, verify as ecVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from './release.mjs';

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function requireArg(argv, name) {
  const v = argOf(argv, name);
  if (!v) throw new Error('缺少参数 ' + name);
  return v;
}

function unsigned(grant) {
  const copy = { ...grant };
  delete copy.sig;
  return copy;
}

function cmdIssue(argv) {
  const keyPath = requireArg(argv, '--key');
  const out = argOf(argv, '--out') || 'edit-grant.json';
  const sub = requireArg(argv, '--sub');
  const scope = (requireArg(argv, '--scope')).split(',').map(s => s.trim()).filter(Boolean);
  const exp = requireArg(argv, '--exp');
  const keyId = argOf(argv, '--keyid') || 'data-admin.pub';
  if (!scope.length) throw new Error('scope 不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) throw new Error('exp 必须是 YYYY-MM-DD');
  const body = { v: 1, kind: 'edit-grant', sub, scope, exp, keyId, alg: 'ES256' };
  const sig = ecSign('sha256', Buffer.from(canon(body), 'utf8'), {
    key: createPrivateKey(fs.readFileSync(keyPath, 'utf8')),
    dsaEncoding: 'ieee-p1363'
  }).toString('base64');
  fs.writeFileSync(out, JSON.stringify({ ...body, sig }, null, 2) + '\n', 'utf8');
  console.log('已签发：' + out + '（sub=' + sub + '，scope=' + scope.join(',') + '，exp=' + exp + '）');
}

function cmdVerify(argv) {
  const pubPath = requireArg(argv, '--pub');
  const inPath = requireArg(argv, '--in');
  const grant = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  if (grant.kind !== 'edit-grant' || grant.alg !== 'ES256' || !grant.sig) {
    console.error('不是编辑授权文件');
    process.exitCode = 1;
    return;
  }
  const ok = ecVerify('sha256', Buffer.from(canon(unsigned(grant)), 'utf8'), {
    key: createPublicKey(fs.readFileSync(pubPath, 'utf8')),
    dsaEncoding: 'ieee-p1363'
  }, Buffer.from(grant.sig, 'base64'));
  if (!ok) {
    console.error('签名无效：授权文件被改过，或不是这把公钥签的');
    process.exitCode = 1;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (grant.exp < today) {
    console.warn('WARN: 授权已于 ' + grant.exp + ' 过期');
  }
  console.log('OK: 编辑授权有效（sub=' + grant.sub + '，scope=' + grant.scope.join(',') + '，exp=' + grant.exp + '）');
}

function main(argv) {
  const [cmd] = argv;
  switch (cmd) {
    case 'issue': return cmdIssue(argv);
    case 'verify': return cmdVerify(argv);
    default:
      console.error('用法: node tools/sign-grant.mjs <issue|verify> [参数]');
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
