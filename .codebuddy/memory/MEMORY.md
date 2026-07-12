# futureFlow 项目长期记忆

## 项目概览
- **名称**: futureFlow — AI 工作流平台
- **架构**: 三层解耦（FlowGram 画布 + 自研 NestJS 网关 + Dify 无头执行引擎）
- **目录**: `demo-free-layout/`（前端）、`gateway/`（后端网关）
- **数据库**: PostgreSQL 16 (Docker Compose)
- **包管理**: pnpm workspace (pnpm@11.10.0, Node>=20)

## 技术栈
- **前端**: React 18 + @flowgram.ai/free-layout-editor 1.0.x + @douyinfe/semi-ui 2.80+ + Rsbuild + styled-components + TypeScript 5.5 + **react-router-dom 6**（路由系统）
- **后端**: NestJS 10 + TypeORM 0.3 + PostgreSQL + class-validator + **@nestjs/jwt** + **bcryptjs**
- **执行层**: Dify（外部 Docker 部署，通过 Service API SSE 调用 + Console API DSL 导入）

## 前端 UI 设计规范（2026-07-12 重构）
- **主色调**: #4834d4 (紫色) / #1a1d29 (深色背景) / #f5f6f8 (浅色内容区)
- **登录页**: 左右分栏 — 左侧深色渐变(#1a1a2e→#0f3460)+品牌特性列表，右侧白色玻璃卡片
- **侧边栏**: 240px 深色(#1a1d29) — Logo+导航菜单+用户卡片+退出登录按钮（红色 hover）
- **工作流列表**: 卡片网格(300px min) — 图标+标题+描述+操作按钮，hover 上浮+紫色阴影
- **个人中心**: 4 列统计卡片 + 账号信息网格 + API Key 管理表格
- **圆角**: 卡片 12px / 按钮 8px / 代码块 6px
- **字体**: 标题 heading=3/5，正文 14px，辅助文字 12-13px

## 中文乱码根因与修复
- **根因**: PowerShell 发送 JSON body 时用 GBK 编码，导致中文被破坏存入数据库
- **修复**: 删除乱码数据；前端创建工作流时在 `workflow-list/index.tsx` 的 `handleCreate` 中内联完整的中文 FlowGram JSON（Start→LLM→End），确保通过浏览器 fetch 发送 UTF-8 编码数据
- **验证**: 画布中 systemPrompt 正常显示「你是一个友好的 AI 助手，请用简洁的中文回答用户的问题。」
- `/login` → 登录/注册独立页面（紫色渐变背景）
- `/` → 主布局（侧边栏 + 内容区），默认显示工作流列表
- `/profile` → 个人中心（用户信息 + API Key 管理）
- `/canvas/:id` → 画布编辑器（从后端加载工作流 + 保存）
- `PrivateRoute` 组件：未登录自动跳转 `/login`

## 后端新增实体和接口
- **Workflow 实体**: id, userId, name, description, flowgramJson(jsonb), status, version
- **ApiKey 实体**: id, userId, name, keyPrefix, keyHash(sha256), lastUsedAt, expiresAt, revoked
- **工作流 CRUD**: `GET/POST /workflows`, `GET/PUT/DELETE /workflows/:id`, `POST /workflows/:id/duplicate`（全部 JwtAuthGuard 保护）
- **API Key 管理**: `GET/POST /user/api-keys`, `DELETE /user/api-keys/:id`（全部 JwtAuthGuard 保护）

## DeepSeek 模型配置
- 定价表已添加 `deepseek-v4-pro`（input:0.002, output:0.008）和 `deepseek-v4-flash`（input:0.0005, output:0.002）
- DSL 转换器的 MODEL_PROVIDER_MAP 已添加 deepseek-v4-pro 和 deepseek-v4-flash → provider: "deepseek"
- 前端 LLM 节点默认值和初始数据已更新为 deepseek-v4-pro + DeepSeek API Key
- API Key: `***REMOVED***`，Host: `https://api.deepseek.com`

## 直接 LLM 执行模式（DirectLlmService）
- **文件**: `gateway/src/workflows/direct-llm.service.ts`
- **作用**: 当 Dify 未配置时，网关直接调用 OpenAI 兼容 API（DeepSeek），绕过 Dify 引擎
- **执行流程**: 拓扑排序节点 → 逐个执行（start/llm/end）→ 调用 `/v1/chat/completions` → 以 Dify SSE 兼容格式返回
- **SSE 事件**: workflow_started → node_started → node_finished → text_chunk → workflow_finished
- **变量解析**: 支持 `{{start_0.query}}` 变量引用，从 Start 节点提取输入值
- **已验证**: 2026-07-12 浏览器测试通过，DeepSeek API 返回 323 tokens，耗时 6.03s，扣费结算正常
- **切换条件**: `difyClient.isConfigured()` 为 true 走 Dify，false 走 DirectLlm

## Dify 配置校验服务（DifyConfigService）
- **文件**: `gateway/src/dify/dify-config.service.ts`
- **职责**: 读取 .env 中的 DIFY_API_KEY，验证必须为 `app-` 前缀 + 至少 16 位字母数字的密钥格式
- **正则**: `^app-[a-zA-Z0-9]{16,}$`
- **状态类型**: configured / not_configured / invalid_format / missing_base
- **启动诊断**: onModuleInit 时输出 ✅/⚠️/❌ 日志，提示降级或配置建议
- **API 接口**: `GET /workflows/dify-status` 返回配置状态 + Dify 连通性探测 + 执行模式
- **降级流程**: Dify 未配置 → 返回 `engine_degraded` SSE 事件（前端 Toast 提示）→ 自动走 DirectLlmService

## Dify Docker Compose 部署
- **文件**: `docker-compose.yml`（完整 7 服务编排）
- **服务**: postgres + dify-redis + dify-postgres + dify-api(0.15.3) + dify-worker + dify-web(:8080) + dify-weaviate
- **Dify 控制台**: http://localhost:8080
- **Dify API**: http://localhost:5001
- **部署命令**: `docker compose up -d`（启动全部）
- **获取 API Key**: Dify 控制台 → 创建工作流应用 → 访问 API → 复制 app- 前缀密钥 → 填入 .env

## 关键设计决策
- 2026-07-12: 完成 MVP 全面评估，输出 `docs/MVP评估与账号分级管理中台方案.md`
  - 识别 5 个 P0 缺陷（VIP 权限与 DSL 转换器不一致、API Key 硬编码、无登录体系、CORS 过宽、synchronize 风险）
  - 设计 RBAC + VIP 等级双维度权限模型（4 系统角色 × 4 VIP 等级）
  - 规划全栈技术栈（用户前端扩展现有 + 管理中台用 Ant Design Pro + 后端新增 JWT/RBAC/Redis）
  - 设计 8 大管理模块 + 50+ API 接口 + 完整数据库 Schema

## 已实现功能状态（截至 2026-07-12 实施完成）
- ✅ FlowGram 画布渲染与交互
- ✅ 网关 SSE 工作流执行链路（权限→扣费→DSL转换→Dify→SSE透传）
- ✅ 扣费全流程（冻结→结算→退款，事务+悲观锁）
- ✅ Dify Service API SSE 对接
- ✅ **DSL 转换器支持 start/llm/end/http/code（P0-1 已修复）**
- ✅ **用户注册/登录体系（JWT + bcrypt + API Key 向后兼容，P0-2/P0-3 已修复）**
- ✅ **CORS 白名单模式（P0-4 已修复）**
- ✅ **TypeORM synchronize 环境变量控制（P0-5 已修复）**
- ✅ **前端登录对话框 + 用户信息展示（JWT + Cookie 降级）**
- ✅ **前端移除硬编码 API Key，接入登录态**
- ✅ **健康检查路由改为 GET（RESTful 合规）**
- ❌ 无工作流持久化（保存按钮仅 console.log）
- ❌ 无管理后台
- ❌ 无余额管理/充值

## 新增依赖
- `@nestjs/jwt` (v11.0.2) — JWT 签发/验证
- `bcryptjs` (v3.0.3) — 密码哈希

## 核心实体（扩展后）
- `users`: id, username, email, passwordHash, apiKey(可空), vipLevel(free/pro/enterprise), balance, frozenBalance, status(active/banned/suspended)
- `balance_logs`: userId, type(freeze/deduct/unfreeze/refund/recharge), amount, balanceAfter
- `workflow_runs`: userId, status, flowgramJson, difyWorkflowId, totalTokens, estimatedCost, actualCost

## 网关 API 路由（新增后）
- `POST /auth/register` — 用户注册
- `POST /auth/login` — 用户登录（JWT + 用户信息）
- `GET /auth/profile` — 获取当前用户（JWT Guard）
- `GET /auth/vip-info` — 获取 VIP 权限信息（JWT Guard）
- `POST /workflows/run` — SSE 流式执行（JWT/API Key 双鉴权）
- `GET /workflows/health` — 健康检查

## 种子数据
- 默认用户: username=`demo`, email=`demo@futureflow.ai`, password=`demo123456`, apiKey=`demo-api-key-001`, vipLevel=`pro`, balance=100

## 改造路线图
- ✅ 第一阶段(1-2周): 修复 P0（登录体系 + 权限一致性 + CORS + synchronize）—— **已完成并通过测试**
- 第二阶段(2-3周): 核心管理中台（用户/VIP/计费管理 + 前端节点灰显）
- 第三阶段(2-3周): 工作流持久化 + 执行历史 + 审计日志 + 数据看板
- 第四阶段(1-2周): 安全加固 + K8s 部署
