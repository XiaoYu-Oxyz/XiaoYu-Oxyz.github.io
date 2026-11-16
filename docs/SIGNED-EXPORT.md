# 数据包签名（SIGNED EXPORT）

> 目的：管理员/受托人导出的班级 JSON，可以被任何同学**独立验证**"是不是官方发的、有没有被改过"。
> 现状：CLI 签名/验证 + **页面导入自动验签**（release 3）均已完成；未签名文件仍可导入（页面不会主动验，见 §7 的诚实说明）。

## 0. 为什么是 ECDSA P-256，不是 Ed25519

| 算法 | Node 签名 | 浏览器 WebCrypto 验签 | 兼容底线 |
|---|---|---|---|
| Ed25519 | ✅ | Chrome 113+ / Safari 17+ | ❌ 破 Chrome 60 / iOS 12 |
| **ECDSA P-256** | ✅ | Chrome 37+ / Safari 11+ | ✅ |

仓库发布清单（`release/manifest.json`）仍用 Ed25519（只在 CI/Node 里验），
数据包签名用 P-256（将来要在浏览器里验），两者分工不同。

## 1. 密钥

- 私钥：`C:\Users\Lenovo\.crsecue\data-admin-p256.pem`（仓库外，mode 600）
- 公钥：`keys/data-admin.pub`（随仓库提交，可公开）
- keyId：`data-admin-2026-11`

生成（只做一次）：

```bash
node tools/sign-export.mjs keygen \
  --out C:\Users\Lenovo\.crsecue\data-admin-p256.pem \
  --pub keys/data-admin.pub \
  --keyid data-admin-2026-11
```

> 私钥不要进仓库、不要进 Actions secrets、不要发微信；备份进密码管理器。

## 2. 签名一个导出文件

```bash
# 1) 先在页面里导出 JSON（例如 Z1-20261116.json）
# 2) 用私钥签名
node tools/sign-export.mjs sign \
  --key C:\Users\Lenovo\.crsecue\data-admin-p256.pem \
  --in Z1-20261116.json \
  --out Z1-20261116.signed.json \
  --signer admin \
  --keyid data-admin-2026-11
```

生成的文件在原 JSON 上多一个字段：

```json
"_crsecue": { "v": 1, "signer": "admin", "keyId": "data-admin-2026-11", "alg": "ES256", "sig": "<base64 DER>" }
```

签名对象 = 去掉 `_crsecue` 后的 **canonical JSON**（key 排序），所以字段顺序变化不影响验签。

## 3. 任何同学都能验证

```bash
node tools/sign-export.mjs verify \
  --pub keys/data-admin.pub \
  --in Z1-20261116.signed.json
```

输出：

```
OK: 签名有效（signer=admin，keyId=data-admin-2026-11，实验 12 条）
```

失败场景：

| 情况 | 输出 |
|---|---|
| 内容被改 | `签名无效：内容被改过，或不是这把公钥签的` |
| 未签名 | `未签名：文件里没有 _crsecue 字段` |
| 换公钥 | `签名无效` |

> 验证只需要公钥和文件本身，不需要联网、不需要装依赖（Node 内置 crypto）。

## 4. 受托人签名

1. 受托人自己生成 P-256 密钥（**在仓库副本之外**跑 keygen，别覆盖 `keys/data-admin.pub`）；
2. 公钥当面交给管理员，管理员登记到 `keys/roster.json`（scope/exp）；
3. 受托人用自己的私钥签名导出文件，`--signer` 填自己的 id。

## 5. 路线图

- [x] P-256 签名/验证 CLI（本文件）
- [x] 5 条负向测试（篡改、换钥、未签名、字段重排）
- [x] 页面导入时自动验签（WebCrypto，release 3）
- [x] 公钥随构建注入页面（`keys/data-admin.pub` → `defaultData.dataKeys`）
- [x] 把 `keys/data-admin.pub` 纳入发布清单（release 3，26 个文件）

## 6. 不要做的事

- ❌ 把 P-256 私钥写进仓库或 Actions；
- ❌ 用"隐藏字段/私有格式"代替签名（都能被改）；
- ❌ 只在前端判断"是不是管理员"（前端可被改，真正的边界是签名与发布链路）。

## 7. 页面内验签（release 3 起）

导入 JSON 时，如果文件带 `_crsecue`：

1. 按 `keyId` 找页面内置的 `defaultData.dataKeys`；
2. 用 WebCrypto 的 ECDSA P-256 验签（`canonicalJson(去掉 _crsecue 的对象)`）；
3. **验签失败 → 直接拒绝导入**，状态栏显示「签名无效：文件可能被改过，已阻止导入」；
4. 验签成功 → 正常导入，状态栏多一行「数据包签名已校验：admin」。

诚实说明：

- **未签名文件仍然可以导入**（不弹警告），因为本机备份/同学自己导出的文件本来就无法签名；
- 页面内验签只能防"签名文件被改"，防不了"把签名直接删掉变成未签名文件"——那种情况需要用户自己看状态栏或先用 CLI 验证；
- 老浏览器没有 `crypto.subtle` 时，带签名的文件会被拒绝（fail-closed），未签名文件不受影响。
