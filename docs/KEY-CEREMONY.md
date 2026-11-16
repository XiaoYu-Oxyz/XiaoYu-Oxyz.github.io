# 密钥仪式（KEY CEREMONY）操作手册

> 目标：让"只有你能发布"这件事可重复、可验证、可交接。
> 所有命令都在仓库根目录执行；私钥**永远不要**写进仓库/聊天/云笔记。

## 0. 一次性准备

```bash
# 私钥放仓库外（Windows 示例：C:\Users\<你>\.crsecue\root-ed25519.pem）
node tools/release.mjs keygen --out C:\Users\<你>\.crsecue\root-ed25519.pem --keyid root-2026-11
```

输出会显示 **根公钥指纹**（例如 `9191 9F58 …`）。把它抄进：

- `README.md` 的安全小节（或班级群公告）；
- 你的密码管理器（和备份放在一起）。

## 1. 创建授权名册（只做一次）

```bash
node tools/release.mjs roster-init \
  --keyid root-2026-11 \
  --exp 2027-06-30 \
  --key C:\Users\<你>\.crsecue\root-ed25519.pem
```

生成 `keys/roster.json` + `keys/roster.sig`：名册目前只有 `admin` 一人，scope=`publish`，有效期到 2027-06-30。

## 2. 每次发布（你自己改数据时）

```bash
# 1) 改完 data/ 或 src/ 后重新构建
python tools/build.py
python tools/verify.py

# 2) 生成清单（release 自动 +1）
node tools/release.mjs manifest

# 3) 用私钥签名（同时写入 release/log.jsonl）
node tools/release.mjs sign --key C:\Users\<你>\.crsecue\root-ed25519.pem

# 4) 本地自检
node tools/release.mjs verify
```

然后把 `data/`、`src/`、`index.html`、`calendars/`、`release/` 一起提交并推送。

> **注意**：`release/manifest.json`、`release/manifest.sig`、`release/log.jsonl` 必须一起提交；三者任一缺失，CI 会拒绝。

## 3. 授权一个受托人（例：学委只能改 Z1）

1. 让对方在**自己的电脑**上生成密钥：

```bash
node tools/release.mjs keygen --out C:\Users\<对方>\.crsecue\z1.pem --keyid z1-2026-11
```

只把 **`keys/root.pub` 不被覆盖**——注意：`keygen` 会写仓库的 `keys/root.pub`，所以**不要让受托人在仓库副本里跑 keygen**。给对方单独发一个临时目录里的工具副本，或让对方用任意 Ed25519 工具生成、只把公钥 PEM 发你。

2. 你把公钥 PEM 存成文件（如 `z1.pub`），用**根私钥**登记：

```bash
node tools/release.mjs roster-add \
  --key C:\Users\<你>\.crsecue\root-ed25519.pem \
  --id commissary-z1 \
  --pub z1.pub \
  --scope data:Z1 \
  --exp 2027-01-31
```

3. 受托人改完数据后：

```bash
node tools/release.mjs manifest --signer commissary-z1
node tools/release.mjs sign --key C:\Users\<对方>\.crsecue\z1.pem --signer commissary-z1
```

提交 PR → **你 review 并批准** → 合并 → CI 验签 → 上线。

4. 学期结束/人员变动：

```bash
node tools/release.mjs roster-revoke --id commissary-z1 --key C:\Users\<你>\.crsecue\root-ed25519.pem
node tools/release.mjs manifest && node tools/release.mjs sign --key ...   # 让撤销生效的新版本
```

## 4. 迁移到硬件密钥（FIDO2，目标态）

1. 用 `ssh-keygen -t ed25519-sk -O resident -O application=ssh:crsecue` 生成硬件密钥；
2. 用新公钥重做 `roster-init`（root 换成新 keyId）；
3. 用新钥重签最新 manifest，旧钥 `roster-revoke`；
4. 更新 `keys/FINGERPRINT` 与 README 公示指纹。

> 当前 `release.mjs` 只支持 PEM 私钥。硬件密钥的签名/验签需要改用 `ssh-keygen -Y sign/verify` 路径，属于 P1 工具升级项；在升级前，硬件密钥可先用于 GitHub 账号 2FA。

## 5. 备份与恢复演练

- 私钥：密码管理器 + 离线加密备份（两份，异地）；
- 公钥/名册/清单：随仓库走；
- 每学期做一次"用备份密钥签一个空 release 再丢掉"的演练，确认备份可用。

## 6. 绝对不要做的事

- ❌ 把私钥贴进 Actions secrets / 环境变量 / 仓库文件；
- ❌ 在浏览器里保存私钥或"管理员密码"；
- ❌ 用微信/QQ 传私钥或公钥文件（公钥也要当面/扫码核对指纹）；
- ❌ 为了方便关闭 branch protection 的 "Do not allow bypassing"；
- ❌ 用同一个密钥既做发布签名又做别的事。
