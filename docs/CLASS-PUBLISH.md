# 班级自助发布（CLASS PUBLISH）

> 目标：班委改完本班数据，签个名上传，CI 验签后自动发布——不需要管理员逐次合并。
> 安全等级：**低于“管理员离线签名发布”**。本文同时是风险确认书。

## 1. 信任链

```
管理员根密钥（离线 Ed25519）
  └─ 签名 keys/publishers.json（班级 → P-256 公钥 → 有效期）
        └─ 班委用本班私钥签 Z1.publish.json（_publish 字段，raw r||s）
              └─ CI 验签 + 校验只改本班 → 构建 → 用 Actions secret 里的发布密钥签 release
                    └─ 自动开 PR 并 squash merge（需要 bot 绕过分支保护）
```

## 2. 角色与操作

### 管理员（一次性）

1. 为每班生成发布密钥（班委电脑上执行，私钥不出本机）：
   ```bash
   node tools/publish-class.mjs keygen --class Z1 \
     --out C:\Users\<班委>\.crsecue\Z1-publish.pem \
     --pub keys/publishers/Z1.pub
   ```
2. 把公钥登记进 `keys/publishers.json`（class/id/pubkey/exp），用根钥重签 `keys/publishers.sig`；
3. 生成一把 Ed25519“CI 发布密钥”，把私钥放进仓库 secret `RELEASE_SIGNING_KEY`；
4. 把该密钥的公钥加入 `keys/roster.json`（scope 限 `publish`，exp 学期末），根钥重签 roster；
5. 建标签 `publish`；给 GitHub Actions bot 开 ruleset bypass（仅此 workflow 使用）；
6. 开启 Settings → Actions → “Allow GitHub Actions to create and approve pull requests”。

### 班委（每次）

1. 页面解锁（grant）→ 改本班数据 → 操作 → 导出 → JSON；
2. 本地签名：
   ```bash
   node tools/publish-class.mjs sign --class Z1 \
     --key C:\Users\<你>\.crsecue\Z1-publish.pem \
     --in Z1-数据-2026-11-20.json --out Z1.publish.json
   ```
3. 新建 GitHub Issue，标题 `[publish] Z1 数据更新`，把 `Z1.publish.json` 拖进 Issue 正文作为附件，加标签 `publish`；
4. 等 1–2 分钟，机器人自动发布；失败会评论原因。

## 3. 风险（必须接受）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 班委私钥泄露 | 该班数据可被任意改并自动上线 | 私钥只在本机；到期失效；泄露后从 publishers.json 删除并重签 |
| `RELEASE_SIGNING_KEY` 泄露 | 可发布任意班 | 仅 workflow 可读；轮换钥匙；审计 Actions 日志 |
| 自动合并绕过分支保护 | 保护形同虚设 | bypass 只给 bot 且只在 `publish` 触发时使用 |
| 班委误操作 | 错误数据直接上线 | 发布前 CI 校验 schema/条数；保留 revert 记录 |
| 审计变弱 | 无人工逐次批准 | PR 记录 + Issue 记录 + 发布日志三方对照 |

## 4. CI 流程（publish-class.yml）

1. 触发：Issue 打上 `publish` 标签（或 workflow_dispatch 带附件 URL）；
2. 从 Issue 正文提取唯一 `.publish.json` 附件链接并下载；
3. `node tools/publish-class.mjs verify`：根签名 → 班级公钥 → `_publish` 签名 → exp；
4. 校验改动范围：只允许 `data/<class>.xlsx` 与构建产物；
5. `python tools/build.py --release <next>` → `manifest` → 用 `RELEASE_SIGNING_KEY` 写临时文件并 `sign`；
6. `gh pr create` + `gh pr merge --squash --auto`；失败则保留 PR 并评论。

## 5. 当前实现状态（诚实）

- ✅ `tools/publish-class.mjs`：keygen / sign / verify，已用示例密钥实测通过；
- ✅ `keys/publishers.json` + `keys/publishers.sig`（示例 Z1 公钥，需替换成真实班委公钥）；
- ✅ 本文档；
- ⚠️ `.github/workflows/publish-class.yml`：骨架已写，但 **JSON→xlsx 转换器未实现**，端到端自动发布尚不可用；
- ⚠️ 未创建 secret、未配置 ruleset bypass（需管理员在 GitHub 操作）；
- ⚠️ 未写自动化测试（`publish-class` 依赖仓库内固定 roster，测试需先抽出可注入的 roster 路径）。

## 6. 下一步（按顺序）

1. 写 `tools/publish-class.mjs convert`（JSON → `data/<class>.xlsx`，用现有 openpyxl 依赖，保持列顺序与 build 读取一致）；
2. 抽 `loadPublishers(root)` 支持 `--root` 便于测试，补 `tests/publish-class.test.mjs`（签发/改班/换钥/过期）；
3. 完成 workflow 的下载/验签/转换/构建/签名/自动合并，并在测试仓库演练；
4. 管理员按 §2 完成 secret 与 bypass 配置。
