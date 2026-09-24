# ff-embed/v1 —— 把 flow 嵌进宿主应用的开放协议

> **地位**：对外发布的前端嵌入协议 + 宿主回调契约。实现分两侧：前端协议模块
> `frontend/src/embed/protocol.ts`（消息校验的唯一实现，网关冒烟直接 import 它回归）、
> 宿主回调契约 `gateway/src/host/*` 与宿主侧参考实现（KenFutWork 主仓
> `packages/shared/src/flow-host.ts` + `/api/flow/host/*`）。
>
> **稳定性承诺**：`v1` 对外稳定——破坏性变更必须升版本号并给出兼容窗口；
> 两侧各自声明支持版本，**版本不匹配时 flow 降级为独立模式并在界面明示**（不静默）。

## 1. 角色与安全模型

| 角色 | 职责 |
| --- | --- |
| **宿主（host）** | 承载 iframe 的任意应用。签发身份令牌；可选：下发引擎凭证、承担计费、接收运行事件、提供视觉令牌、接收导航通知 |
| **flow（被嵌方）** | 前端画布 + 网关。**不信任宿主消息**：入站 postMessage 一律 origin 白名单 + schema 校验；宿主响应（服务端回调）同样过 class-validator 校验，不 `as` 硬吞 |

两条硬边界：

1. **前端永不解析宿主令牌**。令牌只被原样交给网关（`POST /host/ff-embed/v1/session`），
   由网关回调宿主服务端验签（§4.1），换回 flow 自己的会话。宿主给的 `subject`
   只有经过这趟服务端交换才可信。
2. **白名单由网关下发**（`HOST_ALLOWED_ORIGINS` → `/host/ff-embed/v1/capabilities`），
   不采信 URL 参数——否则任意站点都能声称自己是宿主。

## 2. 前端握手时序（postMessage）

```
宿主页面                         flow 前端（iframe）                flow 网关
   │                                  │                               │
   │          (iframe 加载完成，flow 主动拉能力)                        │
   │                                  │ GET /host/ff-embed/v1/capabilities
   │                                  │◄──────────────────────────────│
   │                                  │ （mode/capabilities/allowedOrigins/notes）
   │◄──── ff-embed/hello ─────────────│                               │
   │  （version + flow 侧能力）        │                               │
   │──── ff-embed/hello-ack ─────────►│ （版本协商：不同→降级+明示）      │
   │──── ff-embed/identity ──────────►│ （hostToken，前端不解析）        │
   │                                  │ POST /host/ff-embed/v1/session │
   │                                  │  { hostToken } ───────────────►│
   │                                  │         （网关回调宿主验签，§4.1）│
   │◄──── ff-embed/ready ─────────────│◄──── { accessToken, user } ────│
   │──── ff-embed/theme（可选）───────►│ （--ff-* 令牌 + 明暗 + brand）   │
   │                                  │                               │
   │◄──── ff-embed/run-event（多次）───│  （运行事件，带 run 内单调 seq）  │
   │◄──── ff-embed/navigation（可选）──│  （如 workflow-created）        │
   │◄──── ff-embed/error（可选）───────│                               │
   │◄──── ff-embed/bye ───────────────│  （beforeunload）              │
```

**宿主 origin 的判定**（flow 侧，三者按可信度取）：`location.ancestorOrigins`
（浏览器原生，伪造不了）→ 白名单**唯一**时的那一项 → `document.referrer` 的 origin
（必须在白名单内）。都拿不到就拒绝握手并降级——宁可降级，不把会话交给来历不明的 frame。

### 2.1 消息类型全表（v1 封闭集合）

每条消息都带 `type` 与 `version`（协议版本字符串，`"v1"`）。

| type | 方向 | 载荷要点 |
| --- | --- | --- |
| `ff-embed/hello` | flow→宿主 | `capabilities`（flow 侧能力）+ `protocolVersion` |
| `ff-embed/hello-ack` | 宿主→flow | `version`（版本协商；不匹配 flow 降级并明示原因） |
| `ff-embed/identity` | 宿主→flow | `hostToken: string`（≤8KB；前端不解析，只转交网关） |
| `ff-embed/theme` | 宿主→flow | `tokens?: Record<string,string>`（**键必须 `--ff-` 前缀**，值 ≤200 字符，防任意 CSS 变量注入）、`mode?: "light"|"dark"`、`brand?: boolean`（内嵌默认去品牌；显式 `true` 保留） |
| `ff-embed/ready` | flow→宿主 | `user`（交换成功后的 flow 用户档案） |
| `ff-embed/run-event` | flow→宿主 | `runId` / `seq`（run 内单调递增）/ `eventType` / `payload` / `at`（ISO 时间）——宿主可按 `lastSeq` 做断线重放 |
| `ff-embed/navigation` | flow→宿主 | 自由载荷，如 `{ kind: "workflow-created", workflowId, name }` |
| `ff-embed/error` | flow→宿主 | `reason: string`（可读错误） |
| `ff-embed/bye` | flow→宿主 | 无（卸载通知） |

入站（宿主→flow）消息校验失败一律**静默丢弃并计数**——页面里可能同时有别的库在
postMessage，把噪音当故障会让排查看错方向。出站消息 `postMessage` 的 targetOrigin
是握手确定的宿主 origin（不用 `*`）。

## 3. 网关端点（内嵌模式握手用）

| 端点 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/host/ff-embed/v1/capabilities` | GET | 公开 | 回 `{ protocolVersion, mode, capabilities, allowedOrigins, sessionPath, notes }`。握手发生在 flow 前端还没有任何凭据之前，故公开；响应不含密钥或用户数据。`notes` 是降级原因清单（哪条缝由谁承担） |
| `/host/ff-embed/v1/session` | POST | 公开（出示的是宿主令牌） | 请求 `{ hostToken: string }`（≤8KB）；成功回 `{ accessToken, expiresIn, user }`。网关内部回调宿主验签（§4.1）后按 `subject` get-or-create flow 用户 |

会话语义：宿主用户在 flow 侧**无本地密码**（只能由宿主换取会话）；本地停用状态
不被宿主登录态覆盖（403）；displayName / email 每次交换按宿主值同步（email 冲突保留
flow 侧原值，不阻断登录）。

## 4. 宿主回调端点（网关 → 宿主，服务端对服务端）

调用约定（全部相同）：

- `Authorization: Bearer <HOST_SHARED_SECRET>`（宿主侧必须定长比较，防时序侧信道）；
- `x-ff-embed-protocol: v1` 请求头 + 请求体 `protocolVersion` 字段；
- 涉及计费的请求带 `x-idempotency-key`（§4.3）；
- 超时：`HOST_REQUEST_TIMEOUT_MS`（缺省 5000ms）内无响应按失败处理。

### 4.1 身份验签（`HOST_IDENTITY_VERIFY_URL`，内嵌模式**必填**）

```
POST {url}  { "token": "<宿主会话令牌>", "protocolVersion": "v1" }
→ 200 { "subject": "≤256字符，宿主侧稳定用户标识", "displayName?": "≤128", "email?": "≤320" }
→ 401 令牌无效；400 形状不合法
```

宿主实现要点：令牌由宿主自己验签（它是签发方）；`subject` 是稳定外部键（flow 按
它 get-or-create）。KenFutWork 主仓的参考实现：`POST /api/flow/host/identity`。

### 4.2 凭证下发（`HOST_CREDENTIALS_URL`，可选；缺省回落 `.env` 全局密钥）

```
POST {url}  { "protocolVersion": "v1" }
→ 200 { "apiBase": "http(s)://…（Dify 地址）", "apiKey": "≤512", "label?": "≤64" }
```

口径：**有回调但调用失败 = run 直接失败**（不静默改用本地 Key——那会用 flow 自己的钱
办宿主的请求）；网关侧 60s 缓存 + 单飞（换 Key 最迟一分钟生效）。

### 4.3 计费三段事务（`HOST_BILLING_URL`，可选；缺省回落自带 balance）

```
POST {url}  { "op": "reserve", "runId", "userId", "amount" }          → 冻结
POST {url}  { "op": "settle", "runId", "userId", "frozenAmount",
              "actualCost", "usage": {…}, "remark" }                  → 结算
POST {url}  { "op": "refund", "runId", "userId", "amount" }           → 退款
```

- **幂等键固定为 `flow:<runId>:<op>`**（经 `x-idempotency-key` 头下发）：网关重试、
  宿主重试、进程重启后重跑同一 run 都不得重复扣费，宿主按此键去重；
- `reserve` 余额不足时宿主回非 2xx，run 直接失败（不静默放行）；
- `usage` 是宿主折算自己计费单位的明细（totalTokens / totalSteps / model / engine 等）。

### 4.4 事件透出（`HOST_EVENTS_URL`，可选；缺省仅本地 SSE）

```
POST {url}  { "protocolVersion": "v1", "events": [ { "runId", "seq", "type", "payload", "at" } ] }
```

批量（≤25 条/批，或 250ms 攒批）；`seq` 是 **run 内**单调序号，宿主按 `lastSeq`
断线重放。事件是旁路：外发失败 flow 只记日志并丢弃该批（有界），不拖垮 run。

## 5. 环境变量（网关侧）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `HOST_MODE` | 否（缺省 `standalone`） | `standalone` / `embedded`。写错值启动期直接报错（不静默按独立模式起） |
| `HOST_SHARED_SECRET` | 内嵌必填 | ≥16 位；与宿主的 `KENFUTWORK_FLOW_EMBED_SECRET` 成对 |
| `HOST_IDENTITY_VERIFY_URL` | 内嵌必填 | §4.1；非 https 且非回环时启动期告警 |
| `HOST_CREDENTIALS_URL` | 否 | §4.2；缺省回落本地 `.env` 密钥 |
| `HOST_BILLING_URL` | 否 | §4.3；缺省回落自带 balance |
| `HOST_EVENTS_URL` | 否 | §4.4；缺省仅本地 SSE |
| `HOST_ALLOWED_ORIGINS` | 内嵌强烈建议 | 宿主 origin 白名单（逗号分隔，origin 形式）。为空 = 前端拒绝一切入站消息，握手必失败 |
| `HOST_REQUEST_TIMEOUT_MS` | 否（5000） | 200~60000 |
| `HOST_USER_VIP_LEVEL` | 否 | 宿主开户用户档位；缺省：宿主承担计费→`pro`，否则→`free` |

配置校验是 fail loud 的：内嵌模式缺 `HOST_SHARED_SECRET` / `HOST_IDENTITY_VERIFY_URL`
在**启动期**报错；缺可选回调只告警并在 capabilities 的 `notes` 里写明降级原因。

## 6. 第三方宿主接入指引（最小接入）

1. **起一个 embedded 网关**：上表配置 `HOST_MODE=embedded`、`HOST_SHARED_SECRET`、
   `HOST_IDENTITY_VERIFY_URL`（指向你自己的验签端点）、`HOST_ALLOWED_ORIGINS`
   （你的应用 origin）。凭证 / 计费 / 事件三项可以先不配——flow 会回落自带实现，
   capabilities 里会写明。
2. **实现身份验签端点**（§4.1 的形状）：收到 `{token}` 后验你自己的会话令牌，
   回稳定 `subject`（+可选 displayName / email）。
3. **在你的页面里放 iframe** 指向 flow 前端（如 `/` 或 `/canvas/:id`），并按 §2 时序
   应答 `hello-ack` → `identity`（把你的会话令牌放 `hostToken`）→ 可选 `theme`。
4. **收消息**：监听 `message`，按 `event.origin ∈ 白名单` 与 `type` 前缀 `ff-embed/`
   过滤；`ready` 后可按 `run-event` 的 `seq` 做断线重放，`navigation` 用于刷新你的列表。
5. **（可选）接三个回调缝**：凭证（§4.2，把你的 Dify/BYOK 实例下发）、计费
   （§4.3，`flow:<runId>:<op>` 幂等键去重）、事件（§4.4）。

**最小宿主要求**：一个可承载 iframe 的容器 + 身份令牌注入通道 + 主题令牌。
凭证 / 计费 / 事件三项缺省走 flow 自带实现——宿主只做「最小接入」也能跑。
参考实现（宿主 #1）：KenFutWork 主仓 workbench（`apps/web` 的 flow 模式 +
`apps/server` 的 `/api/flow/host/*`）。

## 7. 降级语义（必须明示，不放无提示空壳）

| 场景 | 行为 |
| --- | --- |
| 网关 `HOST_MODE=standalone` | iframe 里的页面按独立 UI 跑（不握手） |
| 协议版本不匹配 | flow 降级独立模式，页面顶部横幅写明两侧版本 |
| 宿主 origin 不在白名单 / 无法确定 | 同上，横幅写明原因 |
| 身份交换失败（401/网络错） | 同上，横幅写明网关返回的原因 |
| 凭证 / 计费 / 事件回调缺失 | 对应缝回落自带实现；capabilities 的 `notes` 写明 |
| 凭证 / 计费回调**失败**（配置了但调不通） | run 直接失败，不静默降级（见 §4.2/§4.3 口径） |

独立 Provider 是兜底：任一缝缺失或宿主不可信，flow 都降级到独立实现继续跑，
而不是崩溃或半残；降级原因对用户（横幅）与宿主（notes / error 消息）双双可见。
