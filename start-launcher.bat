@echo off
setlocal
chcp 65001 >nul
title DeepSeek Harness 启动器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未找到 Node.js，请先安装 Node.js（v18+）并加入 PATH。
  echo.
  pause
  exit /b 1
)

echo.
echo   ================================================
echo     DeepSeek Harness 启动器
echo     控制台地址: http://127.0.0.1:3090
echo     关闭本窗口即退出启动器后端
echo   ================================================
echo.
node launcher.js %*
pause
