@echo off
setlocal

echo ============================================================
echo   futureFlow full stack startup
echo   PostgreSQL + Dify API/Worker/Web + Redis + Weaviate + app
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
if not exist ".env" (
  call pnpm.cmd run env:init
  if errorlevel 1 exit /b 1
  echo Created .env with a local Dify credential-encryption secret. Update production secrets before deployment.
)

call pnpm.cmd install --prod=false
if errorlevel 1 exit /b 1
call pnpm.cmd start

endlocal
