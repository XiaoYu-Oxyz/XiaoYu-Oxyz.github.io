#!/usr/bin/env python3
"""生成离线班级签名页 sign.html（单文件、零依赖、零网络）。

用法：python tools/build-sign-page.py
读取 keys/publishers.json 与 keys/publishers/*.pub，把班级、signer、keyId、
到期日与公钥内联进页面，并按实际内联内容计算 CSP 的 sha256 哈希。

改动名册或公钥后必须重新运行本脚本，再重签 release。
"""
from __future__ import annotations

import base64
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

BASE = common.REPO_ROOT
OUT = BASE / "sign.html"

STYLE = """
:root { color-scheme: light dark; --bg:#f6f8fa; --card:#fff; --text:#24292f; --muted:#57606a; --line:#d0d7de; --accent:#0969da; --ok:#1a7f37; --bad:#a40e26; --warn:#9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --text:#c9d1d9; --muted:#8b949e; --line:#30363d; --accent:#58a6ff; --ok:#7ee2a8; --bad:#ffb3b0; --warn:#e3b341; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
main { max-width: 640px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
h1 { margin: 0 0 4px; font-size: 22px; }
p.lead { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
label { display: block; margin: 14px 0 6px; font-weight: 600; font-size: 14px; }
select, input[type=file] { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; font-size: 14px; }
button { margin-top: 18px; width: 100%; padding: 11px 14px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
#status { margin-top: 16px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 14px; display: none; }
#status.show { display: block; }
#status.ok { border-color: var(--ok); color: var(--ok); }
#status.bad { border-color: var(--bad); color: var(--bad); }
#status.warn { border-color: var(--warn); color: var(--warn); }
#result { margin-top: 16px; display: none; }
#result.show { display: block; }
#meta { color: var(--muted); font-size: 13px; margin: 8px 0; }
#download { display: inline-block; margin-top: 6px; padding: 9px 14px; border-radius: 8px; background: var(--ok); color: #fff; text-decoration: none; font-weight: 700; font-size: 14px; }
footer { max-width: 640px; margin: 16px auto 0; color: var(--muted); font-size: 12px; text-align: center; }
"""

SCRIPT = r"""
'use strict';

const CLASSES = __CLASSES__;

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('canonical JSON 只允许整数');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error('canonical JSON 不支持的类型：' + typeof value);
}

function base64ToBytes(text) {
  const binary = atob(String(text).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pemToBytes(pem) {
  return base64ToBytes(String(pem)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, ''));
}

async function importPrivateKey(pem) {
  if (!window.crypto || !crypto.subtle) throw new Error('当前浏览器不支持 WebCrypto，请换用新版 Chrome/Safari/Edge');
  return crypto.subtle.importKey('pkcs8', pemToBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
}

async function publicMatches(privateKey, publicPem) {
  const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey('spki', pemToBytes(publicPem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
  return privateJwk.x === publicJwk.x && privateJwk.y === publicJwk.y;
}

function normalizeMeta(classId, entry, override) {
  const meta = override || {
    v: 1,
    class: classId,
    signer: entry.id,
    keyId: entry.keyId,
    issuedAt: new Date().toISOString()
  };
  return { v: 1, class: meta.class, signer: meta.signer, keyId: meta.keyId, issuedAt: meta.issuedAt };
}

async function signPayload(privateKey, jsonText, meta) {
  const obj = JSON.parse(jsonText);
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.experiments)) {
    throw new Error('不是 CrseCue 班级备份 JSON（缺少 experiments 数组）');
  }
  const body = Object.assign({}, obj);
  delete body._publish;
  const data = new TextEncoder().encode(canonicalJson({ payload: body, publish: meta }));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data));
  const out = Object.assign({}, body, { _publish: Object.assign({}, meta, { sig: bytesToBase64(signature) }) });
  return { text: JSON.stringify(out, null, 2) + '\n', count: body.experiments.length };
}

async function signAsClass(classId, keyPem, jsonText) {
  const entry = CLASSES[classId];
  if (!entry) throw new Error('未知班级：' + classId);
  const privateKey = await importPrivateKey(keyPem);
  if (!(await publicMatches(privateKey, entry.pub))) {
    throw new Error('私钥与所选班级不匹配：请确认拿到的是 ' + classId + '.pem');
  }
  const obj = JSON.parse(jsonText);
  if (obj && obj.class && obj.class !== classId) {
    throw new Error('文件班级是 ' + obj.class + '，与所选 ' + classId + ' 不符');
  }
  const meta = normalizeMeta(classId, entry);
  const signed = await signPayload(privateKey, jsonText, meta);
  return Object.assign({ classId: classId, meta: meta }, signed);
}

function setStatus(kind, text) {
  const el = document.getElementById('status');
  el.className = kind ? 'show ' + kind : '';
  el.textContent = text || '';
}

function renderResult(result) {
  const resultBox = document.getElementById('result');
  const metaBox = document.getElementById('meta');
  const link = document.getElementById('download');
  const fileName = result.classId + '.publish.json';
  metaBox.textContent = '班级 ' + result.classId + ' · ' + result.count + ' 条 · 签发 ' + result.meta.issuedAt +
    ' · signer ' + result.meta.signer + ' · keyId ' + result.meta.keyId;
  const blob = new Blob([result.text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  link.textContent = '下载 ' + fileName;
  resultBox.classList.add('show');
}

async function readFileText(input) {
  const file = input.files && input.files[0];
  if (!file) throw new Error('请先选择文件');
  return file.text();
}

async function handleSign() {
  const button = document.getElementById('signBtn');
  button.disabled = true;
  setStatus('', '');
  document.getElementById('result').classList.remove('show');
  try {
    const classId = document.getElementById('classSelect').value;
    const keyPem = await readFileText(document.getElementById('keyInput'));
    const jsonText = await readFileText(document.getElementById('jsonInput'));
    const result = await signAsClass(classId, keyPem, jsonText);
    renderResult(result);
    setStatus('ok', '签名成功：请下载文件，上传到 GitHub Issue 并打 publish 标签。');
  } catch (error) {
    setStatus('bad', '签名失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    button.disabled = false;
  }
}

const button = document.getElementById('signBtn');
if (button) button.addEventListener('click', handleSign);

// 测试钩子：仅在自动化环境暴露，生产页面不存在。
if (navigator.webdriver) {
  window.__signRawForTest = async function (keyPem, jsonText, meta) {
    const privateKey = await importPrivateKey(keyPem);
    const signed = await signPayload(privateKey, jsonText, normalizeMeta(meta.class, { id: meta.signer, keyId: meta.keyId }, meta));
    return signed.text;
  };
}
"""

HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-{script_hash}'; style-src 'sha256-{style_hash}'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>CrseCue 班级签名</title>
<style>{style}</style>
</head>
<body>
<main>
  <h1>CrseCue 班级签名</h1>
  <p class="lead">给导出的班级数据签名，生成可上传的 <code>.publish.json</code>。私钥只在本地内存中，不联网、不上传。</p>
  <label for="classSelect">班级</label>
  <select id="classSelect">
{class_options}
  </select>
  <label for="keyInput">班级私钥（Z1.pem 等）</label>
  <input id="keyInput" type="file" accept=".pem,.key,.txt">
  <label for="jsonInput">页面导出的数据（Z1-数据-*.json）</label>
  <input id="jsonInput" type="file" accept=".json">
  <button id="signBtn" type="button">签名并生成文件</button>
  <div id="status" role="status"></div>
  <div id="result">
    <div id="meta"></div>
    <a id="download" href="#" download>下载</a>
  </div>
</main>
<footer>私钥不会被上传；请只在可信电脑上使用。签名后把文件拖进 GitHub Issue 并打 <code>publish</code> 标签。</footer>
<script>{script}</script>
</body>
</html>
"""


def b64_sha256(text: str) -> str:
    return base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def load_classes():
    roster = json.loads((BASE / "keys" / "publishers.json").read_text(encoding="utf-8"))
    classes = {}
    for item in roster.get("publishers", []):
        class_id = item["class"]
        pub_path = BASE / "keys" / "publishers" / (class_id + ".pub")
        if pub_path.exists():
            pub = pub_path.read_text(encoding="utf-8").strip()
        else:
            pub = item["pubkey"].strip()
        classes[class_id] = {
            "id": item["id"],
            "keyId": item["keyId"],
            "exp": item.get("exp", ""),
            "pub": pub,
        }
    return classes


def main() -> int:
    classes = load_classes()
    classes_json = json.dumps(classes, ensure_ascii=False, indent=2)
    script = SCRIPT.replace("__CLASSES__", classes_json)
    style = STYLE
    options = "\n".join(
        '    <option value="%s">%s（至 %s）</option>' % (cid, cid, data.get("exp", "长期"))
        for cid, data in classes.items()
    )
    html = HTML.format(
        script_hash=b64_sha256(script),
        style_hash=b64_sha256(style),
        style=style,
        script=script,
        class_options=options,
    )
    if "--check" in sys.argv[1:]:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != html:
            print("ERROR: sign.html 与 keys/publishers.json 不同步；跑 python tools/build-sign-page.py 重新生成")
            return 1
        print("OK: sign.html 与名册/公钥一致（%d classes）" % len(classes))
        return 0
    OUT.write_text(html, encoding="utf-8", newline="\n")
    print("built sign.html: %d classes, %d bytes" % (len(classes), len(html.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
