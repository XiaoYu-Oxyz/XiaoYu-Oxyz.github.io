#!/usr/bin/env node
/**
 * 班级自助发布（class publish）：班委本地给导出的 JSON 签名，CI 验签后自动发布。
 * 信任链：管理员根钥签名的 keys/publishers.json → 班级 P-256 公钥 → _publish 签名。
 *
 * 用法：
 *   node tools/publish-class.mjs keygen --class Z1 --out <私钥路径> --pub keys/publishers/Z1.pub
 *   node tools/publish-class.mjs sign --class Z1 --key <私钥> --in Z1.json --out Z1.publish.json
 *   node tools/publish-class.mjs verify --in Z1.publish.json [--pub keys/publishers/Z1.pub]
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ecSign, verify as ecVerify, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from './release.mjs';

const DEFAULT_ROOT = process.cwd();

function rootOf(argv) {
  return path.resolve(argOf(argv, '--root') || DEFAULT_ROOT);
}
const ROSTER = 'keys/publishers.json';
const ROSTER_SIG = 'keys/publishers.sig';
const ROOT_PUB = 'keys/root.pub';

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
function requireArg(argv, name) {
  const v = argOf(argv, name);
  if (!v) throw new Error('缺少参数 ' + name);
  return v;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function stripPublish(obj) {
  const copy = { ...obj };
  delete copy._publish;
  return copy;
}

export function loadPublishers(root = DEFAULT_ROOT) {
  const roster = readJson(path.join(root, ROSTER));
  const sig = readJson(path.join(root, ROSTER_SIG));
  const rootPub = fs.readFileSync(path.join(root, ROOT_PUB), 'utf8');
  const ok = edVerify(null, Buffer.from(canon(roster), 'utf8'), createPublicKey(rootPub), Buffer.from(sig.sig, 'base64'));
  if (!ok) throw new Error('publishers.json 的根签名无效');
  return roster;
}

export function publisherFor(roster, classId) {
  return (roster.publishers || []).find(item => item.class === classId) || null;
}

function cmdKeygen(argv) {
  const classId = requireArg(argv, '--class');
  const out = requireArg(argv, '--out');
  const pubPath = argOf(argv, '--pub') || `keys/publishers/${classId}.pub`;
  if (fs.existsSync(out)) throw new Error('私钥已存在，拒绝覆盖：' + out);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  console.log(`私钥：${out}（仓库外）\n公钥：${pubPath}\n下一步：把它登记进 keys/publishers.json 并由根钥重签，再上传发布`);
}

function cmdSign(argv) {
  const classId = requireArg(argv, '--class');
  const keyPath = requireArg(argv, '--key');
  const inPath = requireArg(argv, '--in');
  const root = rootOf(argv);
  const outPath = argOf(argv, '--out') || inPath.replace(/\.json$/i, '') + '.publish.json';
  const roster = loadPublishers(root);
  const entry = publisherFor(roster, classId);
  if (!entry) throw new Error('名册里没有这个班的发布者：' + classId);
  const obj = readJson(inPath);
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.experiments)) throw new Error('不是班级备份 JSON');
  const body = stripPublish(obj);
  const meta = {
    v: 1, class: classId, signer: entry.id, keyId: entry.keyId,
    issuedAt: new Date().toISOString()
  };
  const sig = ecSign('sha256', Buffer.from(canon({ payload: body, publish: meta }), 'utf8'), {
    key: createPrivateKey(fs.readFileSync(keyPath, 'utf8')),
    dsaEncoding: 'ieee-p1363'
  }).toString('base64');
  fs.writeFileSync(outPath, JSON.stringify({ ...body, _publish: { ...meta, sig } }, null, 2) + '\n', 'utf8');
  console.log(`已签名：${outPath}（class=${classId}，signer=${entry.id}）`);
}

function cmdVerify(argv) {
  const inPath = requireArg(argv, '--in');
  const root = rootOf(argv);
  const obj = readJson(inPath);
  const meta = obj && obj._publish;
  if (!meta || meta.v !== 1 || !meta.sig) throw new Error('缺少 _publish 签名');
  const roster = loadPublishers(root);
  const entry = publisherFor(roster, meta.class);
  if (!entry) throw new Error('名册里没有班级 ' + meta.class);
  if (entry.exp && entry.exp < new Date().toISOString().slice(0, 10)) throw new Error('班级发布授权已过期：' + entry.exp);
  if (meta.keyId && entry.keyId && meta.keyId !== entry.keyId) throw new Error('keyId 与名册不一致');
  const pub = fs.readFileSync(path.resolve(root, argOf(argv, '--pub') || `keys/publishers/${meta.class}.pub`), 'utf8');
  const ok = ecVerify('sha256',
    Buffer.from(canon({ payload: stripPublish(obj), publish: { v: meta.v, class: meta.class, signer: meta.signer, keyId: meta.keyId, issuedAt: meta.issuedAt } }), 'utf8'),
    { key: createPublicKey(pub), dsaEncoding: 'ieee-p1363' },
    Buffer.from(meta.sig, 'base64'));
  if (!ok) throw new Error('签名无效：文件被改过，或不是该班公钥签的');
  console.log(`OK: 班级发布签名有效（class=${meta.class}，signer=${meta.signer}，issuedAt=${meta.issuedAt}）`);
}

function main(argv) {
  const [cmd] = argv;
  try {
    if (cmd === 'keygen') return cmdKeygen(argv);
    if (cmd === 'sign') return cmdSign(argv);
    if (cmd === 'verify') return cmdVerify(argv);
    console.error('用法: node tools/publish-class.mjs <keygen|sign|verify> [参数]');
    process.exitCode = 1;
  } catch (error) {
    console.error('失败：' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
