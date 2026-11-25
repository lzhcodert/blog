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

where git >nul 2>nul
if errorlevel 1 (
  echo Git not found. Please install Git first.
  pause
  exit /b 1
)

node "%ROOT%build-blog.js"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

robocopy "%ROOT%new_ai_blog" "%ROOT%content" /E /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo Failed to sync markdown files.
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo This folder is not a git repository.
  echo One-time setup:
  echo   git init -b main
  echo   git remote add origin https://github.com/lzhcodert/blog.git
  pause
  exit /b 1
)

git add .
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Update blog %date% %time%"
  if errorlevel 1 (
    echo Commit failed. Check git user.name and user.email.
    pause
    exit /b 1
  )
) else (
  echo No changes to commit.
)

git symbolic-ref HEAD refs/heads/main
if errorlevel 1 (
  echo Failed to set branch to main.
  pause
  exit /b 1
)

git push origin main
if errorlevel 1 (
  echo Push failed. Check your remote and credentials.
  pause
  exit /b 1
)

echo Pushed to GitHub. Actions will deploy the site shortly.
pause
endlocal
