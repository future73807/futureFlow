@echo off
setlocal

echo ============================================================
echo   futureFlow full stack startup
echo   PostgreSQL + Dify + Sandbox + SSRF Proxy + app
echo ============================================================

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm is required. Install it with: npm i -g pnpm
  exit /b 1
)
where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop is required and must be running.
  exit /b 1
)
call pnpm.cmd install --prod=false
if errorlevel 1 exit /b 1
call pnpm.cmd start

endlocal
