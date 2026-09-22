# 依赖漏洞审计报告

> 审计时间：2026-09-22 ｜ 范围：生产依赖（`pnpm audit --prod`）
>
> - 基线（升级前）：**29 条**（high 10 / moderate 17 / low 2），无 critical。
> - **当前（升级后）：0 条 —— `No known vulnerabilities found`。**
>
> 处置过程与验证记录见文末「处置结果」。

## 怎么复现

```bash
pnpm audit --prod
pnpm audit --prod --json > audit.json   # 机器可读
```

本机 `pnpm` 曾因 corepack 损坏（`Cannot find module .../corepack/dist/pnpm.js`）完全跑不起来。
本次审计用隔离安装的同一版本完成，不污染仓库：

```bash
npm install --prefix <任意临时目录> pnpm@11.10.0
node <该目录>/node_modules/pnpm/bin/pnpm.cjs audit --prod
```

修好本机 pnpm 之后直接 `pnpm audit --prod` 即可，两者结论一致。

## 汇总（升级前基线）

| 严重级别 | 条数 |
| --- | --- |
| critical | 0 |
| high | 10 |
| moderate | 17 |
| low | 2 |

受影响的顶层包共 12 个：`multer`、`lodash`、`langsmith`、`js-yaml`、`@tiptap/core`、
`file-type`、`@nestjs/core`、`uuid`、`qs`、`react-router`、`react-router-dom`、`body-parser`。

## 明细（按严重级别排序）

| 级别 | 包 | 受影响版本 | 修复版本 | 公告 |
| --- | --- | --- | --- | --- |
| high | multer | <2.1.0 | >=2.1.0 | DoS：清理不完整导致资源耗尽 |
| high | multer | <2.1.1 | >=2.1.1 | DoS：不受控递归 |
| high | multer | >=1.0.0 <2.2.0 | >=2.2.0 | DoS：深层嵌套字段 |
| high | multer | <2.3.0 | >=2.3.0 | DoS：构造 multipart |
| high | multer | <2.3.0 | >=2.3.0 | DoS：超大数组 |
| high | lodash | >=4.0.0 <=4.17.23 | >=4.17.24 | `_.template` 代码注入 |
| high | langsmith | <0.6.0 | >=0.6.0 | 拉取公开 prompt 时反序列化不可信对象 |
| high | js-yaml | >=4.0.0 <4.3.2 | >=4.3.2 | `maxTotalMergeKeys` 未限制 CPU |
| high | @tiptap/core | >=3.7.0 <3.30.5 | >=3.30.5 | Markdown 属性解析的二次 ReDoS |
| moderate | langsmith | >=0.3.41 <0.4.6 | >=0.4.6 | SSRF |
| moderate | langsmith | <=0.5.17 | >=0.5.18 | 原型污染 |
| moderate | langsmith | <=0.5.18 | >=0.5.19 | 流式事件绕过输出脱敏 |
| moderate | file-type | >=13.0.0 <21.3.1 | >=21.3.1 | ASF 解析器死循环 |
| moderate | file-type | >=20.0.0 <=21.3.1 | >=21.3.2 | ZIP 解压炸弹 |
| moderate | lodash | <=4.17.23 | >=4.17.24 | 原型污染 |
| moderate | lodash | >=4.0.0 <=4.17.22 | >=4.17.23 | `_.unset` 原型污染 |
| moderate | @nestjs/core | <=11.1.17 | >=11.1.18 | 输出中特殊元素未正确中和 |
| moderate | uuid | <11.1.1 | >=11.1.1 | v3/v5/v6 缺少缓冲区边界检查 |
| moderate | qs | >=6.11.1 <=6.15.1 | >=6.15.2 | `stringify` 崩溃型 DoS |
| moderate | qs | >=6.14.2 <=6.15.3 | >=6.15.4 | array-limit 绕过 |
| moderate | qs | >=2.2.5 <6.16.0 | >=6.16.0 | `isBuffer` 可控导致 DoS |
| moderate | multer | >=2.0.0-alpha.1 <2.2.0 | >=2.2.0 | DoS：清理不完整 |
| moderate | react-router | >=6.0.0 <7.18.0 | >=7.18.0 | `<Link>` 中的反斜杠开放重定向 |
| moderate | react-router | >=6.4.0 <7.18.0 | >=7.18.0 | 反序列化任意构造函数注入 |
| moderate | react-router-dom | >=6.30.2 <=6.30.5 | >=6.30.6 | 开放重定向导致 XSS |
| moderate | @tiptap/core | >=2.0.0-alpha.0 <3.30.4 | >=3.30.4 | `mergeAttributes()` 原型污染 |
| low | body-parser | <1.20.6 | >=1.20.6 | 非法 limit 导致 DoS |
| low | multer | <2.3.0 | >=2.3.0 | 异步 fileFilter 竞态绕过文件大小限制 |

## 处置结果（2026-09-22 晚）—— 已清零

**当前状态：`pnpm audit --prod` → `No known vulnerabilities found`（29 → 0）。**

分三轮清理，每轮都跑完整验证：

| 轮次 | 动作 | 漏洞数 |
| --- | --- | --- |
| 起点 | 审计基线 | 29（high 10 / moderate 17 / low 2） |
| 第 1 轮 | 9 条同大版本补丁级 `overrides` + `pnpm install` | 11（high 2 / moderate 9） |
| 第 2 轮 | 前端 `react-router` v7 + `@tiptap/core` 3.30.5；后端 NestJS 10 → 11 | 4（high 1 / moderate 3） |
| 第 3 轮 | `langsmith` 0.3.87 → 0.6.3 | **0** |

最终 `pnpm-workspace.yaml`：

```yaml
overrides:
  'body-parser': ^1.20.6
  'qs': ^6.16.0
  'js-yaml': ^4.3.2
  'multer': ^2.4.0
  'lodash': ^4.18.1
  'uuid': ^11.1.1
  'react-router': ^7.18.4
  'react-router-dom': ^7.18.4
  '@tiptap/core': ^3.30.5
  'langsmith': ^0.6.0
```

直接依赖也升了：`frontend` 的 `react-router-dom` 提到 `^7.18.4`；`gateway` 的
`@nestjs/*` 全系升到 11（`@nestjs/config` 4、`@nestjs/typeorm` 11、
`@nestjs/cli` 11、`@types/express` 5）。

注意：**pnpm 11 起 `overrides` 只认 `pnpm-workspace.yaml`**，写在 `package.json` 的
`pnpm.overrides` 会被直接忽略（启动时会打 WARN）。

### 关键取舍与验证

- **`multer` / `file-type` / `@nestjs/core`**：三条 moderate 都要求
  `@nestjs/platform-express` ≥ 11（它带 `multer@2.2.0` + `express@5`），
  所以走 NestJS 大版本升级一次解决，而不是逐个 override。
- **`langsmith` 越界覆盖**：`@langchain/core@0.3.80` 声明的是 `^0.3.67`，
  而修复版本最低 `0.6.0`，区间内无解；`@langchain/core` 1.x 又会带上
  `@flowgram.ai/runtime-js` 的连锁大版本。因此显式越界覆盖到 `0.6.3`，
  并做了针对性验证（不是靠"应该没事"）：
  - `@langchain/core` 只从 langsmith 引 `Client` / `RunTree` / `getDefaultProjectName`
    三个符号 —— 在 0.6.3 里**都存在且可实例化**（ESM 与 CJS 入口都验过）；
  - 0.6.3 确实移除了 `traceable` / `getCurrentRunTree` 导出，但
    `@langchain/core@0.3.80` **没有引用这两个符号**；
  - 真实链路探针：按 `runtime-js` 的解析图 `new ChatOpenAI()` +
    `SystemMessage/HumanMessage` + `.invoke()`（fetch 打桩）返回正确；
  - 打开 tracing 后 `LangChainTracer` 能构造、链路能跑、能向 langsmith 端点发请求；
  - 前端 `tsc --noEmit` + `rsbuild build` 通过。
- **`react-router` v7**：前端只用到 `RouterProvider/Routes/Route/BrowserRouter/Link/
  useNavigate/useParams/useSearchParams/useLocation/Outlet/Navigate`，全部在 v7 保留，
  未使用 `unstable_*`；`tsc` 与生产构建均通过。
- **`uuid@11`**：网关只用 `v4`，`11.1.1` 保留 CJS 入口（`exports['.']` →
  `./dist/cjs/index.js`），tsc 编成 CommonJS 后正常 `require`。

### 验证记录（2026-09-22）

| 检查 | 结果 |
| --- | --- |
| `pnpm install` | 3 轮全部成功 |
| `pnpm audit --prod` | **No known vulnerabilities found** |
| `gateway` `tsc --noEmit` | 通过 |
| `frontend` `tsc --noEmit` | 通过 |
| `frontend` `rsbuild build`（production） | 通过 |
| `gateway` smoke 套件 | **37/37 通过**（含新增 `global-auth-guard-smoke`） |

### 端到端回归（已跑）

Dify 全栈起起来后跑了完整 `e2e-all`，三组全绿 —— 这是 Express 5 与
`react-router` v7 升级最需要的真实流量验证：

| 分组 | 结果 | 覆盖 |
| --- | --- | --- |
| local | 10/10 | 纯前端节点运行时契约（条件/退出/HTTP/批处理/聚合/循环/LLM 票据） |
| api | 7/7 | 真实 LLM 执行：知识库、文件、MCP、版本管理、批量任务、草稿试运行、富节点全链路 |
| gui | 7/7 | 真实浏览器：点击模拟、全流程建图→试运行→保存、按钮枚举、循环体操作、Python 节点执行、触发器失败展示 |

合计 **24/24**。`react-router` v7 与 `@tiptap/core` 3.30.5 没有破坏任何前端交互，
NestJS 11 / Express 5 没有破坏任何路由或请求解析。

### 顺带修掉一个既有 bug（与本轮升级无关）

首次跑 `api` 分组时 `new-modules-api` 挂了：MCP 注册返回 401「无效或过期的 Token」。

排查结论：**不是本轮改动引入的**——临时摘掉全局守卫后 MCP 仍 401（同时 `/plugins`
变 200，反证全局守卫本身工作正常）。加诊断日志坐实根因：

```
[JWT-DIAG] {"msg":"secret or public key must be provided","hasSecret":false,"optionsKeys":[]}
```

`mcp.module.ts` 裸导入了 `JwtModule`（没有 `.register()`）。裸模块只声明
`providers: [JwtService]`，会在 McpModule 自己的注入器里造出**第二个 JwtService**，
而 `JwtModule.registerAsync()` 只提供 `JWT_MODULE_OPTIONS`、不导出它，所以这个实例
拿不到配置（`options` 为空对象）→ `verify()` 恒抛。受影响的不止注册接口：
`McpExecutionGuard` 也注入同一个 `JwtService`，所以 **`/mcp/proxy` 同样是坏的**，
即工作流里的 MCP 节点整条链路都不可用。

修法：从 `mcp.module.ts` 的 `imports` 里移除裸 `JwtModule`，改用
`app.module.ts` 里 `JwtModule.registerAsync({ global: true })` 已全局导出的那个。
全仓库排查过，只有这一处是裸导入。
