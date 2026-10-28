# 安全说明（GitHub Pages 严格加固版）

本目录是“实验课提醒”单文件静态应用的安全加固版本，目标是在**零成本、仅 GitHub Pages** 的前提下，做到静态客户端应用可达到的最严格安全配置。

## 1. 文件

| 文件 | 说明 |
| --- | --- |
| `实验提醒V2.html` | 源文件（开发/维护用） |
| `index.html` | GitHub Pages 部署入口，与源文件字节一致 |
| `verify-csp.py` | 校验/重算 CSP 哈希，并同步 `index.html` |
| `.gitattributes` | 强制 HTML/Python/Markdown 使用 LF，避免 GitHub Pages 上的哈希失配 |
| `.editorconfig` | 强制 UTF-8、LF，避免 BOM/CRLF 破坏哈希 |
| `.nojekyll` | 阻止 Jekyll 处理，保证 GitHub Pages 按原始字节提供文件 |
| `.gitignore` | 避免提交导出的 xlsx、备份等 |

## 2. 已实施的安全控制

### 2.1 CSP（meta，GitHub Pages 可用）

- `default-src 'none'`，除下列放行外全部禁止。
- 内联 `<style>` / `<script>` 使用 SHA-256 哈希放行；禁止 `'unsafe-inline'`、`'unsafe-hashes'`、`'unsafe-eval'`。
- `script-src-elem` / `style-src-elem` 使用同一哈希；`script-src-attr 'none'`、`style-src-attr 'none'` 禁止内联事件和 style 属性。
- `img-src`、`font-src`、`connect-src`、`media-src`、`object-src`、`frame-src`、`child-src`、`worker-src`、`manifest-src` 均为 `'none'`。
- `base-uri 'none'`、`form-action 'none'`、`upgrade-insecure-requests`。
- `require-trusted-types-for 'script'`，并且 `trusted-types xlsx-xml`：只允许一个受控策略，专门用于把已经过大小/DTD 校验的 xlsx XML 交给 `DOMParser`；不允许其它 Trusted Types 策略。
- `<meta name="referrer" content="no-referrer">`。
- 页面没有外部脚本、样式、字体、图片或网络请求。

### 2.2 Trusted Types / DOM

- 不使用 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function`、字符串定时器、`javascript:` URL、内联事件属性。
- 表格、空状态、导入摘要、状态/确认/错误提示全部用 `createElement`、`textContent`、`setAttribute` 构建。
- 动态内容（实验名称、地点、节次、导入文件名、localStorage 数据）一律按文本渲染，不拼 HTML/属性/URL。
- 仅保留一个 Trusted Types 策略 `xlsx-xml`，用于 `DOMParser` 解析 xlsx XML；策略内再次检查大小和 `<!DOCTYPE`/`<!ENTITY`。
- `window.top !== window.self` 时做一次尽力而为的防嵌套跳转；它不能替代 `frame-ancestors`/`X-Frame-Options`，且可被 sandboxed iframe 绕过。

### 2.3 xlsx 导入/导出

- 文件大小上限 10MB；校验 ZIP magic（`PK\x03\x04`），不只信扩展名。
- ZIP 条目上限 512；单条目解压上限 20MB；总解压上限 50MB；压缩比上限 1000；`DecompressionStream` 流式读取，超限立即取消（防 ZIP bomb）。
- 只读取白名单条目：`xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/sharedStrings.xml`、`xl/worksheets/*.xml`；其它条目（图片、主题等）直接跳过，不解压。
- 拒绝 `../`/绝对路径规范化后的越界条目、重复条目；加密、ZIP64、未知压缩方式安全报错。
- 校验 CRC32；限制 XML 大小 12MB；拒绝 `<!DOCTYPE`/`<!ENTITY`（防实体膨胀/XXE）；检查 XML parsererror。
- 限制行数 5000、列数 64、单元格文本 2000 字符、共享字符串数量/总量；防御巨大 `row r=""` 造成的稀疏数组/内存爆炸。
- 导入字段限制：节次 100、名称 200、地点 200 字符；周次 1–1000；超限行跳过并提示。
- 导出全部使用 `inlineStr` 文本，`=` `+` `-` `@` 开头的值不会变成公式；导入只读缓存值，不执行公式。
- 导入文件名只做文本展示并限长。

### 2.4 localStorage

- 键名带项目唯一前缀：`ghpages:zhizao2402:experiments:v1`、`ghpages:zhizao2402:week1:v1`。
- 兼容读取旧键 `zhizao2402_experiments_v1` / `zhizao2402_week1_start_v1` 并迁移到新键；不丢失数据。
- 空数组是有效状态（用户删光数据后刷新仍为空），旧键不会覆盖新键。
- 校验 JSON schema、日期格式、类型、长度、条数上限（5000）；损坏数据回退旧键或默认；捕获 QuotaExceeded。
- 恢复默认数据会同时清除新旧实验键。
- 同源说明见“残余风险”。

## 3. 验证

- 136 项自动化断言全部通过，覆盖：
  - CSP/Trusted Types：`innerHTML` 被拒绝、只允许 `xlsx-xml` 策略、注入脚本被阻止、无外部资源、无网络请求、无 style/内联事件属性。
  - 添加实验：周次/日期联动、提交、XSS 文本化、长度/周次上限校验。
  - 删除模式：标记、完成、撤销、提示。
  - xlsx 合法文件：openpyxl（内联字符串 + 日期）、XlsxWriter（共享字符串 + 日期）、内联/1904/周次/前置空行。
  - xlsx 恶意样本：ZIP bomb、DTD/ENTITY、巨大行号、超长单元格、重复条目、CRC 错误、随机字节、超大文件；全部安全拒绝。
  - UI 导入：文件名 XSS、表格 XSS、非法文件、超大文件；数据不变、弹窗不出现/文本化。
  - 导出后再导入往返 23 条。
  - localStorage 迁移、空数组优先、损坏回退、无效日期过滤、存储 XSS 文本化、旧键迁移、恢复清理。
  - 空状态、第 1 周设置。
- 导出的 `.xlsx` 通过 openpyxl 校验，并被 LibreOffice 正常打开/转 CSV。
- `python verify-csp.py` 校验源文件和 `index.html` 的 CSP 哈希及限制，并确认两者字节一致。

## 4. 哈希维护（重要）

GitHub Pages 按仓库字节提供 HTML；任何对 `<style>` 或 `<script>` 的修改都会使 CSP 哈希失配，页面会被浏览器拦截。

修改源文件后执行：

```bash
python verify-csp.py --apply
python verify-csp.py
```

`--apply` 会：

1. 按最终 UTF-8/LF 字节重算 `<style>`/`<script>` 的 SHA-256；
2. 更新 CSP meta 里的哈希；
3. 把源文件同步为 `index.html`。

要求：

- 保持 LF、无 BOM；`.gitattributes`/`.editorconfig` 已设置，不要用会转 CRLF/BOM 的编辑器覆盖。
- `.nojekyll` 必须保留，避免 Jekyll 处理改变字节。
- 提交前运行 `python verify-csp.py`，并确认输出 `OK`。
- 部署后打开 DevTools Console，确认没有 `Refused to execute inline script` / `Refused to apply inline style`。

当前哈希（以 `verify-csp.py` 输出为准）：

- script: `OtFSrBx7faNyGd1uZuaIsN+Fjly/+xPa4AesT5a+oyE=`
- style:  `08l0Fw6T0CBRiZQkwmWtV07vawHmu76pQwpIEIP11is=`

## 5. 部署到 GitHub Pages

1. 确保提交 `index.html`、`.nojekyll`、`.gitattributes`、`verify-csp.py`、`SECURITY.md`。
2. 不要提交：导出的 `*.xlsx`、备份、测试 fixture、`.DS_Store`、个人数据。`.gitignore` 已覆盖常见项。
3. GitHub 仓库设置开启 2FA、分支保护；静态站点优先直接分支部署，不使用 Actions；如必须用 Actions，固定 action SHA、最小权限、不要存长期凭据。
4. Settings → Pages → Deploy from a branch → 根目录；开启 **Enforce HTTPS**。
5. 部署后检查：
   - 页面正常显示 23 条默认数据；
   - Console 无 CSP/Trusted Types 报错；
   - 添加、删除/撤销、导入、导出、恢复默认、第 1 周设置正常；
   - DevTools Network 中无外部请求；
   - `view-source` 中的 CSP 哈希与当前文件一致。
6. 数据迁移：`file://`、`https://<user>.github.io`、自定义域名的 localStorage 互不相通。发布前在旧环境用“导出 Excel”备份，发布后用“导入 Excel”恢复；不要把个人实验数据硬编码进 HTML/仓库。

## 6. 残余风险（GitHub Pages 限制）

以下控制 GitHub Pages **无法通过响应头实现**，本文件也没有伪造它们：

- **点击劫持**：没有 `frame-ancestors`（meta 不支持）和 `X-Frame-Options`；只有可被绕过的 JS frame-buster，不能视为可靠防护。
- **HSTS**：没有 `Strict-Transport-Security`；只能在仓库设置中启用 Enforce HTTPS，无法预加载（preload 需要自有域名）。
- **Permissions-Policy**：无法设置，不能显式禁用摄像头/麦克风/地理位置等；本应用不使用这些 API。
- **COOP / COEP / CORP**：无法设置；本应用没有跨源资源，风险较低。
- **X-Content-Type-Options**：无法设置；GitHub Pages 以 `text/html` 提供 `.html`，且无用户上传。
- **CSP reporting**：meta 不支持 `report-uri`；本应用不做外部上报（隐私/零成本）。
- **同源 localStorage**：GitHub Pages 项目站点共享 `https://<user>.github.io` 源，同账号其它项目可能读取/覆盖这些键。已使用项目前缀，但无法在路径级隔离；不要在公共电脑保存敏感信息。
- **客户端边界**：这是纯客户端应用，拥有浏览器/DevTools 的用户可以修改自己的数据；安全控制的目标是防止恶意 HTML/脚本执行、存储污染、xlsx 解析 DoS 等，而不是保护用户自己。
- **Trusted Types 浏览器支持**：Chromium/Edge 强制执行；Firefox/Safari 可能忽略 Trusted Types 指令。代码本身已移除 HTML sink，CSP 仍然有效。
- **免费 GitHub Pages** 没有企业级 WAF/DDoS 防护；仓库和默认实验数据是公开的。
- **xlsx 限制**：加密、ZIP64、超过大小/行/列/文本上限的文件会被拒绝；这是安全取舍，不是网络问题。

如果将来必须获得可靠的安全响应头，需要把同一份 `index.html` 部署到支持自定义响应头的免费静态托管（如 Cloudflare Pages / Netlify 免费层的 `_headers`），或使用自有域名 + 可控代理；这超出“仅 GitHub Pages”的当前范围。
