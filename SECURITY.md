# 安全说明（GitHub Pages 严格加固版）

本目录是“实验课提醒”静态应用的安全加固版本：运行时仍是单文件 `index.html`；默认数据来自 `data/*.xlsx` 与 `data/设置.json`，构建时写入页面内的惰性 `<template>`。目标是在**零成本、仅 GitHub Pages** 的前提下，做到静态客户端应用可达到的最严格安全配置。

## 1. 文件

| 文件 | 说明 |
| --- | --- |
| `data/*.xlsx` | 每班一个 xlsx（当前 `Z1.xlsx` 22 条、`Z2.xlsx` 24 条、`Z5.xlsx` 10 条）；文件名去掉 `.xlsx` 就是班级名 |
| `data/设置.json` | 全局设置：`{"version":1,"week1":"2026-08-31"}` |
| `build-html.py` | 用 Python + openpyxl 读 `data/`，写入 `<template id="defaultData">`，生成源文件和 `index.html`，再运行 verify |
| `requirements.txt` | 构建依赖：`openpyxl>=3.1,<4`；网页运行不需要 |
| `实验提醒.html` | 构建后的源文件（开发/维护用） |
| `index.html` | GitHub Pages 部署入口，与源文件字节一致 |
| `verify-csp.py` | 校验 CSP 哈希、模板 JSON、默认数据解析和安全限制；`--apply` 重算代码哈希并同步 `index.html` |
| `.gitattributes` | HTML/Python/Markdown/JSON 使用 LF；xlsx 标记为 binary，避免损坏 |
| `.editorconfig` | 强制 UTF-8、LF，避免 BOM/CRLF 破坏哈希 |
| `.nojekyll` | 阻止 Jekyll 处理，保证 GitHub Pages 按原始字节提供文件 |
| `.gitignore` | 忽略导出的 xlsx、备份；`data/*.xlsx` 仍然提交 |

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
- 动态内容（实验名称、地点、节次、班级名、导入文件名、localStorage 数据）一律按文本渲染，不拼 HTML/属性/URL。
- 班级下拉框的 `<option>` 用 `createElement` + `textContent` 生成；班级名来自文件名，也不拼 HTML。
- 仅保留一个 Trusted Types 策略 `xlsx-xml`，用于 `DOMParser` 解析 xlsx XML；策略内再次检查大小和 `<!DOCTYPE`/`<!ENTITY`。
- 已移除 JS frame-buster：它在 iframe/预览环境可能把顶层导航到 404，且本身可被绕过；点击劫持作为残余风险处理，不伪装成可靠防护。

### 2.3 xlsx 导入/导出

- 每个班一个 xlsx：文件名去掉 `.xlsx` 就是班级名；只读第一个工作表，sheet 名随意。
- 表头必须含 `节次`、`实验名称`、`实验地点`；时间列可用 `日期`，或同时用 `周次`+`星期`，至少保留其中一组。两组时间列可只出现一组，也可同时存在。
- 每行独立判断时间：`周次`+`星期`有效时优先；否则回退到有效 `日期`；`周次`/`星期`不完整或无效但日期有效时用日期；两组都没有有效时间时整次导入/build 失败。
- 如果两组都填且周次+星期有效，以周次+星期为准；周次+星期无效/不完整时回退日期；日期无效但周次+星期有效时用周次+星期。
- 页面导入遇到没有有效时间的行会整次失败，不写入任何数据；`build-html.py` 同样失败，且不覆盖 `index.html`。
- 导出当前班用 `${班级}.xlsx`，sheet 名固定 `实验安排`；空班也导出只有表头的空表。
- 导入一个班文件，默认合并；文件名与当前班不一致时，默认按文件名切换/新建，也可以选择忽略文件名导入当前班。
- 文件大小上限 10MB；校验 ZIP magic（`PK\x03\x04`），不只信扩展名。
- ZIP 条目上限 512；单条目解压上限 20MB；总解压上限 50MB；压缩比上限 1000；`DecompressionStream` 流式读取，超限立即取消（防 ZIP bomb）。
- 只读取白名单条目：`xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/sharedStrings.xml`、`xl/worksheets/*.xml`；其它条目（图片、主题等）直接跳过，不解压。
- 拒绝 `../`/绝对路径规范化后的越界条目、重复条目；加密、ZIP64、未知压缩方式安全报错。
- 校验 CRC32；限制 XML 大小 12MB；拒绝 `<!DOCTYPE`/`<!ENTITY`（防实体膨胀/XXE）；检查 XML parsererror。
- 限制行数 5000、列数 64、单元格文本 2000 字符、共享字符串数量/总量；防御巨大 `row r=""` 造成的稀疏数组/内存爆炸。
- 导入字段限制：节次 100、名称 200、地点 200 字符；周次 1–1000；字段超限由页面导入跳过并提示，build 直接失败。
- 导出全部使用 `inlineStr` 文本，`=` `+` `-` `@` 开头的值不会变成公式；导入只读缓存值，不执行公式。
- 导入文件名、班级名只做文本展示并限长。
- `build-html.py` 用 openpyxl 读取本地 `data/*.xlsx`；这是构建机上的可信数据源，构建前会严格校验日期、表头、字段长度、控制字符和重复班级；不是浏览器上传入口。

### 2.4 localStorage

- 项目前缀：`ghpages:zhizao2402:`。
- 每个班的数据键：`ghpages:zhizao2402:classdata:v1:<encodeURIComponent(班级名)>`；另有 `week1:v1`、`selected-class:v1`、`extra-classes:v1`。
- 旧单班键 `ghpages:zhizao2402:experiments:v1` 和 `zhizao2402_experiments_v1` 在选中 Z2 时自动迁移到 Z2 的班级键；旧 `week1` 键继续作为全局设置。
- 空数组是有效状态（用户删光某班数据后刷新仍为空）；每班数据独立校验日期、类型、长度、条数上限（5000）。
- 损坏的班级数据回退模板/默认；保存失败会提示，刷新后可能恢复。
- “恢复默认数据”只恢复当前班的内置数据；本地新建、尚未 build 的班禁用恢复。
- 顶部“编辑实验”和“删除实验”是两个互斥模式：
  - 删除模式：每行左侧圆圈，可多选；点“完成”立即删除，状态栏提供“撤销”；
  - 编辑模式：每行左侧铅笔，点击打开预填弹窗；保存后留在编辑模式，状态栏提供“撤销编辑”。
- 进入模式时默认取消本周筛选勾选并显示全部；复选框仍可主动勾选；退出后恢复进入前的筛选状态。
- 模式下禁用班级选择、第 1 周、添加/导入/导出/恢复；两个模式按钮互相禁用；筛选复选框保持可用。
- “删除实验”不再跳转 404；`404.html` 只用于访问不存在的路径。
- 只在本机 localStorage 保存草稿；部署默认数据来自 `data/` 构建。
- 同源说明见“残余风险”。

### 2.5 外部 xlsx、设置与构建

- 默认数据不再写死在 `<script>` 中，而是构建时写入页面内惰性的 `<template id="defaultData">` JSON。`<template>` 内容不会执行、不会渲染，也不参与 `<script>`/`<style>` 的 CSP 哈希。
- `data/*.xlsx` 是实验数据发布源；班级名 = 文件名去掉 `.xlsx`；每个文件只读第一个工作表，sheet 名随意；表头必须含 `节次/实验名称/实验地点`，时间列用 `日期` 或 `周次+星期`，至少一组。
- `data/设置.json` 是全局 week1 发布源；简单 JSON，不进 xlsx。
- `build-html.py` 校验日期、表头、字段长度、控制字符、重复班级，把 `<`、`>`、`&` 转义成 `\u003c`/`\u003e`/`\u0026`，避免 `</template>`、`<img>` 或实体注入。
- 构建只改模板数据，不改 `<script>`/`<style>`，所以**数据变化不需要重算 CSP 哈希**。
- 构建同时写入 `实验提醒.html` 和 `index.html`，然后运行 `verify-csp.py`。
- 运行时仍然是单文件、无 fetch、`connect-src 'none'`，可完全离线；`data/` 只在构建时读取。
- 第 1 周设置全局共用：页面修改立即对本机所有班生效并保存 localStorage；部署默认值需要更新 `data/设置.json` 后 build。页面不能写仓库文件；“恢复默认数据”不清 week1。
- 班级名不限制字符（以操作系统允许的文件名为准）；页面显示和 xlsx 走文本/固定 sheet，不拼 HTML。新班级可以往 `data/` 放 xlsx 后 build；页面导入时新建的班只在本机保留，导出该班 xlsx 并 build 后才成为部署默认。
- `data/*.xlsx`、`data/设置.json` 和 `index.html` 都会进入公开仓库/Pages，数据就是公开的；不要放敏感数据。

## 3. 验证

- 本轮多班级改造后，90 项 UI/数据回归通过，覆盖：
  - 班级下拉：Z1/Z2、首次选 Z1、切换、记住上次选择、刷新后数据/选择保持；
  - Z1 空表、Z2 23 条（90 项回归时的数据；当前 Z2 为 24 条）、按班添加与按班持久化；
  - 旧批量删除模式：禁用班级下拉、按班标记/完成/按班撤销；当前已恢复为正式删除模式，并新增编辑模式；
  - 恢复当前班、恢复清当前班存储、恢复不影响其它班；
  - 导入目标：默认按文件名、当前班（忽略文件名）、同班合并、已存在他班切换、新建本机班级；
  - 空班导出仅表头、Z2 导出 24 行（90 项回归时；当前 Z2 24 条对应 25 行）、文件名 `${班级}.xlsx`；
  - week1 全局、旧单班数据迁移到 Z2、旧键清理；
  - 无 JSON 入口、CSP/Trusted Types、无外部资源、无 style/内联事件。
- 以上 90 项回归在 Z1 空、Z2 23 条的数据上跑通；当前 `data/` 为 Z1 22 条、Z2 24 条、Z5 10 条。编辑/删除模式已完成回归：删除立即生效并可撤销；编辑保存后留在模式内并可撤销；模式退出恢复筛选。build 当前 3 个班、56 条。
- UI 筛选/手机布局回归：
  - 顶部“已结束仅显示本周”默认勾选；
  - Z2 当前显示 14 / 共 24，取消勾选显示 24 / 24，刷新后恢复勾选；
  - Z1 当前显示 14 / 共 22，取消勾选显示 22 / 22；
  - Z5 全部在未来，显示 10 / 10；
  - 390px / 820px / 900px 宽度下无横向滚动，表格变成两行列表；941px 起恢复桌面表格；
  - 筛选只影响显示，导出仍导出该班全部数据。
- 日期/周次规则回归（本轮新增，build 与页面导入都跑过）：
  - 只有日期列：通过；
  - 只有周次+星期列：通过并按 week1 推算日期；
  - 两组都有：日期、周次+星期逐行混用通过；
  - 两组都有且都有效：周次+星期优先；
  - 周次+星期无效、日期有效：回退日期；
  - 日期无效、周次+星期有效：用周次+星期；
  - 周次+星期只填一半、日期有效：回退日期；
  - 两组都没有有效时间：build 和页面导入都失败；
  - 日期列 + 只有周次/星期表头：用日期；
  - 只有周次或只有星期表头且没有日期：失败；
  - 缺 `节次/实验名称/实验地点` 表头：失败。
- 刷新测试：选择 Z2 后刷新仍是 Z2；Z2 新增数据保留；导入新建的 Z3 刷新后仍出现，恢复按钮保持禁用；build 后 Z3 变成内置班，恢复按钮启用。
- build 验证：
  - `data/Z3.xlsx`、`data/A&B.xlsx`（任意班级名、任意 sheet 名）构建成功；
  - 名称含 `<img>` 的数据在页面按文本显示，无 img/svg、无脚本执行；
  - 非法日期构建失败，`index.html` 保持不变；
  - 修改 `data/设置.json` 的 week1 后构建，页面默认 week1 随之更新；
  - 数据构建前后 script/style 哈希不变，`verify-csp.py` 通过。
- xlsx 导出仍通过 openpyxl/LibreOffice 验证；本轮 xlsx 解析/写入代码沿用加固版。
- 之前加固版的 136 项 xlsx 安全/存储测试作为基线；本轮改造保留了 xlsx 解析限制和字段校验。
- `python verify-csp.py` 会检查默认数据模板是否为合法 JSON、每个班级条目是否合法、默认数据解析代码是否存在，以及源文件与 `index.html` 的 CSP 哈希和字节一致性。

## 4. 哈希维护（重要）

数据放在 `<template>` 中，**修改数据不会改变 CSP 哈希**；只有修改 `<style>`/`<script>` 代码才需要重算。

### 4.1 只改数据（最常见）

首次构建机安装依赖：

```bash
python -m pip install -r requirements.txt
```

之后：

```bash
# 页面里添加/删除/导入后，点“导出 Excel（.xlsx）”
# 把下载的 ${班级}.xlsx 覆盖到 data/${班级}.xlsx
# 如果改了第 1 周，更新 data/设置.json
python build-html.py
python verify-csp.py
```

`build-html.py` 会：

1. 读取 `data/*.xlsx` 和 `data/设置.json`；
2. 校验班级名、日期、表头、字段长度、控制字符、重复班级；
3. 转义 `<`、`>`、`&`，写入 `<template id="defaultData">`；
4. 同时写入 `实验提醒.html` 和 `index.html`；
5. 运行 `verify-csp.py`，确认 CSP/TT/模板都正常。

数据构建**不需要** `verify-csp.py --apply`，脚本/样式哈希保持不变。

新增班级：把 `${班级}.xlsx` 放进 `data/`，直接 build；页面下拉框会出现该班。页面导入时新建的班只在本机；要发布，需要导出该班 xlsx 放进 `data/` 再 build。

### 4.2 改代码

如果修改了 `<style>` 或 `<script>`：

```bash
python verify-csp.py --apply
python build-html.py
python verify-csp.py
```

顺序说明：

- `--apply` 按最终 UTF-8/LF 字节重算 `<style>`/`<script>` 哈希，更新 CSP meta，并把源文件同步为 `index.html`；
- 然后 `build-html.py` 用 `data/*.xlsx` 和 `data/设置.json` 重新写入数据，确保 `index.html` 的数据不是旧的；
- 最后再 verify。

要求：

- 保持 HTML/Python/Markdown/JSON 为 LF、无 BOM；xlsx 是 binary，不要用文本编辑器改。
- `.gitattributes` 已设置 `*.xlsx binary` 和 `data/*.xlsx` 提交例外。
- `.nojekyll` 必须保留，避免 Jekyll 处理改变字节。
- 不要直接编辑 `index.html`；它是构建产物，下次 build 会覆盖。
- 不要直接改源文件里的 `<template>` 数据；`data/*.xlsx` 和 `data/设置.json` 才是发布源，build 会覆盖模板。
- 提交前运行 `python verify-csp.py`，确认 `OK`。
- 部署后打开 DevTools Console，确认没有 `Refused to execute inline script` / `Refused to apply inline style`。

当前哈希（以 `verify-csp.py` 输出为准）：

- script: `+3xPlAAKLNQU1PXAeSwaU9XukjmuMK+RF1jW/WMisis=`
- style:  `2DqPerEEmgOOHr+KTcEEbWEwG5V39SyXYeEULqr9mik=`

## 5. 部署到 GitHub Pages

1. 确保提交：`index.html`、`实验提醒.html`、`data/*.xlsx`、`data/设置.json`、`build-html.py`、`requirements.txt`、`verify-csp.py`、`.nojekyll`、`.gitattributes`、`.editorconfig`、`SECURITY.md`。
2. 不要提交：导出的、不在 `data/` 下的 `*.xlsx`、备份、测试 fixture、`.DS_Store`。`.gitignore` 已排除；`data/*.xlsx` 有提交例外，因为它们是发布源。
3. **公开数据警告**：`data/*.xlsx`、`data/设置.json` 和 `index.html` 都会公开。不要把个人敏感实验数据提交到公开仓库/公开 Pages；需要私密数据时不要用公开 GitHub Pages，改用本地文件或私有部署。
4. GitHub 仓库设置开启 2FA、分支保护；静态站点优先直接分支部署，不使用 Actions；如必须用 Actions，固定 action SHA、最小权限、不要存长期凭据。
5. Settings → Pages → Deploy from a branch → 根目录；开启 **Enforce HTTPS**。
6. 部署后检查：
   - 班级下拉出现 Z1/Z2/Z5（以及 `data/` 里新增的班）；
   - Z1 显示 22 条，Z2 显示 24 条，Z5 显示 10 条；
   - 编辑/删除模式：默认显示全部、筛选可主动勾选；删除可撤销；编辑保存后留在模式内并可撤销；无删除/无编辑退出有提示；退出恢复筛选；
   - 切换班级、添加、导入、导出、恢复当前班、week1 正常；
   - Console 无 CSP/Trusted Types 报错；
   - DevTools Network 中无外部请求；
   - `view-source` 中的 CSP 哈希与当前文件一致。
7. 日常更新流程：

```text
页面添加/删除/导入
        ↓
点“导出 Excel”，得到 ${班级}.xlsx
        ↓
覆盖 data/${班级}.xlsx
（改了 week1 就同步修改 data/设置.json）
        ↓
python build-html.py
python verify-csp.py
        ↓
git add data/*.xlsx data/设置.json 实验提醒.html index.html
git commit / git push
```

8. 新增班级：把 `${班级}.xlsx` 放进 `data/` 后 build；页面导入时新建的班只在本机，导出该班 xlsx 放进 `data/` 再 build 才会发布。
9. 数据迁移：`file://`、`https://<user>.github.io`、自定义域名的 localStorage 互不相通。旧单班数据在选中 Z2 时会自动迁移到 Z2；跨源迁移请用“导出 Excel”/“导入 Excel”。week1 全局设置不在 xlsx 里，跨源后需要重新设置或修改 `data/设置.json` 后 build。

## 6. 残余风险（GitHub Pages 限制）

以下控制 GitHub Pages **无法通过响应头实现**，本文件也没有伪造它们：

- **点击劫持**：没有 `frame-ancestors`（meta 不支持）和 `X-Frame-Options`；也没有 JS frame-buster（为避免预览/嵌入环境误跳 404 已移除），因此没有有效的客户端点击劫持缓解。
- **HSTS**：没有 `Strict-Transport-Security`；只能在仓库设置中启用 Enforce HTTPS，无法预加载（preload 需要自有域名）。
- **Permissions-Policy**：无法设置，不能显式禁用摄像头/麦克风/地理位置等；本应用不使用这些 API。
- **COOP / COEP / CORP**：无法设置；本应用没有跨源资源，风险较低。
- **X-Content-Type-Options**：无法设置；GitHub Pages 以 `text/html` 提供 `.html`，且无用户上传。
- **CSP reporting**：meta 不支持 `report-uri`；本应用不做外部上报（隐私/零成本）。
- **同源 localStorage**：GitHub Pages 项目站点共享 `https://<user>.github.io` 源，同账号其它项目可能读取/覆盖这些键。已使用项目前缀，但无法在路径级隔离；不要在公共电脑保存敏感信息。
- **客户端边界**：这是纯客户端应用，拥有浏览器/DevTools 的用户可以修改自己的数据；安全控制的目标是防止恶意 HTML/脚本执行、存储污染、xlsx 解析 DoS 等，而不是保护用户自己。
- **Trusted Types 浏览器支持**：Chromium/Edge 强制执行；Firefox/Safari 可能忽略 Trusted Types 指令。代码本身已移除 HTML sink，CSP 仍然有效。
- **免费 GitHub Pages** 没有企业级 WAF/DDoS 防护；仓库和默认实验数据是公开的。
- **数据表公开**：`data/*.xlsx`、`data/设置.json`、`index.html` 都是公开的；班级名和实验内容不要放敏感信息。
- **构建依赖**：`build-html.py` 需要本机 Python 3 + openpyxl；网页运行不需要 Python。xlsx 是二进制文件，不能用文本编辑器改。
- **班级名/文件名**：班级名不限制，但实际受操作系统文件名和 Excel 文件限制；页面用固定 `实验安排` sheet，班级从文件名读取，不依赖 sheet 名。
- **xlsx 限制**：加密、ZIP64、超过大小/行/列/文本上限的文件会被拒绝；这是安全取舍，不是网络问题。

如果将来必须获得可靠的安全响应头，需要把同一份 `index.html` 部署到支持自定义响应头的免费静态托管（如 Cloudflare Pages / Netlify 免费层的 `_headers`），或使用自有域名 + 可控代理；这超出“仅 GitHub Pages”的当前范围。
