# 安全说明（GitHub Pages 严格加固版）

本目录是“实验课提醒”静态应用的安全加固版本：运行时仍是单文件 `index.html`；默认数据来自 `data/*.xlsx` 与 `data/设置.json`，构建时写入页面内的惰性 `<template>`。目标是在**零成本、仅 GitHub Pages** 的前提下，做到静态客户端应用可达到的最严格安全配置。

## 1. 文件

| 文件 | 说明 |
| --- | --- |
| `data/*.xlsx` | 每班一个 xlsx（当前 `Z1.xlsx` 25 条、`Z2.xlsx` 27 条、`Z5.xlsx` 13 条）；文件名去掉 `.xlsx` 就是班级名 |
| `data/设置.json` | 全局设置：`week1`（第 1 周星期一）、`updatedAt`（页面顶部"数据更新至"）、`periodTimes`（节次时间默认值）、`reminderMinutes`（日历提醒提前量，默认 30） |
| `tools/build.py` | 用 Python + openpyxl 读 `data/`，写入 `<template id="defaultData">`，生成源文件和 `index.html`，再运行 verify |
| `tools/verify.py` | 校验 CSP 哈希、模板 JSON、默认数据解析和安全限制；`--apply` 重算代码哈希并同步 `index.html` |
| `tools/validate_data.py` | 数据体检：一次列出所有问题（只读，不改文件） |
| `tools/common.py` | 三个脚本共用：仓库路径、原子写入（临时文件 + 替换）、按路径动态导入、git 提交日期 |
| `calendars/<班级>.ics` | 构建期生成的日历订阅文件（公开 URL：`/calendars/Z1.ics`）；CRLF 行尾 |
| `scripts/crsecue.ps1` | 本地自动化入口（`-Task build/check/release`），替代原先两个 `.bat`；不含绝对路径 |
| `requirements.txt` | 构建依赖：`openpyxl==3.1.5`；网页运行不需要 |

| `index.html` | GitHub Pages 部署入口，与源文件字节一致 |
| `.gitattributes` | HTML/Python/Markdown/JSON 使用 LF；xlsx binary；`.ics` 保持 CRLF；`.ps1`/`.cmd` 检出为 CRLF |
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
- 状态提示同步到隐藏的 `role="status" aria-live="polite"` 区域；模态框有 Tab 焦点循环，Esc 关闭后焦点回到触发按钮；按钮使用 `:focus-visible` 轮廓。
- 页面保留 `<main id="main">`，已移除 skip link；打印样式只保留当前筛选表格和班级/日期/条数页眉。
- 班级工具四个图标使用 36×36px 按钮热区，视觉表面 28px；移动端仍保持同一行。
- 表格使用原生 `<table tabindex="0">`、动态 `caption`、`scope="col"` 和固定列头 `id`；每个数据单元格用 `headers` 关联列头；每条实验行 `tabindex="0"`，**Tab 从表格进入第一行后逐行前进，Shift+Tab 反向，一次报一行**；行尾保留读屏默认表格行播报；上下方向键同样逐条移动；Esc 回到表格；不拦截读屏的 Ctrl/Alt 表格导航键；桌面和手机的 `aria-describedby` 都含 `tableHeaderSummary`，聚焦表格先读全部数据表头；普通阅读时操作列表头/单元格对读屏隐藏，进入编辑/删除模式后恢复按钮；行 label 始终保留并含全部列名与状态（星期读“星期 星期一”），`cell-mobile` 子块对读屏隐藏，只读整段摘要，不读空白/不拆段。
- 编辑/删除行按钮的 `aria-label` 与编辑弹窗摘要含完整日期、周次、星期、节次、实验名称、实验地点、备注和状态；星期读“星期 星期一”。
- 班级下拉框的 `<option>` 用 `createElement` + `textContent` 生成；班级名来自文件名，也不拼 HTML。
- 仅保留一个 Trusted Types 策略 `xlsx-xml`，用于 `DOMParser` 解析 xlsx XML；策略内再次检查大小和 `<!DOCTYPE`/`<!ENTITY`。
- 已移除 JS frame-buster：它在 iframe/预览环境可能把顶层导航到 404，且本身可被绕过；点击劫持作为残余风险处理，不伪装成可靠防护。

### 2.3 xlsx 导入/导出

- 每个班一个 xlsx：文件名去掉 `.xlsx` 就是班级名；只读第一个工作表，sheet 名随意。
- 表头必须含 `节次`、`实验名称`、`实验地点`；时间列可用 `日期`，或同时用 `周次`+`星期`，至少保留其中一组。两组时间列可只出现一组，也可同时存在。
- 可选 `备注` 列，导出时固定在最后一列；最多 500 字，允许换行。旧 6 列文件按空备注处理。
- 每行独立判断时间：`周次`+`星期`有效时优先；否则回退到有效 `日期`；`周次`/`星期`不完整或无效但日期有效时用日期；两组都没有有效时间时整次导入/build 失败。
- 如果两组都填且周次+星期有效，以周次+星期为准；周次+星期无效/不完整时回退日期；日期无效但周次+星期有效时用周次+星期。
- 页面导入遇到没有有效时间的行会整次失败，不写入任何数据；`tools/build.py` 同样失败，且不覆盖 `index.html`。
- 导出默认全部实验，可选当前筛选；当前筛选文件名加 `-筛选`，xlsx `班级信息` 记录导出范围；空班也导出只有表头的空表。
- 筛选备份导入时识别 `-筛选` 文件名和 `scope/导出范围`，弹窗警告“不是完整班级”；替换已有班级前再次确认，避免误删未包含的记录。
- 导入一个班文件，默认合并；文件名与当前班不一致时，默认按文件名切换/新建，也可以选择忽略文件名导入当前班。
- 导入完成后状态栏提供“撤销导入”，恢复导入前该班的数据和 week1；导入时新建的本机班级会随撤销删除。
- 班级下拉右侧的新建/重命名/删除只操作本机状态；名称限制文件名非法字符、长度和重名；内置班级重命名/删除先警告，然后在本机隐藏原班（重命名复制数据，删除只隐藏），部署数据不变，并支持单步撤销。
- 文件大小上限 10MB；校验 ZIP magic（`PK\x03\x04`），不只信扩展名。
- ZIP 条目上限 512；单条目解压上限 20MB；总解压上限 50MB；压缩比上限 1000；`DecompressionStream` 流式读取，超限立即取消（防 ZIP bomb）。
- 只读取白名单条目：`xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/sharedStrings.xml`、`xl/worksheets/*.xml`；其它条目（图片、主题等）直接跳过，不解压。
- 拒绝 `../`/绝对路径规范化后的越界条目、重复条目；加密、ZIP64、未知压缩方式安全报错。
- 校验 CRC32；限制 XML 大小 12MB；拒绝 `<!DOCTYPE`/`<!ENTITY`（防实体膨胀/XXE）；检查 XML parsererror。
- 限制行数 5000、列数 64、单元格文本 2000 字符、共享字符串数量/总量；防御巨大 `row r=""` 造成的稀疏数组/内存爆炸。
- 导入字段限制：节次 100、名称 200、地点 200、备注 500 字符；周次 1–1000；字段超限由页面导入跳过并提示，build 直接失败。
- 导出全部使用 `inlineStr` 文本，`=` `+` `-` `@` 开头的值不会变成公式；导入只读缓存值，不执行公式。
- 导入文件名、班级名只做文本展示并限长。
- `tools/build.py` 用 openpyxl 读取本地 `data/*.xlsx`；这是构建机上的可信数据源，构建前会严格校验日期、表头、字段长度、控制字符和重复班级；不是浏览器上传入口。

### 2.4 localStorage

- 项目前缀：`ghpages:zhizao2402:`。
- 每个班的数据键：`ghpages:zhizao2402:classdata:v1:<encodeURIComponent(班级名)>`；另有 `week1:v1`、`selected-class:v1`、`extra-classes:v1`、`hidden-built-classes:v1`。
- 旧单班键 `ghpages:zhizao2402:experiments:v1` 和 `zhizao2402_experiments_v1` 在选中 Z2 时自动迁移到 Z2 的班级键；旧 `week1` 键继续作为全局设置。
- 空数组是有效状态；班级列表允许为空，此时表格显示无班级空状态，新建或恢复隐藏班后恢复。
- `hidden-built-classes:v1` 只保存本机隐藏的内置班级 ID；重命名/删除不修改 `data/`。
- 允许本机新建/重命名与隐藏班同名，但会先警告；恢复隐藏班时若存在同名本机班，恢复弹窗报错并要求先删除同名班，避免 ID 冲突。
- 损坏的班级数据回退模板/默认；保存失败会提示，刷新后可能恢复。
- **启动时做一次可用性探测**：写入、读取并删除 `ghpages:zhizao2402:__selftest`。失败（无痕模式、禁用站点数据、配额满）时不阻断页面，只在顶部挂常驻横幅"这台设备无法保存改动…请导出备份"，并给 `body` 加 `no-storage` 类。探测键在成功后立即删除，不留痕迹。
- `storage` 事件同步当前班数据/week1、额外班级和隐藏班级；弹窗或编辑/删除模式中不覆盖当前页面，只提示并给“重新加载”按钮；关闭导入弹窗后如仍待刷新会自动重新载入。
- 另一个标签页切换班级时只提示“已切换到 …”，不自动跟随。
- 复制失败时只把纯文本放进只读 `<textarea>`，不拼 HTML；手动复制窗口支持 Esc 关闭和焦点归位。
- “恢复”图标打开上下布局弹窗：上方恢复当前内置班的默认实验，下方逐个恢复本机隐藏的内置班；本机新建班或空班的上方按钮禁用。
- 顶部“编辑实验”和“删除实验”是两个互斥模式：
  - 删除模式：每行左侧圆圈，可多选；点“完成”立即删除，状态栏提供“撤销”；
  - 编辑模式：每行左侧铅笔，点击打开预填弹窗；保存后留在编辑模式，状态栏提供“撤销编辑”。
- 进入模式时默认取消本周筛选勾选并显示全部；复选框仍可主动勾选；退出后恢复进入前的筛选状态。
- 模式下禁用班级选择、第 1 周、添加/导入/导出/恢复；两个模式按钮互相禁用；筛选复选框保持可用。
- 顶部操作按钮默认收进“操作 ▾”内联面板；班级工具和“复制本周”在面板外；“实验”组为添加/编辑/删除，“数据”组为导入/导出；只有点击“操作”才展开/收起，滚动、点外、Esc、执行动作和完成模式均不自动收起。
- 操作菜单内搜索只过滤当前班，匹配名称/地点/备注/节次/日期/周次/星期；搜索词不写 localStorage、不发请求，按 `textContent` 渲染；菜单收起后搜索仍生效。
- 顶部“数据更新至”来自构建时自动读取的最近一次 `data/` git 提交日期，不拼接 HTML。
- 班级链接 `?class=` 只接受当前班级列表中的 ID；**不在列表中的值会跳到 `404.html?from=class&name=…`**（文本渲染班级名），不再静默回退到第一个班——否则用户会对着别的班的课表而不自知。合法值用 `history.replaceState` 同步地址栏。
- JSON 备份只使用 `JSON.parse`，不拼接 HTML/脚本；限制文件大小、实验条数、日期、字段长度和备注长度；`class` 与文件名不一致时阻止导入。
- “删除实验”不跳转 404。`404.html` 现在承担三种情况，全部只用 `textContent` 渲染参数：
  1. 访问不存在的路径（GitHub Pages 默认行为）；
  2. `?from=error`：主页面有未捕获异常时跳过来，显示「页面出错了」并提供"复制错误信息"（内容来自 `sessionStorage` 的 `crsecue:lasterror`，最多 1500 字，不含用户输入的实验数据）；
  3. `?from=class&name=…`：链接里的班级不存在时跳过来，`name` 先剥控制字符再截断到 40 字，只用于文本展示。
- 未捕获异常的处理只做两件事：把现场字符串写进 `sessionStorage`、`location.replace` 到 404 页。不发送任何网络请求，不带入 `localStorage` 里的实验内容。
- 只在本机 localStorage 保存草稿；部署默认数据来自 `data/` 构建。
- 同源说明见“残余风险”。

### 2.5 外部 xlsx、设置与构建

- 默认数据不再写死在 `<script>` 中，而是构建时写入页面内惰性的 `<template id="defaultData">` JSON。`<template>` 内容不会执行、不会渲染，也不参与 `<script>`/`<style>` 的 CSP 哈希。
- `data/*.xlsx` 是实验数据发布源；班级名 = 文件名去掉 `.xlsx`；数据工作表为 `实验安排`，旧文件没有该名称时读第一个工作表；可选 `班级信息` sheet 记录 `班级`、`week1` 等元数据。表头必须含 `节次/实验名称/实验地点`，时间列用 `日期` 或 `周次+星期`，至少一组。
- `data/设置.json` 是全局 week1 fallback；简单 JSON，不进 xlsx。数据更新时间由构建脚本读取最近一次修改 `data/` 的 git 提交日期自动生成，不需要手写。
- 每个班可以使用自己的 `week1`（页面本地设置或 `班级信息`）；没有时回退到 `data/设置.json` 全局值。`week1` 必须是星期一；页面、导入和 build 都校验。`班级信息` 的 `班级` 与文件名不一致时构建直接失败。
- `tools/build.py` 校验日期、表头、字段长度、控制字符、重复班级，把 `<`、`>`、`&` 转义成 `\u003c`/`\u003e`/`\u0026`，避免 `</template>`、`<img>` 或实体注入。
- 构建只改模板数据，不改 `<script>`/`<style>`，所以**数据变化不需要重算 CSP 哈希**。
- 构建写回 `index.html`，然后运行 `tools/verify.py`。
- 运行时仍然是单文件、无 fetch、`connect-src 'none'`，可完全离线；`data/` 只在构建时读取。
- 第 1 周按班级独立：页面修改只保存当前班；没有独立值时使用全局 `data/设置.json`。部署默认值可写在该班 xlsx 的 `班级信息`，或使用全局值；“恢复默认数据”不清 week1。
- 班级名不限制字符（以操作系统允许的文件名为准）；页面显示和 xlsx 走文本/固定 sheet，不拼 HTML。新班级可以往 `data/` 放 xlsx 后 build；页面导入时新建的班只在本机保留，导出该班 xlsx 并 build 后才成为部署默认。
- `data/*.xlsx`、`data/设置.json` 和 `index.html` 都会进入公开仓库/Pages，数据就是公开的；不要放敏感数据。

## 3. 验证

- 本轮多班级改造后，90 项 UI/数据回归通过，覆盖：
  - 班级下拉：Z1/Z2、首次选 Z1、切换、记住上次选择、刷新后数据/选择保持；
  - Z1 空表、Z2 23 条（90 项回归时的数据；当前 Z2 为 24 条）、按班添加与按班持久化；
  - 旧批量删除模式：禁用班级下拉、按班标记/完成/按班撤销；当前已恢复为正式删除模式，并新增编辑模式；
  - 恢复当前班、恢复清当前班存储、恢复不影响其它班；
  - 导入目标：默认按文件名、当前班（忽略文件名）、同班合并、已存在他班切换、新建本机班级；
  - 空班导出仅表头、Z2 导出 24 行（90 项回归时；当前 Z2 27 条对应 28 行，含备注列）、文件名形如 `Z2-实验安排-2026-11-14.xlsx`（早期版本为 `${班级}.xlsx`，导入时两种都能反推班级）；
  - week1 旧全局键迁移到各班、旧单班数据迁移到 Z2、旧键清理；
  - 无 JSON 入口、CSP/Trusted Types、无外部资源、无 style/内联事件。
- 以上 90 项回归在 Z1 空、Z2 23 条的数据上跑通；当前 `data/` 为 Z1 25 条、Z2 27 条、Z5 13 条。编辑/删除模式已完成回归：删除立即生效并可撤销；编辑保存后留在模式内并可撤销；模式退出恢复筛选。build 当前 3 个班、65 条。另有 build reader 单元测试与 Playwright UI 冒烟测试（week1 周一校验/切班、搜索、导出、JSON 导入、撤销导入、320px）。
- 备注回归：添加/编辑多行、最多 500 字；桌面独立小字行、手机卡片第三行；只按文本渲染；xlsx 7 列备注最后；旧 6 列导入/build 为空备注；合并默认保留、选择更新时覆盖；build 无备注列/空备注/超长/换行均验证。
- UI 筛选/手机布局回归：
  - 顶部“已结束仅显示本周”默认勾选；
  - Z2 当前显示 17 / 共 27，取消勾选显示 27 / 27，刷新后恢复勾选；
  - Z1 当前显示 17 / 共 25，取消勾选显示 25 / 25；
  - Z5 全部在未来，显示 13 / 13；
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
  - 修改 `data/设置.json` 的全局 week1 后构建，没有独立 week1 的班级默认值随之更新；班级 `班级信息` 的 week1 覆盖全局值；
  - 数据构建前后 script/style 哈希不变，`tools/verify.py` 通过。
- xlsx 导出仍通过 openpyxl/LibreOffice 验证；本轮 xlsx 解析/写入代码沿用加固版。
- 之前加固版的 136 项 xlsx 安全/存储测试作为基线；本轮改造保留了 xlsx 解析限制和字段校验。
- `python tools/verify.py` 会检查默认数据模板是否为合法 JSON、每个班级条目是否合法、默认数据解析代码是否存在，以及源文件与 `index.html` 的 CSP 哈希和字节一致性。

### 3.1 当前自动化基线（PRD 1.0）

§3 上半部分是加固轮的完整人工回归记录，保留作为历史证据。**当前以自动化测试为准**：

| 层 | 命令 | 数量 |
|---|---|---|
| Python 单元 | `python -m unittest discover -s tests -p "test_*.py"` | 42（构建 6 + 校验器 22 + 体检 14） |
| 纯逻辑 | `npm run test:logic` / `test:logic:webkit` | 52 |
| UI 冒烟 | `npm run test:ui` / `test:ui:webkit` | 12 段（含只读、横屏、坏链接、跨天） |
| 课表视图 | `npm run test:week` / `test:week:webkit` | 50 项 |
| 视觉冒烟 | `npm run test:visual` / `test:visual:webkit` | 8 视口 + 深色对比度断言 |

CI（`.github/workflows/verify.yml`）在每次 push 上复跑，并强制"构建产物与提交一致"。

## 4. 哈希维护（重要）

数据放在 `<template>` 中，**修改数据不会改变 CSP 哈希**；只有修改 `<style>`/`<script>` 代码才需要重算。

### 4.1 只改数据（最常见）

首次构建机安装依赖：

```bash
python -m pip install -r requirements.txt
```

之后：

```bash
# 页面里添加/删除/导入后，点“导出”，选择 Excel（.xlsx）
# 下载的文件名形如 Z2-实验安排-2026-11-14.xlsx，改回 Z2.xlsx 再覆盖 data/Z2.xlsx
# 如果改了第 1 周，更新 data/设置.json
python tools/build.py
python tools/verify.py
```

`tools/build.py` 会：

1. 读取 `data/*.xlsx` 和 `data/设置.json`；
2. 校验班级名、日期、表头、字段长度、控制字符、重复班级；
3. 转义 `<`、`>`、`&`，写入 `<template id="defaultData">`；
4. 写回 `index.html`；
5. 运行 `tools/verify.py`，确认 CSP/TT/模板都正常。

数据构建**不需要** `tools/verify.py --apply`，脚本/样式哈希保持不变。

新增班级：把 `${班级}.xlsx` 放进 `data/`，直接 build；页面下拉框会出现该班。页面导入时新建的班只在本机；要发布，需要导出该班 xlsx 放进 `data/` 再 build。

### 4.2 改代码

如果修改了 `<style>` 或 `<script>`：

```bash
python tools/verify.py --apply
python tools/build.py
python tools/verify.py
```

顺序说明：

- `--apply` 按最终 UTF-8/LF 字节重算 `<style>`/`<script>` 哈希，更新 CSP meta，并把源文件同步为 `index.html`；
- 然后 `tools/build.py` 用 `data/*.xlsx` 和 `data/设置.json` 重新写入数据，确保 `index.html` 的数据不是旧的；
- 最后再 verify。

要求：

- 保持 HTML/Python/Markdown/JSON 为 LF、无 BOM；xlsx 是 binary，不要用文本编辑器改。
- `.gitattributes` 已设置 `*.xlsx binary` 和 `data/*.xlsx` 提交例外。
- `.nojekyll` 必须保留，避免 Jekyll 处理改变字节。
- 不要直接编辑 `index.html`；它是构建产物，下次 build 会覆盖。
- 不要直接改源文件里的 `<template>` 数据；`data/*.xlsx` 和 `data/设置.json` 才是发布源，build 会覆盖模板。
- 提交前运行 `python tools/verify.py`，确认 `OK`。
- 部署后打开 DevTools Console，确认没有 `Refused to execute inline script` / `Refused to apply inline style`。

当前哈希（以 `tools/verify.py` 输出为准）：

- script: `aa9hV70vG0zYBCOF1SH8IS4BlabFJGwUppJVcxvUWfc=`
- style:  `RkiMyBeD4hV/7y9j2iB5e/4OO71G1LHPo41E/jiN+gA=`

## 5. 部署到 GitHub Pages

1. 确保提交：`index.html`、`404.html`、`data/*.xlsx`、`data/设置.json`、`tools/build.py`、`requirements.txt`、`tools/verify.py`、`.nojekyll`、`.gitattributes`、`.editorconfig`、`SECURITY.md`。
2. 不要提交：导出的、不在 `data/` 下的 `*.xlsx`、备份、测试 fixture、`.DS_Store`。`.gitignore` 已排除；`data/*.xlsx` 有提交例外，因为它们是发布源。
3. **公开数据警告**：`data/*.xlsx`、`data/设置.json` 和 `index.html` 都会公开。不要把个人敏感实验数据提交到公开仓库/公开 Pages；需要私密数据时不要用公开 GitHub Pages，改用本地文件或私有部署。
4. GitHub 仓库设置开启 2FA、分支保护；Pages 仍从 `main` 根目录部署。新增的 `.github/workflows/verify.yml` 只做构建/CSP/diff 校验，权限仅 `contents: read`，不部署、不持有凭据；两个 Action 已固定到 commit SHA，checkout 使用 `fetch-depth: 0` 以读取 data 提交日期。
5. Settings → Pages → Deploy from a branch → 根目录；开启 **Enforce HTTPS**。
6. 部署后检查：
   - 班级下拉出现 Z1/Z2/Z5（以及 `data/` 里新增的班）；
   - Z1 显示 25 条，Z2 显示 27 条，Z5 显示 13 条；
   - 编辑/删除模式：默认显示全部、筛选可主动勾选；删除可撤销；编辑保存后留在模式内并可撤销；无删除/无编辑退出静默；退出恢复筛选；
   - 顶部操作菜单：默认收起，点击“操作”内联展开且桌面/手机横向排列；只有点击“操作”才收起，滚动/点外/Esc/执行动作均不关闭；恢复默认在菜单外；
   - 下一次实验：最近一天所有行显示蓝色标记和“N天后”，桌面/手机一致；
   - 手机图例 5 项一行；手机第一行短日期/节次不换行；
   - 搜索：菜单内搜索名称/地点/备注，清空后恢复；顶部有搜索标签；
   - 数据更新时间与 `?class=Z2` 链接正常；
   - 切换班级、添加、导入、导出、恢复弹窗、week1 正常；
   - 复制本周在菜单外；
   - 桌面导入/导出标签含 `.xlsx/.json`，手机仅显示“导入/导出”；导出格式选择器正常；
   - 班级导出包含 `实验安排` + `班级信息`，导入能读取 week1；文件名与元数据班级不一致时阻止；
   - JSON 备份/导入：class/week1/备注/updatedAt 正常；文件名与 JSON class 不一致时阻止；
   - Console 无 CSP/Trusted Types 报错；
   - DevTools Network 中无外部请求；
   - `view-source` 中的 CSP 哈希与当前文件一致。
7. 日常更新流程：

```text
页面添加/删除/导入
        ↓
点“导出”，选择 Excel，得到 ${班级}.xlsx
        ↓
覆盖 data/${班级}.xlsx
（改了 week1 就同步修改 data/设置.json）
        ↓
python tools/build.py
python tools/verify.py
        ↓
git add data/*.xlsx data/设置.json index.html 404.html
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
- **构建依赖**：`tools/build.py` 需要本机 Python 3 + openpyxl；网页运行不需要 Python。xlsx 是二进制文件，不能用文本编辑器改。
- **班级名/文件名**：班级名不限制，但实际受操作系统文件名和 Excel 文件限制；页面用固定 `实验安排` sheet，班级从文件名读取，不依赖 sheet 名。
- **xlsx 限制**：加密、ZIP64、超过大小/行/列/文本上限的文件会被拒绝；这是安全取舍，不是网络问题。

如果将来必须获得可靠的安全响应头，需要把同一份 `index.html` 部署到支持自定义响应头的免费静态托管（如 Cloudflare Pages / Netlify 免费层的 `_headers`），或使用自有域名 + 可控代理；这超出“仅 GitHub Pages”的当前范围。
