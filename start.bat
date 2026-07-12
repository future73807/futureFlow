@echo off
REM ============================================================
REM futureFlow 一键启动脚本 (Windows)
REM 启动顺序:PostgreSQL -> 网关 -> FlowGram 画布
REM 使用 pnpm workspace 管理
REM ============================================================

setlocal

echo.
echo ============================================================
echo   futureFlow 一键启动
echo   FlowGram 画布  +  自研网关  +  PostgreSQL
echo ============================================================
echo.

REM 0. 检查 pnpm
where pnpm >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 pnpm,请先安装: npm i -g pnpm
    exit /b 1
)

REM 1. 检查 .env 文件(三层 API Key 体系自动配置)
if not exist ".env" (
    echo [1/4] 未找到 .env 文件,从模板复制...
    copy /Y .env.example .env >nul
    echo       已创建 .env
    echo.
    echo   三层 API Key 体系说明(详见 README):
    echo     * LLM_API_KEY   sk-xxx   网关调用 DeepSeek/OpenAI,自动内置
    echo     * DIFY_API_KEY  app-xxx  网关调用 Dify Service API,自动内置
    echo     * 平台 API Key  ff-xxx   用户在个人中心创建(无需在此配置)
    echo.
    echo   首次启动请在 .env 中填写 LLM_API_KEY ^(必填^)
    echo   DIFY_API_KEY 未配置时自动降级为直接 LLM 模式
) else (
    echo [1/4] .env 已存在
)
echo.

REM 2. 安装根目录依赖
echo [2/4] 检查根目录依赖...
call pnpm install --prod=false
echo.

REM 3. 安装 workspace 子项目依赖
if not exist "gateway\node_modules" (
    echo [3/4] 安装 workspace 所有依赖(首次较慢)...
    call pnpm install
) else (
    if not exist "demo-free-layout\node_modules" (
        echo [3/4] 安装 workspace 所有依赖(首次较慢)...
        call pnpm install
    ) else (
        echo [3/4] workspace 依赖已安装
    )
)
echo.

REM 4. 启动数据库
echo [4/4] 启动 PostgreSQL...
docker compose up -d postgres
echo.

REM 5. 并行启动网关和前端
echo ============================================================
echo   启动网关 (:3001) 和 画布 (:3000, rsbuild 自动开浏览器)
echo   按 Ctrl+C 可停止全部服务
echo ============================================================
echo.

call pnpm run dev:concurrent

endlocal
