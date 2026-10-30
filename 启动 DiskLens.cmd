@echo off
chcp 65001 >nul
title DiskLens - 磁盘空间分析器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo   请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

set UV_THREADPOOL_SIZE=16
echo.
echo   ┌─────────────────────────────────────┐
echo   │   DiskLens · 磁盘空间分析器         │
echo   └─────────────────────────────────────┘
echo.
echo   正在启动本地服务，浏览器会自动打开…
echo   关闭本窗口即可停止服务。
echo.

node server.mjs --open

echo.
echo   服务已停止。
pause >nul
