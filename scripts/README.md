# 本地自动化脚本（替代原先两个 .bat）

一个人维护这个仓库时，最容易出的事不是写错代码，而是**忘了构建就推送**：
页面里的数据/哈希没更新，线上看到的是旧版或直接白屏。所以所有本地操作都收进一个入口。

## 用法

```powershell
# 1) 只构建（原「部署文件.bat」）：体检 → 构建 → 校验
powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task build

# 2) 全量检查（CI 会跑的东西，本地先过一遍）
powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task check

# 3) 构建 + 提交 + 推送（原「上传文件.bat」）
powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task release -Message "data: 更新实验安排"
```

不习惯命令行就直接双击仓库根目录的：

| 文件 | 等价于 |
|---|---|
| `部署文件.cmd` | `-Task build` |
| `上传文件.cmd` | `-Task release` |
| `全部检查.cmd` | `-Task check` |

## 三个任务分别做什么

| 任务 | 步骤 | 什么时候用 |
|---|---|---|
| `build` | 体检数据 → 构建 `index.html` + `*.ics` → 校验 CSP | 改了 `data/` 或 `index.html`，想先看看结果 |
| `check` | `build` + Python 单测 42 + 逻辑 52 + UI 冒烟 + 课表 50 + 视觉 8 视口 | 准备提交前，或者怀疑某处被改坏 |
| `release` | `check` + `git pull` + `git add` + `commit` + `push` | 确认没问题，发布到 GitHub Pages |

## 参数

| 参数 | 作用 |
|---|---|
| `-Task build\|check\|release` | 必填 |
| `-Message "…"` | release 的提交信息，默认 `data: 更新实验安排` |
| `-SkipUi` | check/release 跳过浏览器测试（只跑 Python + 逻辑），通常省 2–3 分钟 |
| `-SkipPull` | release 时不先 `git pull`（离线或确定远端没变时用） |
| `-Stamp` | build/check 时顺带把 `data/设置.json` 的 `updatedAt` 设成今天 |

## Python 从哪来

脚本按顺序找：`CRSECUE_PYTHON` 环境变量 → `python` → `py -3`。
找不到、或没装 `openpyxl`，会直接给出可复制的修复命令并退出（不会静默继续）。

## 为什么不用 .bat 了

- `.bat` 里写不了"失败即停 + 精确定位到哪一步"，只能靠 `if errorlevel` 层层跳转；
- 中文注释在 GBK/UTF-8 之间来回转码，容易乱码；
- 现在多了测试环节（Python 42 + 浏览器 100+ 断言），`.bat` 拼不动。

PowerShell 版本要求：Windows 10/11 自带的 5.1 即可，无需安装任何东西。
