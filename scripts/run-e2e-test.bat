@echo off
setlocal EnableExtensions
chcp 65001 >nul
echo ========================================
echo futureFlow E2E 全自动测试
echo ========================================
echo.

echo [1/5] 检查 Docker...
docker --version >nul 2>&1
if errorlevel 1 (
    echo [错误] Docker 未安装或未启动
    exit /b 1
)
echo [OK] Docker 已就绪

echo.
echo [2/5] 启动容器...
docker compose down --remove-orphans 2>nul
docker compose up -d
if errorlevel 1 (
    echo [错误] 容器启动失败
    exit /b 1
)

echo.
echo [3/5] 等待 Dify 就绪...
rem 每次探测最多 1 秒，失败后等待 2 秒；60 次约 180 秒后明确失败。
for /L %%I in (1,1,60) do (
    curl.exe -fsS --connect-timeout 1 --max-time 1 http://localhost:5001/health >nul 2>&1
    if not errorlevel 1 goto dify_ready
    if %%I LSS 60 timeout /t 2 /nobreak >nul
)
echo [错误] 等待 Dify API 就绪超时（约 180 秒）
docker compose ps
exit /b 1

:dify_ready
echo [OK] Dify API 已就绪

echo.
echo [4/5] 初始化 Dify (创建管理员、应用、API Key)...
docker compose up -d dify-init
timeout /t 10 /nobreak >nul

echo.
echo [5/5] 启动网关并运行测试...
if "%GATEWAY_BOOTSTRAP_ADMIN_USERNAME%"=="" (
    echo [错误] 请先设置 GATEWAY_BOOTSTRAP_ADMIN_USERNAME
    exit /b 1
)
if "%GATEWAY_BOOTSTRAP_ADMIN_EMAIL%"=="" (
    echo [错误] 请先设置 GATEWAY_BOOTSTRAP_ADMIN_EMAIL
    exit /b 1
)
if "%GATEWAY_BOOTSTRAP_ADMIN_PASSWORD%"=="" (
    echo [错误] 请先设置 GATEWAY_BOOTSTRAP_ADMIN_PASSWORD
    exit /b 1
)
set GATEWAY_BOOTSTRAP_ADMIN_ENABLED=true
set GATEWAY_PORT=3201
if not exist "gateway\node_modules" (
    echo [错误] 缺少依赖，请先运行 corepack pnpm install --frozen-lockfile
    exit /b 1
)
call corepack pnpm --filter futureflow-gateway build
if errorlevel 1 exit /b 1
cd gateway
start /B node dist/src/main.js
cd ..
timeout /t 5 /nobreak >nul

echo.
echo ========================================
echo 运行 API 接口测试...
echo ========================================

set GATEWAY_BASE_URL=http://localhost:3201
node scripts\api-test.cjs
if errorlevel 1 (
    echo [错误] API 集成测试失败
    exit /b 1
)

echo.
echo ========================================
echo API 集成测试全部通过！
echo ========================================
echo.
echo 服务地址:
echo   - Dify 控制台: http://localhost:8080
echo   - Dify API:    http://localhost:5001
echo   - 网关:        http://localhost:3201
endlocal & exit /b 0
