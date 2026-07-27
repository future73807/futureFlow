@echo off
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
:wait_dify
curl -s http://localhost:5001/health >nul 2>&1
if errorlevel 1 (
    timeout /t 3 /nobreak >nul
    goto wait_dify
)
echo [OK] Dify API 已就绪

echo.
echo [4/5] 初始化 Dify (创建管理员、应用、API Key)...
docker compose up -d dify-init
timeout /t 10 /nobreak >nul

echo.
echo [5/5] 启动网关并运行测试...
cd gateway
call npm install
call npm run build
start /B node dist/src/main.js
cd ..
timeout /t 5 /nobreak >nul

echo.
echo ========================================
echo 运行 API 接口测试...
echo ========================================

set GATEWAY=http://localhost:3001

echo.
echo [测试 1] 健康检查...
curl -s %GATEWAY%/health
echo.

echo.
echo [测试 2] 管理员登录...
for /f "delims=" %%i in ('curl -s -X POST %GATEWAY%/auth/login -H "Content-Type: application/json" -d "{\"account\":\"demo\",\"password\":\"demo123456\"}"') do set LOGIN_RESP=%%i
echo %LOGIN_RESP%

echo.
echo [测试 3] 获取仪表盘统计...
curl -s %GATEWAY%/admin/stats -H "Authorization: Bearer dummy"
echo.

echo.
echo [测试 4] 获取 Dify 状态...
curl -s %GATEWAY%/admin/dify/status -H "Authorization: Bearer dummy"
echo.

echo.
echo ========================================
echo 测试完成！
echo ========================================
echo.
echo 服务地址:
echo   - Dify 控制台: http://localhost:8080
echo   - Dify API:    http://localhost:5001
echo   - 网关:        http://localhost:3001
echo   - 前端:        http://localhost:3000
echo.
echo 按任意键退出...
pause >nul
