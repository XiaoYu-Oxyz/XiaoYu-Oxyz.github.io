#!/usr/bin/env node
/**
 * CrseCue 发布签名工具（零依赖，只用 Node 内置 crypto）。
 *
 * 信任模型（详见 docs/SECURITY-PLAN.md）：
 *   根密钥（离线 Ed25519）→ 签名 keys/roster.json（授权名册）
 *   → 每个发布用 roster 里的 signer 私钥签 release/manifest.json
 *   → CI 只验签、不持有任何私钥；验签失败即拒绝发布（fail-closed）。
 *
 * 子命令：
 *   keygen --out <私钥路径> [--keyid root-2026-11]
 *       生成 Ed25519 密钥对：私钥写到仓库外，公钥写 keys/root.pub 与 keys/FINGERPRINT
 *   roster-init --keyid <id> --exp <YYYY-MM-DD> [--role root]
 *       用根私钥创建/覆盖 keys/roster.json（只含 root 条目）并签名
 *   roster-add --key <私钥> --id <id> --pub <公钥文件> --scope <scope> --exp <YYYY-MM-DD>
 *       追加受托人条目并重新签名（需要根私钥）
 *   roster-revoke --key <私钥> --id <id>
 *       把条目移入 revoked 并重新签名（需要根私钥）
 *   manifest [--release N]
 *       计算受保护文件的哈希，生成 release/manifest.json（未签名）
 *   sign --key <私钥> [--signer admin]
 *       签名 manifest 并追加 release/log.jsonl（需要 signer 私钥）
 *   verify
 *       完整校验：root.pub 自洽 → roster 签名 → manifest 签名 → 计数器/前链 → 文件哈希与文件集合
 *   fingerprint
 *       打印根公钥指纹
 *
 * 私钥默认从环境变量 CRSECUE_ROOT_KEY 或 --key 参数读取，绝不写入仓库。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CRSECUE_REPO_ROOT
  ? path.resolve(process.env.CRSECUE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INCLUDE_DIRS = ['data', 'src', 'calendars'];
const INCLUDE_FILES = [
  'index.html',
  'tools/build.py',
  'tools/verify.py',
  'tools/common.py',
  'tools/release.mjs',
  'keys/root.pub',
  'keys/data-admin.pub',
  'keys/roster.json',
  'keys/FINGERPRINT'
];
const MANIFEST = 'release/manifest.json';
const MANIFEST_SIG = 'release/manifest.sig';
const LOG = 'release/log.jsonl';
const ROSTER = 'keys/roster.json';
const ROSTER_SIG = 'keys/roster.sig';
const ROOT_PUB = 'keys/root.pub';
const FINGERPRINT = 'keys/FINGERPRINT';

function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const BINARY_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.png', '.jpg', '.jpeg', '.ico', '.zip']);

/** 文本文件按 LF 归一化后再哈希：Windows 工作区的 CRLF 与 CI 的 LF 必须得到同一个值。 */
function sha256File(file) {
  const buf = fs.readFileSync(file);
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return sha256Bytes(buf);
  return sha256Bytes(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

/** 确定性 JSON：对象 key 排序、递归、禁止浮点。签名与验签必须用同一份。 */
export function canon(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('canonical JSON 只允许整数：' + value);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  throw new Error('canonical JSON 不支持的类型：' + typeof value);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('~$')) continue; // Excel 锁文件
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 受保护文件清单（相对仓库根，正斜杠），用于生成/校验 manifest。 */
export function protectedFiles(root = ROOT) {
  const files = new Set();
  for (const dir of INCLUDE_DIRS) {
    for (const full of walk(path.join(root, dir))) files.add(path.relative(root, full).replace(/\\/g, '/'));
  }
  for (const rel of INCLUDE_FILES) {
    if (fs.existsSync(path.join(root, rel))) files.add(rel);
  }
  return [...files].sort();
}

export function computeFiles(root = ROOT) {
  const result = {};
  for (const rel of protectedFiles(root)) {
    result[rel] = 'sha256:' + sha256File(path.join(root, rel));
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function publicKeyFromPem(pem) {
  return createPublicKey(pem);
}

export function fingerprintOf(pem) {
  const der = publicKeyFromPem(pem).export({ type: 'spki', format: 'der' });
  const hex = sha256Bytes(der).toUpperCase();
  return hex.match(/.{1,4}/g).slice(0, 8).join(' ');
}

function loadPrivate(file) {
  return createPrivateKey(fs.readFileSync(file, 'utf8'));
}

function signCanonical(privateKey, value) {
  return edSign(null, Buffer.from(canon(value), 'utf8'), privateKey).toString('base64');
}

function verifyCanonical(publicPem, value, signatureB64) {
  return edVerify(null, Buffer.from(canon(value), 'utf8'), publicKeyFromPem(publicPem), Buffer.from(signatureB64, 'base64'));
}

function manifestDigest(manifest) {
  return 'sha256:' + sha256Bytes(Buffer.from(canon(manifest), 'utf8'));
}

function readLog(root = ROOT) {
  const file = path.join(root, LOG);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function expectedSigner(roster, id) {
  return (roster.signers || []).find(s => s.id === id) || null;
}

function isRevoked(roster, id) {
  return (roster.revoked || []).some(r => r.id === id);
}

/** 纯函数校验，供 CLI 与测试共用。返回错误数组（空 = 通过）。 */
export function verifyRelease(root = ROOT) {
  const errors = [];
  const abs = rel => path.join(root, rel);

  if (!fs.existsSync(abs(ROOT_PUB))) return ['缺少 ' + ROOT_PUB + '：尚未执行密钥仪式'];
  const rootPem = fs.readFileSync(abs(ROOT_PUB), 'utf8');

  if (fs.existsSync(abs(FINGERPRINT))) {
    const pinned = fs.readFileSync(abs(FINGERPRINT), 'utf8').trim();
    const actual = fingerprintOf(rootPem);
    if (pinned !== actual) errors.push('根公钥指纹与 ' + FINGERPRINT + ' 不一致（公钥被换过？）');
  } else {
    errors.push('缺少 ' + FINGERPRINT + '：无法固定根公钥指纹');
  }

  if (!fs.existsSync(abs(ROSTER)) || !fs.existsSync(abs(ROSTER_SIG))) {
    return errors.concat(['缺少授权名册或名册签名']);
  }
  const roster = readJson(abs(ROSTER));
  const rosterSig = readJson(abs(ROSTER_SIG));
  if (rosterSig.keyId !== 'root') errors.push('roster.sig 必须由 root 密钥签名');
  if (!verifyCanonical(rootPem, roster, rosterSig.sig)) errors.push('授权名册签名无效（roster 被改过？）');

  if (!fs.existsSync(abs(MANIFEST)) || !fs.existsSync(abs(MANIFEST_SIG))) {
    return errors.concat(['缺少发布清单或清单签名']);
  }
  const manifest = readJson(abs(MANIFEST));
  const manifestSig = readJson(abs(MANIFEST_SIG));
  if (manifestSig.schema !== 1 || manifestSig.alg !== 'ed25519') errors.push('manifest.sig 格式不正确');
  if (manifest.schema !== 1) errors.push('manifest.schema 必须为 1');

  const signer = expectedSigner(roster, manifest.signer);
  if (!signer) {
    errors.push('清单签名者不在授权名册里：' + manifest.signer);
  } else {
    if (isRevoked(roster, signer.id)) errors.push('签名者已被撤销：' + signer.id);
    if (signer.exp && manifest.issuedAt && signer.exp < String(manifest.issuedAt).slice(0, 10)) {
      errors.push('签名者授权已于 ' + signer.exp + ' 过期，清单签发于 ' + manifest.issuedAt);
    }
    if (!verifyCanonical(signer.pubkey, manifest, manifestSig.sig)) errors.push('发布清单签名无效（manifest 被改过？）');
  }

  // 计数器与前链（防重放/回滚）
  const log = readLog(root);
  const last = log.length ? log[log.length - 1] : null;
  const digest = manifestDigest(manifest);
  if (last) {
    // 日志里最后一条必须就是当前清单（清单与 log 一起提交，不允许清单在 log 之外）
    if (last.manifestSha !== digest) errors.push('当前清单不在发布日志里（或日志被截断/回滚）');
    if (last.n !== manifest.release) errors.push('release 计数器不一致：清单=' + manifest.release + '，日志=' + last.n);
    if (last.prev !== manifest.prev) errors.push('prev 与日志记录不一致（可能被回滚）');
  } else if (manifest.release !== 1 || manifest.prev !== null) {
    errors.push('首次发布必须是 release=1 且 prev=null');
  }
  const logChain = checkLogChain(log);
  errors.push(...logChain);

  // 文件哈希与文件集合
  const actual = computeFiles(root);
  const listed = manifest.files || {};
  const missing = Object.keys(actual).filter(rel => !listed[rel]);
  const extra = Object.keys(listed).filter(rel => !actual[rel]);
  const changed = Object.keys(listed).filter(rel => actual[rel] && listed[rel] !== actual[rel]);
  if (missing.length) errors.push('受保护目录里出现未签名文件：' + missing.slice(0, 5).join(', '));
  if (extra.length) errors.push('清单里有已被删除的文件：' + extra.slice(0, 5).join(', '));
  if (changed.length) errors.push('受保护文件内容与签名不符：' + changed.slice(0, 5).join(', '));

  if (!errors.length) {
    const recomputedTree = 'sha256:' + sha256Bytes(Buffer.from(canon(manifest.files || {}), 'utf8'));
    if (manifest.treeHash !== recomputedTree) errors.push('treeHash 与 files 不一致');
  }
  return errors;
}

function checkLogChain(log) {
  const errors = [];
  for (let i = 0; i < log.length; i += 1) {
    const e = log[i];
    if (e.n !== i + 1) errors.push('日志序号不连续：第 ' + (i + 1) + ' 条 n=' + e.n);
    if (i === 0 && e.prev !== null) errors.push('日志首条 prev 必须为 null');
    if (i > 0 && e.prev !== log[i - 1].manifestSha) errors.push('日志第 ' + (i + 1) + ' 条 prev 与上一条不符');
  }
  return errors;
}

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function requireArg(argv, name) {
  const value = argOf(argv, name);
  if (!value) throw new Error('缺少参数 ' + name);
  return value;
}

function cmdKeygen(argv) {
  const out = requireArg(argv, '--out');
  const keyId = argOf(argv, '--keyid') || 'root-2026-11';
  if (fs.existsSync(out)) throw new Error('私钥已存在，拒绝覆盖：' + out);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, privPem, { mode: 0o600 });
  fs.mkdirSync(path.join(ROOT, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ROOT_PUB), pubPem, 'utf8');
  fs.writeFileSync(path.join(ROOT, FINGERPRINT), fingerprintOf(pubPem) + '\n', 'utf8');
  console.log('私钥已写到仓库外：' + out + '（mode 600）');
  console.log('根公钥指纹：' + fingerprintOf(pubPem));
  console.log('keyId：' + keyId + '（写进 roster 时使用）');
}

function cmdRosterInit(argv) {
  const keyId = requireArg(argv, '--keyid');
  const exp = requireArg(argv, '--exp');
  const role = argOf(argv, '--role') || 'root';
  const keyPath = argOf(argv, '--key') || process.env.CRSECUE_ROOT_KEY;
  if (!keyPath) throw new Error('缺少根私钥：--key 或环境变量 CRSECUE_ROOT_KEY');
  const pubPem = fs.readFileSync(path.join(ROOT, ROOT_PUB), 'utf8');
  const roster = {
    schema: 1,
    issuedAt: new Date().toISOString().slice(0, 10),
    signers: [{
      id: 'admin', role, keyId, scope: ['publish'], exp,
      pubkey: pubPem.trim()
    }],
    revoked: []
  };
  const key = loadPrivate(keyPath);
  const sig = { schema: 1, signer: 'root', keyId: 'root', alg: 'ed25519', sig: signCanonical(key, roster) };
  writeJson(path.join(ROOT, ROSTER), roster);
  writeJson(path.join(ROOT, ROSTER_SIG), sig);
  console.log('已创建并签名 ' + ROSTER + '（root 授 权 admin，exp=' + exp + '）');
}

function cmdRosterAdd(argv) {
  const keyPath = argOf(argv, '--key') || process.env.CRSECUE_ROOT_KEY;
  if (!keyPath) throw new Error('缺少根私钥');
  const id = requireArg(argv, '--id');
  const pubFile = requireArg(argv, '--pub');
  const scope = (argOf(argv, '--scope') || 'data').split(',').map(s => s.trim()).filter(Boolean);
  const exp = requireArg(argv, '--exp');
  const roster = readJson(path.join(ROOT, ROSTER));
  if (expectedSigner(roster, id)) throw new Error('该 id 已存在：' + id);
  roster.signers.push({ id, role: 'delegate', keyId: 'delegate-' + id, scope, exp, pubkey: fs.readFileSync(pubFile, 'utf8').trim() });
  roster.revoked = (roster.revoked || []).filter(r => r.id !== id);
  const key = loadPrivate(keyPath);
  writeJson(path.join(ROOT, ROSTER), roster);
  writeJson(path.join(ROOT, ROSTER_SIG), { schema: 1, signer: 'root', keyId: 'root', alg: 'ed25519', sig: signCanonical(key, roster) });
  console.log('已授权 ' + id + '（scope=' + scope.join('+') + '，exp=' + exp + '）');
}

function cmdRosterRevoke(argv) {
  const keyPath = argOf(argv, '--key') || process.env.CRSECUE_ROOT_KEY;
  if (!keyPath) throw new Error('缺少根私钥');
  const id = requireArg(argv, '--id');
  const roster = readJson(path.join(ROOT, ROSTER));
  if (!expectedSigner(roster, id)) throw new Error('名册里没有 ' + id);
  roster.signers = roster.signers.filter(s => s.id !== id);
  roster.revoked = [...(roster.revoked || []), { id, at: new Date().toISOString().slice(0, 10) }];
  const key = loadPrivate(keyPath);
  writeJson(path.join(ROOT, ROSTER), roster);
  writeJson(path.join(ROOT, ROSTER_SIG), { schema: 1, signer: 'root', keyId: 'root', alg: 'ed25519', sig: signCanonical(key, roster) });
  console.log('已撤销 ' + id);
}

function cmdManifest(argv) {
  const log = readLog();
  const next = argOf(argv, '--release') ? Number(argOf(argv, '--release')) : (log.length ? log[log.length - 1].n + 1 : 1);
  const last = log.length ? log[log.length - 1] : null;
  const files = computeFiles();
  const manifest = {
    schema: 1,
    release: next,
    issuedAt: new Date().toISOString(),
    signer: argOf(argv, '--signer') || 'admin',
    files,
    treeHash: 'sha256:' + sha256Bytes(Buffer.from(canon(files), 'utf8')),
    prev: last ? last.manifestSha : null
  };
  writeJson(path.join(ROOT, MANIFEST), manifest);
  console.log('已生成 ' + MANIFEST + '：release=' + next + '，文件数=' + Object.keys(files).length);
}

function cmdSign(argv) {
  const keyPath = argOf(argv, '--key') || process.env.CRSECUE_ROOT_KEY;
  if (!keyPath) throw new Error('缺少签名私钥：--key 或环境变量 CRSECUE_ROOT_KEY');
  const signerId = argOf(argv, '--signer') || 'admin';
  const manifest = readJson(path.join(ROOT, MANIFEST));
  if (manifest.signer !== signerId) throw new Error('manifest.signer=' + manifest.signer + ' 与 --signer=' + signerId + ' 不一致');
  const roster = readJson(path.join(ROOT, ROSTER));
  const signer = expectedSigner(roster, signerId);
  if (!signer) throw new Error('签名者不在名册：' + signerId);
  const key = loadPrivate(keyPath);
  const sig = { schema: 1, signer: signerId, keyId: signer.keyId, alg: 'ed25519', sig: signCanonical(key, manifest) };
  writeJson(path.join(ROOT, MANIFEST_SIG), sig);

  const log = readLog();
  const last = log.length ? log[log.length - 1] : null;
  if (last && manifest.release !== last.n + 1) throw new Error('release 必须递增到 ' + (last.n + 1));
  const entry = {
    n: manifest.release,
    prev: last ? last.manifestSha : null,
    manifestSha: manifestDigest(manifest),
    signer: signerId,
    issuedAt: manifest.issuedAt
  };
  log.push(entry);
  fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, LOG), log.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log('已签名 release ' + manifest.release + '（signer=' + signerId + '，log 条目 ' + log.length + '）');
}

function cmdVerify() {
  const errors = verifyRelease(ROOT);
  if (errors.length) {
    for (const e of errors) console.error(' - ' + e);
    console.error('发布签名校验失败：' + errors.length + ' 项（拒绝发布）');
    process.exitCode = 1;
    return;
  }
  const manifest = readJson(path.join(ROOT, MANIFEST));
  console.log('OK: 发布签名校验通过（release=' + manifest.release + '，文件 ' + Object.keys(manifest.files).length + ' 个，signer=' + manifest.signer + '）');
}

function cmdFingerprint() {
  const pem = fs.readFileSync(path.join(ROOT, ROOT_PUB), 'utf8');
  console.log(fingerprintOf(pem));
}

function main(argv) {
  const [cmd] = argv;
  switch (cmd) {
    case 'keygen': return cmdKeygen(argv);
    case 'roster-init': return cmdRosterInit(argv);
    case 'roster-add': return cmdRosterAdd(argv);
    case 'roster-revoke': return cmdRosterRevoke(argv);
    case 'manifest': return cmdManifest(argv);
    case 'sign': return cmdSign(argv);
    case 'verify': return cmdVerify();
    case 'fingerprint': return cmdFingerprint();
    default:
      console.error('用法: node tools/release.mjs <keygen|roster-init|roster-add|roster-revoke|manifest|sign|verify|fingerprint> [参数]');
      process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURLSafe(process.argv[1])) {
  main(process.argv.slice(2));
}

function pathToFileURLSafe(p) {
  if (!p) return '';
  return new URL('file://' + path.resolve(p).replace(/\\/g, '/')).href;
}
