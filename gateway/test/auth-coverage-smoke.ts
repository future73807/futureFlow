import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 鉴权覆盖清单（结构性回归）。
 *
 * 背景：历史上出现过两次真实事故 —— `LlmProxyController` 整类没有守卫（任何人只
 * 要能连到网关端口就能消耗平台级 `LLM_API_KEY`）、`PythonExecController` 只挂了
 * JwtAuthGuard（等价于任何登录账号都能在宿主执行代码）。根因都是「控制器要不要
 * 鉴权」纯靠人记得写 `@UseGuards`。
 *
 * 现在 `app.module.ts` 注册了全局守卫 `GlobalAuthGuard`（`APP_GUARD`），语义是
 * **默认要鉴权**：
 *   1. 带 `@Public()` —— 放行；
 *   2. 处理器或控制器自带 `@UseGuards(...)` —— 放行，交给那个专门的守卫去判
 *      （MCP 回调的限定用途令牌、媒体执行令牌等各有各的凭据，不能一刀切用 JWT）；
 *   3. 其余 —— 一律走 JwtAuthGuard，没凭据就 401。
 *
 * 于是新增一个裸控制器不再等于裸奔。但 `@Public()` 是「主动开洞」，一旦乱标就
 * 等于把旧的裸奔风险换了个形式搬回来。这个测试不启动应用，只做源码级清点，负责
 * 双向对齐：
 *   - 既没守卫又没标 `@Public()` 的路由 → 红（全局守卫会 401，属于漏标）；
 *   - 标了 `@Public()` 却没在 `PUBLIC_ROUTES` 登记理由的路由 → 红（开洞不留据）；
 *   - 在 `PUBLIC_ROUTES` 登记了却没标 `@Public()` 的 → 红（清单腐烂，实际是 401）。
 */

const SRC_ROOT = join(__dirname, '..', 'src');

/** 由 AuthMiddleware 覆盖的路由（见 auth.module.ts 的 configure）。 */
const MIDDLEWARE_PROTECTED = [
  'workflows/run',
  'workflows/:id/execute',
  'workflows/:id/draft-run',
];

/**
 * 无类级守卫的控制器清单：说明它为什么可以没有，以及各路由靠什么保护。
 * key 是相对 `gateway/src` 的路径（清单要精确到文件，避免同名文件互相顶替）。
 *
 * 注意：放进这里**不等于**整个控制器公开——第 2 项检查仍会逐条要求每条路由
 * 「自带守卫」或「显式 `@Public()` 且登记理由」。这里只是解释「为什么没有类级
 * 守卫」（全局守卫会兜住没标 `@Public()` 的那些）。
 */
const CLASS_LEVEL_EXEMPT: Record<string, string> = {
  'health/health.controller.ts': '存活/就绪探针 GET /healthz：显式 @Public()，只回进程与数据库状态，不带业务数据',
  'triggers/webhook.controller.ts': '触发器入口显式 @Public()：凭据是高熵密钥（推荐 X-Webhook-Secret 头，旧的路径传参仍兼容），库中只存哈希 + 按触发器限流',
  'auth/auth.controller.ts': '登录/注册必须匿名可用（显式 @Public()）；其余路由逐条挂 JwtAuthGuard（见下方路由级清单）',
  'mcp/mcp.controller.ts': '逐条挂守卫：管理类路由用 JwtAuthGuard，容器回调路由用 McpExecutionGuard（限定用途令牌）',
  'workflows/workflows.controller.ts': '执行入口由 AuthMiddleware 覆盖（JWT 或平台 API Key 两种身份），故标 @Public() 交给中间件；health 为公开探针',
  'llm/llm-proxy.controller.ts': 'ticket 端点挂 JwtAuthGuard；chat/completions 标 @Public() 后在处理器内校验 Bearer 票据',
  'host/host.controller.ts': 'ff-embed/v1 握手：两条路由都显式 @Public() 并逐条登记理由（capabilities 只回协议/能力/允许来源；session 验的是宿主令牌，由共享密钥回调宿主服务端验签）',
};

/**
 * 显式标了 `@Public()` 的路由：方法名 → 理由。key 必须是该文件里真实存在的方法。
 * 这张表是「开洞台账」：标了必须登记，登记了必须真标（见第 2、3 项断言）。
 */
const PUBLIC_ROUTES: Record<string, Record<string, string>> = {
  'auth/auth.controller.ts': {
    register: '自助注册入口，必须匿名可调用（按来源限流 20 次/小时）',
    login: '登录入口，必须匿名可调用（按 IP + 账号限流并锁定）',
  },
  'workflows/workflows.controller.ts': {
    health: '网关健康检查，公开探针',
    runWorkflow: '已停用：直接抛 400，不做任何执行',
    executePublishedWorkflow: '由 AuthMiddleware 覆盖：支持 JWT 与平台 API Key 两种身份',
    draftRun: '由 AuthMiddleware 覆盖：支持 JWT 与平台 API Key 两种身份',
  },
  'host/host.controller.ts': {
    capabilities: '内嵌握手第一步：前端此时还没有 flow 凭据，需要先知道协议版本 / 能力归属 / 允许的宿主 origin；只回这些与降级原因，不含密钥与用户数据',
    exchange: '内嵌模式的登录入口：出示的是**宿主令牌**而非 flow 令牌，由共享密钥 + 回调宿主服务端验签后按 sub get-or-create，因此不能要求 flow 的 JWT',
  },
  'health/health.controller.ts': {
    readiness: 'GET /healthz 存活/就绪探针，公开：只回进程与数据库状态；detailed 仅探测 Dify 可达性，不含业务数据',
  },
  'triggers/webhook.controller.ts': {
    invoke: '公开触发器入口：高熵密钥即凭据（推荐 X-Webhook-Secret 头），库中只存哈希 + 每触发器 60 次/分钟限流',
  },
  'llm/llm-proxy.controller.ts': {
    chatCompletions: '处理器内校验 Bearer 票据（只能调 LLM，且按用户限流 + 单次成本上限）',
  },
};

interface RouteInfo {
  httpMethod: string;
  path: string;
  method: string;
  line: number;
  guarded: boolean;
  /** 是否带 `@Public()`（全局守卫据此放行）。 */
  public: boolean;
}

interface ControllerInfo {
  file: string;
  className: string;
  classGuarded: boolean;
  classPublic: boolean;
  routes: RouteInfo[];
}

/** 清单里的键统一用正斜杠，避免 Windows 上 `auth\auth.controller.ts` 对不上。 */
const sourceKey = (file: string): string => relative(SRC_ROOT, file).split(sep).join('/');

function collectControllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return collectControllerFiles(join(dir, entry.name));
    return entry.name.endsWith('.controller.ts') ? [join(dir, entry.name)] : [];
  });
}

/** 源码级清点：控制器级守卫 + 每条路由的守卫 / `@Public()` 标记。 */
function analyzeController(file: string, source: string): ControllerInfo[] {
  const lines = source.split(/\r?\n/);
  const found: ControllerInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const controllerMatch = /^@Controller\('?([^')]*)'?\)/.exec(lines[index]);
    if (!controllerMatch) continue;

    const controllerPath = controllerMatch[1];
    let classGuarded = false;
    let classPublic = false;
    // 装饰器顺序不定：@UseGuards / @Public 可能写在 @Controller 之前
    // （PythonExecController 的 @UseGuards 就是这种写法），所以上下都要看。
    for (let up = index - 1; up >= 0 && /^\s*(@\w|\/\/|\*|\/\*)/.test(lines[up]); up -= 1) {
      if (/@UseGuards\(/.test(lines[up])) classGuarded = true;
      if (/@Public\(\)/.test(lines[up])) classPublic = true;
    }
    let className = '';
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (/@UseGuards\(/.test(lines[cursor])) classGuarded = true;
      if (/@Public\(\)/.test(lines[cursor])) classPublic = true;
      const classMatch = /^export class (\w+)/.exec(lines[cursor]);
      if (classMatch) {
        className = classMatch[1];
        break;
      }
    }
    assert.ok(className, `${file}: @Controller 之后应能找到 export class`);

    // 路由 = 缩进 2 格的 HTTP 方法装饰器；紧随其后的同级装饰器块内允许出现
    // @UseGuards / @Public / @HttpCode 等。
    const routes: RouteInfo[] = [];
    for (let line = cursor; line < lines.length; line += 1) {
      const routeMatch = /^ {2}@(Get|Post|Put|Patch|Delete|All|Head|Options)\((?:'([^']*)')?/.exec(lines[line]);
      if (!routeMatch) continue;

      // 守卫/公开标记可能写在路由装饰器之前（auth.controller 的 profile 就是这种
      // 写法），所以同级装饰器块上下都要看。
      let guarded = /@UseGuards\(/.test(lines[line]);
      let isPublic = /@Public\(\)/.test(lines[line]);
      for (let up = line - 1; up >= 0 && /^ {2}(?:@|\/\/)/.test(lines[up]); up -= 1) {
        if (/@UseGuards\(/.test(lines[up])) guarded = true;
        if (/@Public\(\)/.test(lines[up])) isPublic = true;
      }
      let blockEnd = line;
      for (let next = line + 1; next < lines.length && /^ {2}@/.test(lines[next]); next += 1) {
        if (/@UseGuards\(/.test(lines[next])) guarded = true;
        if (/@Public\(\)/.test(lines[next])) isPublic = true;
        blockEnd = next;
      }

      let method = '';
      for (let next = blockEnd + 1; next < lines.length; next += 1) {
        const methodMatch = /^ {2}(?:public |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\(/.exec(lines[next]);
        if (methodMatch) {
          method = methodMatch[1];
          break;
        }
      }
      assert.ok(method, `${file}:${line + 1} 路由装饰器后应能找到方法名`);

      routes.push({
        httpMethod: routeMatch[1].toUpperCase(),
        path: [controllerPath, routeMatch[2] || ''].filter(Boolean).join('/'),
        method,
        line: line + 1,
        guarded,
        public: isPublic,
      });
    }

    found.push({ file, className, classGuarded, classPublic, routes });
  }

  return found;
}

function main() {
  const files = collectControllerFiles(SRC_ROOT);
  const controllers = files.flatMap((file) => (
    analyzeController(sourceKey(file), readFileSync(file, 'utf8'))
  ));

  // ── 0. 全局守卫必须还在：它是「忘了挂守卫 = 401」的地基 ────────────────
  const appModule = readFileSync(join(SRC_ROOT, 'app.module.ts'), 'utf8');
  assert.match(
    appModule,
    /\{\s*provide:\s*APP_GUARD\s*,\s*useClass:\s*GlobalAuthGuard\s*\}/,
    'app.module.ts 里找不到 APP_GUARD -> GlobalAuthGuard 的注册：默认鉴权被摘掉了',
  );

  // 先确认清点本身没坏：解析器一旦失灵会让后面所有断言空过。
  assert.ok(files.length >= 15, `应收集到全部控制器文件，实际 ${files.length}`);
  assert.ok(
    controllers.some((item) => item.className === 'PythonExecController' && item.classGuarded),
    '应能识别出 PythonExecController 及其类级守卫',
  );
  assert.ok(
    controllers.some((item) => item.routes.some(
      (route) => route.path === 'python/exec' && route.method === 'exec',
    )),
    '应能解析出 POST /python/exec 路由',
  );
  assert.ok(
    controllers.some((item) => item.routes.some((route) => route.public)),
    '应能识别出至少一条带 @Public() 的路由（解析器若认不出标记，本测试会失去意义）',
  );

  // ── 1. 每个控制器要么有类级守卫，要么说明了为什么没有 ──────────────────
  for (const controller of controllers) {
    if (controller.classGuarded) continue;
    assert.ok(
      CLASS_LEVEL_EXEMPT[controller.file],
      `${controller.file}（${controller.className}）既没有类级 @UseGuards，也不在 CLASS_LEVEL_EXEMPT 清单里。`
      + '请挂上类级守卫；若每条路由各有保护方式，请登记到本测试的清单并写清楚。',
    );
  }

  // ── 2. 每条路由：自带守卫，或显式 @Public() 且登记理由 ──────────────────
  const seen = new Set<string>();
  for (const controller of controllers) {
    for (const route of controller.routes) {
      const key = `${controller.file}::${route.method}`;
      assert.equal(seen.has(key), false, `${key} 方法名在文件内重复，路由清单无法定位`);
      seen.add(key);

      const ownGuard = controller.classGuarded || route.guarded;
      const isPublic = controller.classPublic || route.public;
      const reason = PUBLIC_ROUTES[controller.file]?.[route.method];

      if (!ownGuard && !isPublic) {
        assert.fail(
          `${route.httpMethod} /${route.path}（${controller.file} 的 ${route.method}）既没有守卫`
          + '也没标 @Public()：全局守卫会对它返回 401。请挂 @UseGuards，或在需要匿名访问时'
          + '加 @Public() 并在 PUBLIC_ROUTES 里登记理由。',
        );
      }
      // 自带守卫还标 @Public() —— 全局守卫会直接放行，标记是误导性的死代码。
      assert.ok(
        !(ownGuard && isPublic),
        `${route.httpMethod} /${route.path}（${controller.file} 的 ${route.method}）同时带了守卫和`
        + ' @Public()：全局守卫见到 @Public() 就放行，这个标记只会误导后来人。请删掉多余的那个。',
      );
      if (isPublic) {
        assert.ok(
          reason,
          `${route.httpMethod} /${route.path}（${controller.file} 的 ${route.method}）标了 @Public() `
          + '却没有理由：开洞必须留据，请在 PUBLIC_ROUTES 里登记它为什么可以匿名访问。',
        );
      }
    }
  }

  // ── 3. 清单不许腐烂：登记项必须仍然存在，且真的标了 @Public() ────────────
  const byFile = new Map(controllers.map((item) => [item.file, item]));
  for (const [file, reason] of Object.entries(CLASS_LEVEL_EXEMPT)) {
    assert.ok(
      files.some((candidate) => sourceKey(candidate) === file),
      `${file} 已不存在：理由「${reason}」应一并删除`,
    );
  }
  for (const [file, routes] of Object.entries(PUBLIC_ROUTES)) {
    const controller = byFile.get(file);
    assert.ok(controller, `${file} 已不存在：其公开路由清单应一并删除`);
    assert.ok(
      CLASS_LEVEL_EXEMPT[file],
      `${file} 已挂上类级守卫，其路由级公开清单应删除（否则清单与实际不符）`,
    );
    for (const [method, reason] of Object.entries(routes)) {
      const route = controller!.routes.find((item) => item.method === method);
      assert.ok(
        route,
        `${file} 里的 ${method} 已不存在：公开理由「${reason}」应一并删除`,
      );
      assert.ok(
        route!.public || controller!.classPublic,
        `${file} 的 ${method} 登记在 PUBLIC_ROUTES 里，但源码上并没有 @Public()：`
        + '全局守卫会把它拦成 401。要么补标记，要么删掉这条登记。',
      );
    }
  }

  // ── 4. 声称「由 AuthMiddleware 覆盖」的路由，中间件必须还在 ────────────
  const authModule = readFileSync(join(SRC_ROOT, 'auth', 'auth.module.ts'), 'utf8');
  assert.match(authModule, /consumer\.apply\(AuthMiddleware\)/, 'AuthMiddleware 的注册被删了');
  for (const path of MIDDLEWARE_PROTECTED) {
    assert.ok(
      authModule.includes(`'${path}'`),
      `AuthMiddleware 不再覆盖 ${path} —— 该路由会被全局守卫按「未认证」统一 401，`
      + '平台 API Key 这一类凭据将失效',
    );
  }

  const routeCount = controllers.reduce((total, item) => total + item.routes.length, 0);
  const publicRouteCount = Object.values(PUBLIC_ROUTES)
    .reduce((n, item) => n + Object.keys(item).length, 0);
  console.log(
    `鉴权覆盖检查通过: ${controllers.length} 个控制器 / ${routeCount} 条路由；`
    + `${Object.keys(CLASS_LEVEL_EXEMPT).length} 个无类级守卫的控制器均已说明保护方式，`
    + `${publicRouteCount} 条 @Public() 路由均有理由且标记与清单双向对齐；`
    + '全局守卫 APP_GUARD -> GlobalAuthGuard 在位，AuthMiddleware 覆盖的 3 条执行入口仍在位',
  );
}

main();
