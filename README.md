AI 工作流平台技术落地方案
=========================

## 零、 一键启动(快速开始)

futureFlow 提供了一键启动脚本,自动完成环境变量配置、依赖安装和三层服务启动。

### Windows(推荐)

```bat
start.bat
```

脚本会自动:
1. 从 `.env.example` 复制生成 `.env`(首次启动)
2. 安装 pnpm workspace 依赖
3. 启动 PostgreSQL(`docker compose up -d postgres`)
4. 并行启动网关(:3001)和 FlowGram 画布(:3000)

### 跨平台(pnpm 命令)

```bash
# 1. 复制环境变量模板(首次)
cp .env.example .env

# 2. 编辑 .env,至少填写 LLM_API_KEY(sk-xxx,DeepSeek/OpenAI 密钥)
#    DIFY_API_KEY(app-xxx)可选,未配置时自动降级为直接 LLM 模式
#    若要启用 Dify 引擎,先 docker compose up -d 启动 Dify,再在控制台获取 app- 密钥

# 3. 安装依赖
pnpm install

# 4. 启动数据库
pnpm run db:up

# 5. 一键启动网关 + 画布(并发)
pnpm start
# 或:pnpm run dev:concurrent
```

### 启动后访问

| 服务 | 地址 | 说明 |
|------|------|------|
| FlowGram 画布 | http://localhost:3000 | 拖拽编排工作流 |
| 网关 API | http://localhost:3001 | 鉴权/扣费/DSL 转换 |
| Dify 控制台 | http://localhost:8080 | 创建工作流应用、获取 app- 密钥(需先 `docker compose up -d`) |

### 三层 API Key 自动配置

启动脚本会自动从 `.env` 读取下列密钥,**用户无需在画布上手动填写**:

| 密钥 | 环境变量 | 用途 | 格式 |
|------|----------|------|------|
| LLM API Key | `LLM_API_KEY` | 网关调用 DeepSeek/OpenAI | `sk-xxx` |
| Dify API Key | `DIFY_API_KEY` | 网关调用 Dify Service API | `app-xxx` |

详见下方「六、 API Key 体系」章节。

---

## 一、 架构总览:混合三层架构

本方案摒弃了"从零造轮子"和"重度魔改现有平台"的极端,采用**解耦的混合架构**。

```mermaid
flowchart TD
    subgraph L1 ["1. 表现层: 魔改 FlowGram"]
        A[用户操作画布<br/>拖拽/连线/配置节点]
        B[输出 FlowGram DSL JSON]
    end

    subgraph L2 ["2. 控制层: 自研薄网关"]
        C[接收 FlowGram JSON]
        D{权限校验<br/>VIP等级/节点可用性}
        E{扣费预检<br/>预估费用/校验余额}
        F[DSL 转换器<br/>FlowGram 转 Dify 格式]
        G[透传请求至 Dify]
        H[流式接收结果并计算扣费]
    end

    subgraph L3 ["3. 执行层: 无头 Dify"]
        I[(Dify Workflow Engine)]
        J[调度器 DAG]
        K[节点执行器<br/>LLM/HTTP/Code/MCP]
    end

    A --> B --> C
    C --> D
    D -- 拒绝 --> A
    D -- 通过 --> E
    E -- 余额不足 --> A
    E -- 通过 --> F --> G
    G --> I --> J --> K
    K --> H --> A
```

### 各层职责划分

1. **表现层 (FlowGram)**:仅负责画布渲染、交互体验、节点表单配置和状态管理。输出标准的 FlowGram JSON。
2. **控制层 (自研薄网关)**:系统的"大脑"。负责用户鉴权、VIP 权限拦截、节点级扣费计算、以及**最关键的 DSL 格式转换**。
3. **执行层 (Dify 无头模式)**:系统的"肌肉"。仅作为纯执行引擎,接收转换后的 Dify DSL,负责调度执行(调用 AI、跑 JS 沙箱、请求 API),并将结果流式返回。

---

## 二、 为什么选择此方案?(决策依据)

| 对比项                 | 本方案                                             | 纯魔改 Dify                                  | 纯 React Flow + 自研引擎                           |
| :--------------------- | :------------------------------------------------- | :------------------------------------------- | :------------------------------------------------- |
| **前端画布体验** | ⭐⭐⭐⭐⭐FlowGram 原生交互极佳,支持固定/自由布局 | ⭐⭐⭐Dify 画布可魔改,但受限于其原有框架    | ⭐⭐React Flow 需从零写连线/对齐/缩放,体验难调优  |
| **后端引擎成本** | ⭐⭐⭐⭐⭐复用 Dify 成熟引擎,免维护沙箱/MCP/调度  | ⭐⭐⭐⭐自带引擎,但深度魔改容易导致升级困难 | ⭐需从零实现 DAG 调度、JS 沙箱、并发控制,深不见底 |
| **核心业务可控** | ⭐⭐⭐⭐⭐扣费和权限完全在网关层,100% 自主可控    | ⭐⭐⭐需侵入 Dify 源码加拦截器,耦合度高     | ⭐⭐⭐⭐⭐100% 自主,但代价是后端全量开发          |
| **综合开发周期** | **约 3-4 周** (主要集中在网关转换器)         | 约 4-6 周 (前后端魔改联调)                   | 约 2-3 个月 (前后端均需重度开发)                   |

---

## 三、 关键技术点与实现路径

### 1. 前端:基于 FlowGram 定制画布

* **初始化**:使用 `npx @flowgram.ai/create-app@latest` 拉取基础模板,选择自由布局 以适应 AI 工作流的灵活连线。
* **节点注册**:为你的业务注册自定义节点(如 `MyLLMNode`, `MyHTTPNode`)。每个节点包含两部分:
  * `render`: 节点在画布上的外观。
  * `form`: 节点的配置面板(选择模型、填写 Prompt、配置 API Headers 等)。
* **数据输出**:监听画布变更,将节点和连线数据序列化为 FlowGram 的标准 JSON 格式,供后续提交。

### 2. 网关:自研控制层的核心逻辑

建议使用 Node.js (NestJS) 或 Go (Gin) 实现,因为它们处理高并发和流式响应较好。

* **拦截器模式**:所有前端发起的 `/run-workflow` 请求必先经过此层。
* **权限校验**:解析 FlowGram JSON 中的 `nodes` 数组,判断当前用户 VIP 等级是否有权使用这些节点类型。若无权,直接拒绝并提示前端。
* **扣费预检**:根据节点配置(如使用的模型、预估循环次数)计算预扣费金额。若用户余额不足,拒绝执行。
* **DSL 转换器 (核心开发点)**:
  * 将 FlowGram 的 `nodes` 映射为 Dify DSL 的 `nodes`。
  * 将 FlowGram 的 `edges` 映射为 Dify DSL 的 `edges`。
  * 将节点内的配置参数(如 Prompt 模板)转换为 Dify 期望的格式。

### 3. 引擎:无头部署 Dify

* **部署**:使用 Docker Compose 标准部署开源版 Dify。
* **应用创建**:在 Dify 后台创建一个"空白工作流"应用,获取其 API Key。
* **执行接口**:你的自研网关调用 Dify 的 `POST /v1/workflows/run` 接口,并务必设置 `response_mode: "streaming"`。
* **流式透传**:网关接收到 Dify 的 SSE(Server-Sent Events)流式数据后,原样透传给前端 FlowGram 画布,实现打字机效果或节点执行进度展示。

---

## 四、 开发计划与里程碑 (预估 4 周)

### 第一周:基础搭建与跑通链路

* **目标**:打通"FlowGram 画布 -> 网关 -> Dify 执行"的最简链路。
* **任务**:
  1. 本地部署 Dify,创建空白应用,测试 API 调用。
  2. 初始化 FlowGram 项目,跑通官方 Demo。
  3. 在 FlowGram 中实现一个最简单的 `LLM` 节点(仅含 Prompt 输入)。
  4. 编写极简网关,接收 JSON,硬编码转换为 Dify 格式并调通执行。

### 第二周:核心节点开发与 DSL 转换

* **目标**:完善业务所需的基础节点,完成完整的转换器。
* **任务**:
  1. 在 FlowGram 中实现 `HTTP 请求` 节点和 `代码执行` 节点的配置表单。
  2. 在网关层编写完整的 DSL 转换逻辑,支持这三大基础节点的任意拓扑结构。
  3. 处理变量引用(如节点 A 的输出作为节点 B 的输入),这是最难的部分,需仔细对齐两边的变量作用域逻辑。

### 第三周:商业逻辑接入(扣费与权限)

* **目标**:系统具备商业化能力。
* **任务**:
  1. 设计用户余额表和扣费流水表。
  2. 在网关层实现权限拦截中间件。
  3. 实现扣费逻辑:执行前冻结余额,执行中根据 Dify 返回的实际 Token 用量计算最终费用并扣除,失败则解冻。

### 第四周:体验优化与联调测试

* **目标**:产品化打磨,准备上线。
* **任务**:
  1. 前端处理流式数据,展示节点执行状态(成功/失败/运行中)和中间输出。
  2. 异常处理:Dify 执行超时、API 报错等情况的兜底提示。
  3. 画布交互优化:保存草稿、加载已有工作流、JSON 格式校验。
  4. 全链路压测,确保网关不成为性能瓶颈。

---

## 五、 风险预警与应对策略

1. **DSL 转换复杂度风险**
   * *风险*:FlowGram 和 Dify 对"变量作用域"和"循环/条件分支"的表达可能不一致,导致转换困难。
   * *应对*:第一期**砍掉复杂的 Loop 和 Condition 节点**,只做线性流程和简单分支。待核心链路稳定后,再逐步支持复杂控制流。
2. **Dify 版本升级兼容性**
   * *风险*:Dify 更新后,其内部 DSL 格式或 API 接口可能变化,导致你的网关失效。
   * *应对*:**锁定 Dify 版本**(如固定使用 v0.6.x)。不要盲目追新版本,待新版本稳定且有必要时再人工适配转换器。
3. **流式响应中断处理**
   * *风险*:网络波动导致 Dify 到网关、或网关到前端的 SSE 连接断开,造成"扣了费但没看到结果"。
   * *应对*:网关层需具备 SSE 断线重连机制;前端需具备结果补偿机制(如通过任务 ID 轮询最终结果)。

---

**总结**：这份方案通过"组合拳"的方式，将最难的前端画布和后端执行引擎交给了成熟的开源方案，而将最核心的商业逻辑留给自己。只要攻克了"DSL 转换"这个咽喉要道，你就能以最低的成本、最快的速度搭建出一个高可控、体验好的 AI 工作流平台。

---

## 六、 API Key 体系

futureFlow 采用三层 API Key 架构，各层职责分离、互不耦合：

| 层级 | 用途 | 格式 | 来源 | 管理方式 |
|------|------|------|------|----------|
| **平台 API Key** | 外部系统调用 futureFlow 工作流 API | `ff-<32hex>` | 个人中心创建 | 数据库哈希存储，支持创建/撤销 |
| **LLM API Key** | 网关调用大模型（DeepSeek/OpenAI 等） | `sk-xxx` | 环境变量 `LLM_API_KEY` | 自动内置，用户无感 |
| **Dify API Key** | 网关调用 Dify Service API | `app-xxx` | 环境变量 `DIFY_API_KEY` | Dify 后台创建工作流应用后获取 |

### 平台 API Key（用户管理）

用户在个人中心创建和管理平台 API Key，用于通过 API 调用工作流：

```bash
# 创建 API Key（需 JWT 登录）
curl -X POST http://localhost:3001/user/api-keys \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"name": "生产环境"}'

# 调用工作流（使用 API Key 鉴权）
curl -X POST http://localhost:3001/workflows/run \
  -H "Authorization: Bearer ff-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"flowgram": {...}}'
```

- 创建时返回完整明文，**仅显示一次**，请妥善保存
- 数据库仅存储 SHA-256 哈希值，无法反推明文
- 支持随时撤销（软删除）
- 鉴权中间件同时支持 JWT 和 API Key 两种方式

### LLM API Key（网关内置）

网关从环境变量自动读取大模型 API Key，**用户无需在画布上手动配置**：

```env
# .env
LLM_API_KEY=sk-your-deepseek-key
LLM_API_HOST=https://api.deepseek.com
```

- 画布上的 LLM 节点只暴露模型名称、温度、提示词等业务参数
- API Key 和 API Host 完全由网关管理，安全且便于轮换
- 当 Dify 未配置时，网关降级为直接调用大模型 API

### Dify API Key（运维配置）

网关从环境变量读取 Dify Service API Key，用于调用 Dify 工作流引擎：

```env
# .env
DIFY_API_BASE=http://localhost/v1
DIFY_API_KEY=app-xxxxxxxxxxxxxxxx
```

- 在 Dify 后台创建工作流应用后获取
- 必须为 `app-` 前缀格式
- 配置后网关走 Dify 执行路径（SSE 流式），未配置时降级为直接 LLM 模式

### 执行引擎选择逻辑

```
用户调用 POST /workflows/run
        │
        ▼
   鉴权校验（JWT 或 ff- API Key）
        │
        ▼
   Dify 已配置？
    ├─ 是 → 调用 Dify Service API（SSE 流式）
    │      └─ Dify 内部调用大模型（使用 Dify 自身的 Key）
    └─ 否 → 降级模式：直接调用大模型 API
           └─ 使用环境变量 LLM_API_KEY（网关内置）
```

---

## 七、 管理员后台

futureFlow 内置管理员后台，用于管理用户、API Key、工作流和财务流水。仅在用户 `role = 'admin'` 时可见。

### 访问入口

登录后，管理员账号的左侧导航栏会多出 **「管理员后台」** 菜单项，或直接访问 `http://localhost:3000/admin`。

**默认管理员账号**（首次启动自动创建）：

| 账号 | 密码 | 角色 |
|------|------|------|
| `demo` | `demo123456` | `admin` |

### 功能模块

| 模块 | 功能说明 |
|------|----------|
| **仪表盘** | 统计注册用户数、API Key 数、工作流数、运行总次数、Token 消耗与总费用；展示最近 7 天运行趋势柱状图 |
| **用户管理** | 查看所有用户、调整任意用户余额、修改 VIP 等级（free/pro/enterprise）、封禁/解封账号、删除用户 |
| **API Key 管理** | 查看全站所有 API Key（含所属用户、使用时间、吊销状态），管理员可一键吊销任意 Key |
| **工作流管理** | 查看所有用户创建的工作流列表 |
| **运行记录** | 查看全站工作流运行历史（状态、Token、费用、耗时、错误信息） |
| **余额流水** | 查看所有余额变动记录（冻结/扣费/充值/退款），含变动后余额，溯源每一笔交易 |

### 管理员 API 接口

所有管理员接口位于 `http://localhost:3001/admin/*`，需要 JWT Token 且 `role = 'admin'`：

```
GET    /admin/stats                    # 仪表盘统计
GET    /admin/users                    # 用户列表（分页）
PATCH  /admin/users/:id/balance        # 调整余额 { delta, remark }
PATCH  /admin/users/:id/vip            # 修改 VIP { vipLevel }
PATCH  /admin/users/:id/status         # 修改状态 { status }
DELETE /admin/users/:id                # 删除用户
GET    /admin/api-keys                 # API Key 列表
DELETE /admin/api-keys/:id             # 吊销 API Key
GET    /admin/workflows                # 工作流列表
GET    /admin/runs                     # 运行记录
GET    /admin/balance-logs             # 余额流水
```

调用示例：

```bash
# 获取仪表盘统计
curl http://localhost:3001/admin/stats \
  -H "Authorization: Bearer <ADMIN_JWT>"

# 给用户充值 100 元
curl -X PATCH http://localhost:3001/admin/users/<USER_ID>/balance \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"delta": 100, "remark": "管理员充值"}'
```

### 普通用户提升为管理员

直接操作数据库修改 `users` 表：

```sql
-- 将某个用户提升为管理员
UPDATE users SET role = 'admin' WHERE username = '<username>';
```
