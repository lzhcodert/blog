@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%ROOT%build-blog.js"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

start "" "%ROOT%dist\index.html"
echo Preview opened in your browser.
endlocal
