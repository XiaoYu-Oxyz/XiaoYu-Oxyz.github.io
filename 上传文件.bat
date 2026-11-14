@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM 先构建再发布：旧版本只做 git add/commit/push，会把"哈希过期的产物"直接推上线。
REM 如果使用 conda 环境，请先 `conda activate <环境名>` 再运行本脚本。

where python >nul 2>nul || (echo [ERROR] PATH 里找不到 python & goto :fail)
python -c "import openpyxl" >nul 2>nul || (
  echo [ERROR] 缺少 openpyxl，请先执行： python -m pip install -r requirements.txt
  goto :fail
)

echo [1/4] 构建 ...
python build-html.py
if errorlevel 1 goto :fail

echo [2/4] 校验 ...
python verify-csp.py
if errorlevel 1 goto :fail

echo [3/4] 同步远端 ...
git pull origin main
if errorlevel 1 goto :fail

echo [4/4] 提交并推送 ...
git add -A
git diff --cached --quiet && (
  echo 没有需要提交的改动，已退出。
  pause
  exit /b 0
)
git commit -m "data: 更新实验安排"
if errorlevel 1 goto :fail
git push origin main
if errorlevel 1 goto :fail

echo.
echo 上传完成。等待 1-3 分钟后访问 Pages 地址，并用 Ctrl+F5 确认。
pause
exit /b 0

:fail
echo.
echo [FAILED] 已在失败步骤中止，没有继续上传。
pause
exit /b 1
