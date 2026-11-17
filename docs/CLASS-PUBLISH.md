# 班级自助发布（CLASS PUBLISH，路线 2）

> 目标：班委改完本班数据，签个名、传到 Issue，CI 验签并**自动开 PR**；管理员点一下 **Merge** 即上线。
> **不自动合并、不 push main、不用 bot/PAT、不需要 ruleset bypass。**
> 安全等级仍低于"管理员离线签名发布"：CI 持有发布密钥，班级私钥在班委手里。

## 1. 信任链

```
管理员根钥（离线 Ed25519）
  └─ keys/publishers.json（班级 → P-256 公钥 → 有效期）由根钥签名
        └─ 班委用本班 P-256 私钥签 Z1.publish.json（_publish，raw r||s）
              └─ CI：验签 → 只允许改本班 → JSON→xlsx → 构建
                    └─ 用 Actions secret 里的 CI 发布密钥（Ed25519，roster 登记）签 release
                          └─ 自动开 PR → 管理员点 Merge
```

关键文件：

| 文件 | 作用 |
|---|---|
| `keys/publishers.json` + `keys/publishers.sig` | 班级发布者名册（根钥签名） |
| `keys/publishers/<班级>.pub` | 班级 P-256 公钥 |
| `keys/ci-release.pub` + `keys/roster.json` | CI 发布密钥公钥（scope=publish，exp） |
| `tools/publish-class.mjs` | keygen / sign / verify |
| `tools/publish-class-convert.py` | `.publish.json` → `data/<班级>.xlsx` |
| `.github/workflows/publish-class.yml` | 验签 → 转换 → 构建 → 签名 → 开 PR |

## 2. 管理员一次性配置

1. **标签**：Issues → Labels → 新建 `publish`（模板会引用它，必须先存在）。
2. **允许 Actions 建 PR**：Settings → Actions → General → 勾选 *Allow GitHub Actions to create and approve pull requests*。
3. **CI 发布密钥**（仓库外生成，已生成可跳过）：
   ```bash
   node tools/release.mjs keygen \
     --out C:\Users\<你>\.crsecue\ci-release.pem \
     --pub keys/ci-release.pub --keyid ci-release
   node tools/release.mjs roster-add --key C:\Users\<你>\.crsecue\root-ed25519.pem \
     --id ci-release --pub keys/ci-release.pub --scope publish --exp 2027-06-30
   ```
   然后用根钥重签跑一次 release（`build --release N` → `manifest` → `sign`）。
4. **Secret**：Settings → Secrets and variables → Actions → New secret
   - Name：`RELEASE_SIGNING_KEY`
   - Value：`ci-release.pem` 的**全文**（PEM，含首尾行）
   - 不要用根密钥。
5. **班级公钥登记**：把每个班的 `keys/publishers/<班级>.pub` 写进 `keys/publishers.json`（class / id / keyId / exp / pubkey），用根钥重签 `keys/publishers.sig`。

> 不需要 ruleset bypass，也不需要自动合并配置。

## 3. 班委每次操作

1. 页面解锁（grant）→ 改本班数据 → 操作 → 导出 → JSON；
2. 本地签名（只需一次安装 Node）：
   ```bash
   node tools/publish-class.mjs sign --class Z1 \
     --key C:\Users\<班委>\.crsecue\Z1-publish.pem \
     --in Z1-数据-YYYY-MM-DD.json --out Z1.publish.json
   ```
3. GitHub → Issues → **New issue** → 选模板 **「班级数据发布」**（模板会自动加 `publish` 标签，不需要任何仓库权限）；
4. 下拉选自己的班级，把 `Z1.publish.json` **拖进「签名文件」框**，等附件上传完成；
5. 点 **Submit new issue**；
6. 等 1–2 分钟：CI 自动开 PR 并在 Issue 里回复；管理员点 **Merge** 后上线。

> 已成功处理过的 Issue 会带 `<!-- crsecue-publish:done -->` 评论标记，重复触发（opened + labeled）会被自动跳过。
> 失败不会写该标记，修好后重新打 `publish` 标签即可重试。

## 4. CI 流程（`.github/workflows/publish-class.yml`）

1. 触发：`issues: [opened, labeled]`——用模板新建（标签随创建自带，走 opened）或手动打 `publish` 标签（走 labeled）；也可 `workflow_dispatch` 填 Issue 号；
   并发按 Issue 串行；已含 `crsecue-publish:done` 评论的 Issue 直接跳过；正文没有附件链接也跳过；
2. `gh issue view` 读正文 → 正则找 `github.com/.../user-attachments/assets/...` 或 `/assets/...` 附件 → `curl` 下载；
3. `node tools/publish-class.mjs verify --in publish.json`：根签名 → 班级公钥 → `_publish` 签名 → exp / keyId；
4. `python tools/publish-class-convert.py`：JSON → `data/<班级>.xlsx`（只写“实验安排/班级信息”两个 sheet）；
5. `python tools/build.py --release <next>` → `manifest --signer ci-release` → 用 `RELEASE_SIGNING_KEY` 写临时文件 → `sign --signer ci-release` → `verify`（签名者必须是 roster 里的 `ci-release`，不能是 `admin`）；
6. `git status` 校验只改了 `data/<班级>.xlsx`、`index.html`、`calendars/*`、`release/*`；
7. 建分支 `publish/<班级>-<run_id>` → commit → push → `gh pr create`；
8. Issue 回评论；失败时回评论并给出运行链接。

## 5. 风险（必须接受）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 班委私钥泄露 | 该班数据可被改并走 CI 发布 | 私钥只在本机；到期失效；从 publishers.json 删除并重签 |
| `RELEASE_SIGNING_KEY` 泄露 | 可发布任意班 | 只在 workflow 内使用；轮换 roster 密钥；审计 Actions |
| 班委误操作 | 错误数据进 PR | PR 需管理员点 Merge；可关闭 PR；有 issue/PR 记录 |
| CI 被投毒 | 可伪造发布 | actions 固定 SHA、CODEOWNERS、workflow 改动需管理员批准 |
| 审计变弱 | 少一道人工闸门 | PR + Issue + release/log 三方对照 |

## 6. 已验证 / 未验证

- ✅ `publish-class.mjs` 签发/验证 + 6 条负向测试（改班、换钥、过期、越界、keyId）；
- ✅ `publish-class-convert.py` + Python 测试（sheet、列、行数、class 不匹配）；
- ✅ 示例名册 `keys/publishers.json`（Z1 示例公钥，需替换真实班委公钥）；
- ✅ CI 发布密钥 `ci-release` 已登记 roster（scope=publish，exp 2027-06-30）；
- ⚠️ **未端到端跑过真实 Issue**（需要管理员配置 secret 后手动试一次）；
- ⚠️ 附件下载依赖 GitHub 公共附件 URL，私有附件场景未覆盖。

## 7. 演练步骤（管理员）

1. 配好 `RELEASE_SIGNING_KEY`、`publish` 标签、允许 Actions 建 PR；
2. 用示例 Z1 私钥签一个 `Z1.publish.json`；
3. 新建 Issue → 拖附件 → 打 `publish`；
4. 看 Actions：验签、转换、构建、签名、开 PR 是否全绿；
5. 点 Merge，确认线上页脚 release 号递增、数据条数正确。

## 班委签名页（sign.html）

`https://xiaoyu-oxyz.github.io/sign.html`：单文件、零依赖、CSP 哈希保护，
班委不装 Node 即可把导出的 JSON 签成 `Z1.publish.json`。
签名格式与 `tools/publish-class.mjs sign` 完全一致（canonical JSON + P-256 raw r||s）。

- 页面由 `tools/build-sign-page.py` 从 `keys/publishers.json` 生成；
- 名册/公钥变更后必须重新生成并重签 release；
- CI 用 `python tools/build-sign-page.py --check` 防止页面过期。

