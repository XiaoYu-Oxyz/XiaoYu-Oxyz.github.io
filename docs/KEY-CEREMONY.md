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
# 0) 先算这一版的 release 号：日志最后一条 +1（第一次是 1）
# 1) 构建（页脚不再显示 release 号，--release 可省略；release 号在 manifest/log 里）
python tools/build.py
python tools/verify.py

# 2) 生成清单（必须用同一个号，否则清单里的 index.html 哈希对不上）
node tools/release.mjs manifest --release 2

# 3) 用私钥签名（同时写入 release/log.jsonl）
node tools/release.mjs sign --key C:\Users\<你>\.crsecue\root-ed25519.pem

# 4) 本地自检 + 复现校验
node tools/release.mjs verify
python tools/build.py --check
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

## 6. 演练（每学期一次，5 分钟）

```bash
# 自动演练：受托人签发 / 撤销 / 篡改 / 根密钥轮换 四条路径
node tests/security-drills.mjs
```

手工演练（更接近真实）：

1. 生成一把测试受托人密钥（在仓库副本**之外**）；
2. `roster-add` 登记，签发一版看 CI 是否放行；
3. `roster-revoke` 撤销，再跑 `verify`，应看到"签名者不在名册"；
4. 把结果记在 `docs/重构记录.md` 对应轮次里。

## 7. 绝对不要做的事

- ❌ 把私钥贴进 Actions secrets / 环境变量 / 仓库文件；
- ❌ 在浏览器里保存私钥或"管理员密码"；
- ❌ 用微信/QQ 传私钥或公钥文件（公钥也要当面/扫码核对指纹）；
- ❌ 为了方便关闭 branch protection 的 "Do not allow bypassing"；
- ❌ 用同一个密钥既做发布签名又做别的事。
