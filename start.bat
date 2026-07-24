@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Download it from the official Node.js website, then run this file again.
  pause
  exit /b 1
)
node --no-warnings server\index.mjs
if errorlevel 1 pause
