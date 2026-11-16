# 本机编辑授权（EDIT GRANT）

> 默认情况下页面只能看；要改本机数据，必须导入一份由管理员 P-256 私钥签名的 grant。
> 当前状态：**签发/验证工具已完成**；页面的"默认锁定 + 导入 grant 解锁"在下一个 PR。

## 1. 签发

```bash
node tools/sign-grant.mjs issue \
  --key C:\Users\Lenovo\.crsecue\data-admin-p256.pem \
  --out grant-Z1.json \
  --sub 学委名字 \
  --scope Z1,Z2 \
  --exp 2027-01-31 \
  --keyid data-admin.pub
```

## 2. 验证

```bash
node tools/sign-grant.mjs verify --pub keys/data-admin.pub --in grant-Z1.json
```

输出：`OK: 编辑授权有效（sub=…，scope=Z1,Z2，exp=…）`

## 3. 文件长什么样

```json
{
  "v": 1,
  "kind": "edit-grant",
  "sub": "学委名字",
  "scope": ["Z1", "Z2"],
  "exp": "2027-01-31",
  "keyId": "data-admin.pub",
  "alg": "ES256",
  "sig": "<raw r||s 64 字节 base64>"
}
```

- 签名对象 = 去掉 `sig` 后的 canonical JSON；
- 签名算法与数据包一致：ECDSA P-256 / SHA-256 / raw r||s（WebCrypto 兼容）。

## 4. 安全边界（诚实说明）

- grant 是**持有即授权**：文件被转给谁，谁就能在自己的浏览器里解锁编辑；
- 所以 grant 要当敏感文件对待：别发群、用完可让管理员换新 grant（旧的到期自然失效）；
- 它只控制"本机能不能改"，**不控制发布**——发布仍然需要管理员 PR 批准 + 离线签名；
- scope/exp 由页面检查；过期或换班后需要重新导入。
