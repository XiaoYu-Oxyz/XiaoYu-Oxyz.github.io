# 兼容性说明

## 底线

**Chrome / Edge 60+ · Safari 11.1+ · iOS 12+**（2026 年视角下是 2017 年左右的引擎）。
IE 不支持，见文末。

选这条线的理由：它是"不需要改任何 JS 语法"的最低点 —— Chrome 60 起支持对象展开、
`async/await`、CSS 变量、`grid`、`padStart`；Safari 11.1 / iOS 12 同理。
再往下每降一档都要动业务代码（例如 Chrome 52 需要重写 27 处 `async/await`）。

## 各设备的实际表现

| 设备 | 系统 / 引擎 | 结果 |
|---|---|---|
| iPad mini 2 | iOS 12.5 / Safari 12 | 可用。表头吸顶靠 `-webkit-sticky`；冲突连线靠四边定位；按钮间距偏紧（flex gap 不支持） |
| vivo Y81 | Android 8.1 / Chrome 66–70 | 可用，同上 |
| vivo Y66 | Android 6 / Chrome 52–55（未更新 WebView） | 显示"浏览器版本较旧"提示条；更新 WebView 后可用 |
| iPhone / 新 Android | iOS 15+ / Chrome 100+ | 完全支持 |
| IE 11 | Trident | **不支持**：无 CSS 变量、无 grid、无 Promise/ES6；会看到静态提示条 |

## 已做的兜底

| 项 | 位置 | 说明 |
|---|---|---|
| `inset` 四边写法 | `src/app.css` `.conflict-link-layer` | 老引擎不认 `inset`，连线层会塌成 0 |
| `-webkit-sticky` 前缀 | `src/app.css` `thead th` | iOS 12 需要前缀才吸顶 |
| `:focus` 焦点环 | `src/app.css` 焦点区 | 老浏览器不认 `:focus-visible` 会整条丢弃；先给 `:focus` 环，再用 `:focus:not(:focus-visible)` 在支持的浏览器上取消鼠标焦点环 |
| flex `gap` 兜底 | `@supports not (gap: 1px)` | 只补操作面板按钮组、页头筛选、图例、班级工具四处，其余接受间距塌陷 |
| `dvh` / `min()` 回退 | `.modal` / `.import-modal` | 先给 `vh` / `px`，新语法写在同一行之后 |
| `replaceChildren` polyfill | `src/app.js` 顶部 | Chrome 86 才有的 API，已自带 polyfill（lint 会自动识别） |
| 旧浏览器提示条 | `src/index.template.html` | 默认显示，`@supports (--css: variables)` 命中后隐藏；IE 不认 `@supports`，所以会一直显示 |
| `<noscript>` 提示 | 同上 | 关闭脚本时给出说明 |

## 怎么防止回退

`python tools/compat_lint.py` 会扫 `src/`，命中超出底线的特性就失败（CI 构建 job 会跑）。
确有必要的例外：在该行加 `compat-allow` 注释，并在这里补一行说明。

当前允许的"临界特性"：`:focus-visible`（有 `:focus` 兜底）、`flex gap`（有 `@supports` 兜底）、
`replaceChildren`（有 polyfill）、`env(safe-area-inset-*)`（iOS 11+）。

## 无法自动验证的部分

Playwright 只带现代内核，装不了 Chrome 52 / Safari 12。因此这里能保证的是
"语法与 CSS 特性不越线 + 用 `@supports`/条件写法优雅降级"，**不能保证老设备上的像素级表现**。
真机回归需要手上有对应设备时人工点一遍（重点：表头吸顶、冲突连线、按钮间距、焦点框）。
