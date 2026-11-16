#!/usr/bin/env node
/**
 * CrseCue 数据包签名工具（ECDSA P-256 / SHA-256，零依赖，只用 Node 内置 crypto）。
 *
 * 为什么不用 Ed25519：浏览器端要用 WebCrypto 验签，而 Ed25519 的 WebCrypto
 * 支持太新（Chrome 113+/Safari 17+），会破掉 Chrome 60 / iOS 12 的兼容底线；
 * P-256 从 Chrome 37 / Safari 11 就支持。
 *
 * 文件格式：在原班级备份 JSON 上增加一个顶层字段：
 *   "_crsecue": { "v": 1, "signer": "admin", "keyId": "...", "alg": "ES256", "sig": "<base64 DER>" }
 * 签名对象 = 去掉 "_crsecue" 后、按 canonical JSON（key 排序）序列化的字节。
 *
 * 用法：
 *   node tools/sign-export.mjs keygen --out <私钥路径> --pub keys/data-admin.pub --keyid data-admin-2026-11
 *   node tools/sign-export.mjs sign --key <私钥> --in export.json --out export.signed.json --signer admin
 *   node tools/sign-export.mjs verify --pub keys/data-admin.pub --in export.signed.json
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ecSign, verify as ecVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from './release.mjs';

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function requireArg(argv, name) {
  const value = argOf(argv, name);
  if (!value) throw new Error('缺少参数 ' + name);
  return value;
}

function payloadOnly(obj) {
  const copy = { ...obj };
  delete copy._crsecue;
  return copy;
}

function signBytes(privateKey, obj) {
  return ecSign('sha256', Buffer.from(canon(obj), 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
}

function verifyBytes(pubPem, obj, signature) {
  return ecVerify('sha256', Buffer.from(canon(obj), 'utf8'), { key: createPublicKey(pubPem), dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
}

function cmdKeygen(argv) {
  const out = requireArg(argv, '--out');
  const pubPath = argOf(argv, '--pub') || 'keys/data-admin.pub';
  const keyId = argOf(argv, '--keyid') || 'data-admin-2026-11';
  if (fs.existsSync(out)) throw new Error('私钥已存在，拒绝覆盖：' + out);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  console.log('私钥：' + out + '（仓库外，mode 600）');
  console.log('公钥：' + pubPath + '（随仓库提交）');
  console.log('keyId：' + keyId);
}

function cmdSign(argv) {
  const keyPath = requireArg(argv, '--key');
  const inPath = requireArg(argv, '--in');
  const outPath = argOf(argv, '--out') || inPath.replace(/\.json$/i, '') + '.signed.json';
  const signer = argOf(argv, '--signer') || 'admin';
  const keyId = argOf(argv, '--keyid') || 'data-admin-2026-11';
  const obj = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.experiments)) {
    throw new Error('输入不是 CrseCue 班级备份 JSON（缺少 experiments 数组）');
  }
  const payload = payloadOnly(obj);
  const sig = signBytes(createPrivateKey(fs.readFileSync(keyPath, 'utf8')), payload);
  const signed = { ...payload, _crsecue: { v: 1, signer, keyId, alg: 'ES256', sig } };
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  console.log('已签名：' + outPath + '（signer=' + signer + '，keyId=' + keyId + '）');
}

function cmdVerify(argv) {
  const pubPath = requireArg(argv, '--pub');
  const inPath = requireArg(argv, '--in');
  const obj = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const meta = obj && obj._crsecue;
  if (!meta || !meta.sig) {
    console.error('未签名：文件里没有 _crsecue 字段');
    process.exitCode = 1;
    return;
  }
  if (meta.alg !== 'ES256') {
    console.error('不支持的算法：' + meta.alg);
    process.exitCode = 1;
    return;
  }
  const payload = payloadOnly(obj);
  const ok = verifyBytes(fs.readFileSync(pubPath, 'utf8'), payload, meta.sig);
  if (!ok) {
    console.error('签名无效：内容被改过，或不是这把公钥签的');
    process.exitCode = 1;
    return;
  }
  console.log('OK: 签名有效（signer=' + meta.signer + '，keyId=' + meta.keyId + '，实验 ' + payload.experiments.length + ' 条）');
}

function main(argv) {
  const [cmd] = argv;
  switch (cmd) {
    case 'keygen': return cmdKeygen(argv);
    case 'sign': return cmdSign(argv);
    case 'verify': return cmdVerify(argv);
    default:
      console.error('用法: node tools/sign-export.mjs <keygen|sign|verify> [参数]');
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
