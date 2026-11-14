@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM 构建 + 校验。任何一步失败都立刻中止，绝不把半成品推上线。
REM 如果使用 conda 环境，请先 `conda activate <环境名>` 再运行本脚本。

where python >nul 2>nul || (echo [ERROR] PATH 里找不到 python & goto :fail)
python -c "import openpyxl" >nul 2>nul || (
  echo [ERROR] 缺少 openpyxl，请先执行： python -m pip install -r requirements.txt
  goto :fail
)

echo [1/2] 构建 实验提醒.html / index.html ...
python build-html.py
if errorlevel 1 goto :fail

echo [2/2] 校验 CSP 哈希与模板 ...
python verify-csp.py
if errorlevel 1 goto :fail

echo.
echo 构建成功：index.html 已更新，可以运行「上传文件.bat」发布。
pause
exit /b 0

:fail
echo.
echo [FAILED] 构建或校验失败，请勿上传。修好上面的问题后重试。
pause
exit /b 1
