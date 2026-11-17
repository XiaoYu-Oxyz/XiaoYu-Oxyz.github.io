# CrseCue 安全加固方案（已定版）

> 目标：**只有超级管理员（仓库 owner）批准、并用离线私钥签名的内容，才能出现在官方域名上；任何其他改动一律拒绝。**
> 约束：GitHub Pages 静态托管、公开仓库、Free 计划、零服务器、零 secrets。
> 本文是实施依据；具体操作见 [KEY-CEREMONY.md](KEY-CEREMONY.md)，事故处理见 [INCIDENT-RESPONSE.md](INCIDENT-RESPONSE.md)。

---

## 0. 一句话结论

> 当前根公钥指纹：`99BA 4A96 204A DA13 1D45 546C B7E5 7E00`（2026-11-16，软件密钥引导态；迁移硬件密钥后必须更新）。

**两把钥匙，缺一不可**：

1. **GitHub 治理钥匙**：`main` 只能通过 PR 合并，且必须你本人批准（分支保护 + CODEOWNERS + 禁止绕过）；
2. **密码学钥匙**：发布清单必须由你的离线密钥（或你签发授权的受托人密钥）签名，CI 验签失败即拒绝。

即使 GitHub 账号被钓鱼，攻击者没有你的离线私钥 → **签不出可发布的内容**；
即使私钥泄露，攻击者没有你的合并权 → **改不进 main**。
单点失守 ≠ 全面失守，这就是本方案的核心价值。

**"完全安全"不存在**：GitHub 平台、你的设备、CA/域名、浏览器 0day、用户主动访问仿冒站，都不在本方案可消除范围内。可承诺的是：在信任假设成立时，未授权内容无法上线，篡改必被发现（残余风险见 §8）。

---

## 1. 已选定的默认方案（决策记录）

| 编号 | 决策点 | 选定 | 理由 |
|---|---|---|---|
| D1 | Pages 发布方式 | **迁移到 GitHub Actions + OIDC 部署**（目标态）；迁移完成前保持"分支发布 + 合并门禁" | 构建 job 不拿 `pages:write`，只有验签通过的部署 job 能上线；需你在 Settings 切换（见 §7） |
| D2 | 受托人自动合并 | **不允许**。受托人只能提交，合并永远需要你 PR 批准 | "必须我授权"的最直接实现 |
| D3 | 浏览器端编辑 | **保留本机编辑**（只影响自己），但标注"本机草稿，不影响他人"；**导入未签名数据要强警告/拒绝**（P1） | 锁死本机编辑只会伤正常用户（看错字想改）；真实边界在发布链路 |
| D4 | 根密钥载体 | **目标态：FIDO2 硬件密钥（SSH sk-ed25519）**；当前引导态：本机生成的 Ed25519 软件密钥（仓库外，mode 600） | 硬件密钥需购买；先用软件密钥把门禁跑通，买到后按 §6 轮换 |
| D5 | 签名算法 | 仓库侧 Ed25519（Node 内置 crypto，零依赖）；浏览器侧验签用 **ECDSA P-256**（WebCrypto 兼容 Chrome 60 / iOS 12） | Ed25519 的 WebCrypto 太新，会破兼容底线 |
| D6 | 透明日志 | **git 内 hash chain（`release/log.jsonl`）+ 外部锚点（DNS TXT 或第二个仓库）**；Sigstore/Rekor 作为 P2 可选 | 零成本、离线可验；Sigstore 身份是"workflow"不是"你"，不能替代管理员授权 |
| D7 | 受托人范围 | 按班级/学期授权：`scope=["data:Z1"]`、`exp=学期末`；名册由你签名 | 最小权限 + 自动过期 |
| D8 | 域名 | **建议启用自定义域名 + DNS TXT 永久保留**（防接管）；未启用前用 `*.github.io` 亦可 | 安全I 的 P0 项；需要你提供域名 |

### 与两份参考资料的差异（重要）

- **不把 Cosign keyless 当授权根**：keyless 的身份是 workflow，任何能改 workflow 的人都能让 CI 签出合法签名，无法表达"只有你授权"。它只能作为额外的部署来源证明。
- **不签 commit SHA**：squash/rebase 合并会改 SHA，安全I 的 `commit_sha` 绑定在合并后失效。本方案签 **内容树哈希 + 单调 release 计数器 + 时间**，commit 只写入日志。
- **保留 CSP 内联哈希**：单文件下 `style-src/script-src 'sha256-…'` 比 `'self'` 更强，不改成外部资源。
- **元 CSP 不支持 `frame-ancestors`**：点击劫持属于残余风险（见 §8）。

---

## 2. 信任根与授权模型

```
根私钥（离线，你的）
  └─ 签名 keys/roster.json ── 列出允许的 signer（admin / 受托人）、scope、exp、revoked
        └─ 每个 signer 用自己私钥签 release/manifest.json
              └─ CI：root.pub → roster 签名 → manifest 签名 → 计数器/前链 → 文件哈希
                    └─ 全部通过才允许部署
```

- **根公钥指纹**固定在 `keys/FINGERPRINT`，并在 README/群公告中公示；`verify` 会比对。
- **名册**改动必须由根私钥重新签名；`keys/` 在 CODEOWNERS 里只允许你改。
- **撤销**：`roster-revoke` 把条目移入 `revoked` 并重签；当前清单里该 signer 立即失效。
- **重放/回滚**：`release` 计数器严格递增，`prev` 指向上一版清单哈希；旧签名无法复用。
- **受托人**：自己生成密钥 → 线下把公钥交给你 → 你用根私钥 `roster-add` 登记 scope/exp → 他提交 PR（含签名）→ **你批准** → 上线。

## 3. 受保护范围（manifest 覆盖什么）

`data/**`、`src/**`、`calendars/**`、`index.html`、`tools/build.py`、`tools/verify.py`、`tools/common.py`、`tools/release.mjs`、`keys/root.pub`、`keys/roster.json`、`keys/FINGERPRINT`。

- 任何这些文件被改动而没重新签名 → CI 直接失败；
- 目录里**新增**未登记文件 → 失败（防夹带）；
- 文档/测试不在范围内（改 README 不需要重签，减少摩擦）。

文本文件哈希前统一 **CRLF→LF 归一化**，保证 Windows 工作区与 Linux CI 得到同一个哈希；xlsx 等二进制按原始字节。

## 4. CI 门禁（fail-closed）

`verify.yml` 的 build job 第一步就是：

```
node tools/release.mjs verify
```

校验顺序：根公钥指纹 → 名册签名 → 清单签名者/授权/过期/撤销 → 清单签名 → release 单调 + prev 链 + 日志摘要 → 文件哈希与文件集合 → treeHash。
任何一项失败 → 构建 job 失败 → 不产生可部署产物。

另：`node tests/release.test.mjs` 有 8 条负向用例（篡改文件、夹带新文件、改名册、冒名、过期、重放、撤销）。

## 5. 运行时要做什么（P1，尚未实现）

- 默认体验不变，但编辑/导入处增加一句「**本机修改不会影响他人，发布需管理员签名**」；
- 导入 JSON/xlsx 时校验签名：无签名 → 红色警告"来源未认证"（P1 实现）；
- 页面页脚显示 **release 号 + 签名者 + 根指纹短码**，便于同学核对；
- 独立验签器（P2）：一个页面/脚本，任何人可对收到的文件验签。

## 6. 密钥生命周期

| 阶段 | 操作 |
|---|---|
| 生成 | 仓库外生成；私钥进密码管理器/硬件密钥；公钥 + 指纹进仓库 |
| 备份 | 两份离线（硬件 + 加密备份）；恢复演练每学期一次 |
| 轮换 | 每学期或人员变动：生成新钥 → 新 roster → 新 release → 旧钥撤销 |
| 泄露 | 立即 `roster-revoke` + 重签 + 公告 + 复盘（见 INCIDENT-RESPONSE） |
| 迁移硬件 | 买到 FIDO2 钥匙后：用新钥重做 ceremony，旧钥撤销；签名命令改为 `ssh-keygen -Y sign`（工具支持后再切换） |

## 7. 你需要在 GitHub 上做的设置（我无法代做）

1. **账号**：2FA 开启（优先硬件密钥/passkey），保存恢复码；
2. **分支保护 / Ruleset（main）**：Require PR、Require approvals=1、Require review from Code Owners、Require status checks（build + ui + visual 全选）、禁止 force push、禁止 bypass、linear history；
3. **Actions**：Settings → Actions → General：Fork PR 需手动批准、默认 token 只读、不允许 `pull_request_target`；
4. **Pages**：切到 **Source: GitHub Actions**（切完跑一次 `deploy.yml` 的手动 dispatch）；启用自定义域名时加 DNS TXT 验证并永久保留；
5. 装 **Dependabot alerts / secret scanning**（公开仓库免费）。

## 8. 残余风险（诚实清单）

| 风险 | 严重度 | 能否消除 | 缓解 |
|---|---|---|---|
| 你的电脑被控 / 私钥被偷 | 高 | 否 | 硬件密钥触摸签名、专用干净环境、离线备份 |
| GitHub 账号被攻破 | 高 | 部分 | 硬件 2FA、禁止 bypass、离线签名仍拦发布 |
| GitHub 平台 / CA 被攻破 | 中 | 否 | 外部锚点 + 独立验签器 |
| 用户访问仿冒站 | 高（现实高发） | 否 | 官方短链/二维码、页面指纹、群公告教育 |
| 班级自助发布（路线 2） | 中 | 部分 | 班级 P-256 私钥在班委；CI 发布密钥在 Actions secret；PR 仍需管理员 Merge；见 docs/CLASS-PUBLISH.md |
| 浏览器 0day / 供应链 | 中 | 否 | CSP、Trusted Types、actions SHA 固定、Dependabot |
| 点击劫持（meta CSP 限制） | 低 | 否 | 不建议嵌入；残余接受 |
| 你本人恶意 | — | 否 | 超出技术方案 |

## 9. 分阶段验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0（已完成 2026-11-16） | 签名工具 + 名册 + manifest + CI 门禁 + CODEOWNERS + 负向测试 + 文档 + 每日哨兵 | `node tools/release.mjs verify` 通过；篡改任一受保护文件 CI 红 |
| P1 | 托管人流程、撤销/轮换演练（已完成）、Actions OIDC 部署（已完成）、每日哨兵 + 失败自动开 Issue（已完成）、运行时导入验签（已完成）；域名 TXT 因无域名暂缓 | 受托人提交 → 你批准 → 上线；线上被改次日告警（哨兵每日 03:17 UTC） |
| P2 | 独立验签器、DNS 锚点、Sigstore 可选、硬件密钥 ceremony | 同学可自行验证收到的文件 |

## 10. 班级自助发布（方案 B）的残余风险

- 班委私钥泄露 → 该班可被任意改并发上线；
- `RELEASE_SIGNING_KEY` 放在 Actions secret → 云端持有发布能力；
- 自动合并需要对 bot 放开分支保护 bypass → 保护强度下降；
- 无人工逐次批准，审计依赖 PR/Issue/Actions 三方记录。
- 当前状态见 [CLASS-PUBLISH.md](CLASS-PUBLISH.md) §5：转换器与自动合并尚未端到端验证。

