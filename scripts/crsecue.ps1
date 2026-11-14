<#
.SYNOPSIS
    CrseCue 本地自动化入口：构建 / 全量检查 / 发布。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task build
    powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task check -SkipUi
    powershell -ExecutionPolicy Bypass -File scripts/crsecue.ps1 -Task release -Message "data: 更新 Z2 实验"

.NOTES
    替代原先根目录的「部署文件.bat」「上传文件.bat」。
    要求：Python 3 + openpyxl（构建）；Node 20 + Playwright（浏览器测试）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('build', 'check', 'release')]
    [string]$Task,

    [string]$Message = 'data: 更新实验安排',

    [switch]$SkipUi,
    [switch]$SkipPull,
    [switch]$Stamp
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# ---------- 输出小工具 ----------
function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK]  $text" -ForegroundColor Green }
function Write-Fail($text) {
    Write-Host "`n[FAILED] $text" -ForegroundColor Red
    exit 1
}

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    Write-Step $Label
    & $Action
    if ($LASTEXITCODE -ne 0) { Write-Fail "$Label 失败（exit $LASTEXITCODE），已在一步中止。" }
    Write-Ok $Label
}

# ---------- 找 Python ----------
function Resolve-Python {
    $candidates = @()
    if ($env:CRSECUE_PYTHON) { $candidates += @{ Exe = $env:CRSECUE_PYTHON; Args = @() } }
    $candidates += @{ Exe = 'python'; Args = @() }
    $candidates += @{ Exe = 'py'; Args = @('-3') }
    foreach ($c in $candidates) {
        try {
            $null = & $c.Exe @($c.Args + @('-c', 'import sys')) 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch { }
    }
    Write-Fail "找不到 Python 3。装好后重试，或用 `$env:CRSECUE_PYTHON='C:\path\to\python.exe' 指定。"
}

function Invoke-Python {
    param([string[]]$ScriptArgs)
    & $script:Python.Exe @($script:Python.Args + $ScriptArgs)
}

$script:Python = Resolve-Python

# openpyxl 是构建的唯一第三方依赖
Invoke-Python @('-c', 'import openpyxl') 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Fail @"
Python 里没有 openpyxl。先执行：

    $($script:Python.Exe) $($script:Python.Args -join ' ') -m pip install -r tools/requirements.txt
"@
}

# ---------- 核心步骤 ----------
function Step-Data    { Invoke-Step '体检数据（tools/validate_data.py）' { Invoke-Python @('tools/validate_data.py') } }
function Step-Build   {
    # 不要用 $args 当变量名：它是 PowerShell 的自动变量，赋值会被忽略（会退化成裸 python 进入 REPL）
    $buildArgs = @('tools/build.py')
    if ($Stamp) { $buildArgs += '--stamp' }
    Invoke-Step '构建 index.html 与 *.ics' { Invoke-Python $buildArgs }
}
function Step-Verify  { Invoke-Step '校验 CSP 哈希与模板' { Invoke-Python @('tools/verify.py') } }
function Step-PyTests { Invoke-Step 'Python 单元测试（42）' { Invoke-Python @('-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py') } }

function Test-NodeReady {
    if (-not (Test-Path (Join-Path $repo 'node_modules'))) {
        Write-Fail "没有 node_modules。先在仓库根目录执行：npm ci"
    }
}

function Step-Js([string]$Script, [string]$Label) {
    Test-NodeReady
    Invoke-Step $Label { & npm run --silent $Script }
}

# ---------- 任务组装 ----------
Write-Host "CrseCue · 仓库 $repo" -ForegroundColor DarkGray
Write-Host ("任务：{0}{1}{2}" -f $Task, $(if ($SkipUi) { '（跳过浏览器测试）' } else { '' }), $(if ($Stamp) { '（同时更新 updatedAt）' } else { '' })) -ForegroundColor DarkGray

switch ($Task) {
    'build' {
        Step-Data
        Step-Build
        Step-Verify
        Write-Host "`n构建完成：index.html 已更新。要发布请跑 -Task release（或双击 scripts\上传文件.cmd）。" -ForegroundColor Green
    }

    'check' {
        Step-Data
        Step-Build
        Step-Verify
        Step-PyTests
        Step-Js 'test:logic'        '逻辑回归（Chromium，52 项）'
        if (-not $SkipUi) {
            Step-Js 'test:logic:webkit' '逻辑回归（WebKit）'
            Step-Js 'test:ui'           'UI 冒烟（Chromium）'
            Step-Js 'test:ui:webkit'    'UI 冒烟（WebKit）'
            Step-Js 'test:week'         '课表视图（Chromium，50 项）'
            Step-Js 'test:week:webkit'  '课表视图（WebKit）'
            Step-Js 'test:visual'       '视觉冒烟（8 视口，Chromium）'
            Step-Js 'test:visual:webkit' '视觉冒烟（WebKit）'
        }
        Write-Host "`n全部检查通过。" -ForegroundColor Green
    }

    'release' {
        Step-Data
        Step-Build
        Step-Verify
        Step-PyTests
        Step-Js 'test:logic' '逻辑回归（Chromium，52 项）'
        if (-not $SkipUi) {
            Step-Js 'test:ui'      'UI 冒烟（Chromium）'
            Step-Js 'test:ui:webkit' 'UI 冒烟（WebKit）'
            Step-Js 'test:week'    '课表视图（Chromium）'
            Step-Js 'test:week:webkit' '课表视图（WebKit）'
            Step-Js 'test:visual'  '视觉冒烟（Chromium）'
            Step-Js 'test:visual:webkit' '视觉冒烟（WebKit）'
        }

        if (-not $SkipPull) {
            Invoke-Step '同步远端（git pull --rebase）' { & git pull --rebase origin main }
        }

        Invoke-Step '暂存改动' { & git add -A }
        & git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`n没有需要提交的改动，退出。" -ForegroundColor Yellow
            exit 0
        }

        Invoke-Step '提交' { & git commit -m $Message }

        # 提交后产物必须干净：CI 会检查「构建产物与提交一致」
        $dirty = & git status --porcelain
        if ($dirty) {
            Write-Host $dirty
            Write-Fail "提交后仍有未提交改动（通常是构建产物），请检查后重跑。"
        }

        Invoke-Step '推送' { & git push origin main }

        Write-Host "`n已推送。等待 1-3 分钟后访问 https://xiaoyu-oxyz.github.io/ ，用 Ctrl+F5 强刷确认。" -ForegroundColor Green
        Write-Host "CI 状态：https://github.com/XiaoYu-Oxyz/XiaoYu-Oxyz.github.io/actions" -ForegroundColor DarkGray
    }
}
