import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 鉴权覆盖清单（结构性回归）。
 *
 * 背景：全项目**没有**全局守卫（无 `useGlobalGuards` / `APP_GUARD`），也没有
 * Throttler —— 于是「控制器是否要鉴权」完全靠人记得挂 `@UseGuards`。真实事故就是
 * 这么来的：`LlmProxyController` 曾整类没有守卫，任何人只要能连到网关端口就能
 * 消耗平台级 `LLM_API_KEY`；`PythonExecController` 也只有 JwtAuthGuard，等价于
 * 任何登录账号可在宿主执行代码。
 *
 * 这个测试不启动应用，只做源码级清点：**每个控制器、每条路由都必须能被归类为
 * 「已挂守卫」「由 AuthMiddleware 覆盖」或「显式公开（附理由）」**。将来新增一个
 * 裸控制器，或往公开型控制器里加一条没守卫的路由，这里就会红。
 *
 * 为什么用清单而不是直接加全局守卫：执行入口 `POST /workflows/:id/execute` 同时
 * 支持 JWT 与平台 API Key（见 AuthMiddleware），媒体回调走限定用途令牌，登录/注册
 * 必须匿名——一刀切的全局守卫会直接打断这些既有语义，属于更大的改造。
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
 * 「自带守卫」或「登记公开理由」。这里只是解释「为什么没有类级守卫」。
 */
const CLASS_LEVEL_EXEMPT: Record<string, string> = {
  'health/health.controller.ts': '存活探针 /healthz：整类公开，只回进程状态，不带任何业务数据',
  'triggers/webhook.controller.ts': '整类公开：/webhooks/:secret 用 URL 中的高熵密钥作为凭据（库中只存哈希 + 按触发器限流）',
  'auth/auth.controller.ts': '登录/注册必须匿名可用；其余路由逐条挂 JwtAuthGuard（见下方路由级清单）',
  'mcp/mcp.controller.ts': '逐条挂守卫：管理类路由用 JwtAuthGuard，容器回调路由用 McpExecutionGuard（限定用途令牌）',
  'workflows/workflows.controller.ts': '执行入口由 AuthMiddleware 覆盖（JWT 或平台 API Key）；health 为公开探针',
  'llm/llm-proxy.controller.ts': 'ticket 端点挂 JwtAuthGuard；chat/completions 在处理器内校验 Bearer 票据',
};

/** 单条公开路由：方法名 → 理由。key 必须是该文件里真实存在的方法。 */
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
  'health/health.controller.ts': {
    readiness: '存活/就绪探针，公开：只回进程与数据库状态；detailed 仅探测 Dify 可达性，不含业务数据',
  },
  'triggers/webhook.controller.ts': {
    invoke: '公开触发器入口：URL 中的高熵密钥即凭据（库中只存哈希 + 每触发器 60 次/分钟限流）',
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
}

interface ControllerInfo {
  file: string;
  className: string;
  classGuarded: boolean;
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

/** 源码级清点：控制器级守卫 + 每条路由是否自带守卫。 */
function analyzeController(file: string, source: string): ControllerInfo[] {
  const lines = source.split(/\r?\n/);
  const found: ControllerInfo[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const controllerMatch = /^@Controller\('?([^')]*)'?\)/.exec(lines[index]);
    if (!controllerMatch) continue;

    const controllerPath = controllerMatch[1];
    let classGuarded = false;
    // 装饰器顺序不定：@UseGuards 可能写在 @Controller 之前（PythonExecController
    // 就是这种写法），所以上下都要看。
    for (let up = index - 1; up >= 0 && /^\s*(@\w|\/\/|\*|\/\*)/.test(lines[up]); up -= 1) {
      if (/@UseGuards\(/.test(lines[up])) classGuarded = true;
    }
    let className = '';
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (/@UseGuards\(/.test(lines[cursor])) classGuarded = true;
      const classMatch = /^export class (\w+)/.exec(lines[cursor]);
      if (classMatch) {
        className = classMatch[1];
        break;
      }
    }
    assert.ok(className, `${file}: @Controller 之后应能找到 export class`);

    // 路由 = 缩进 2 格的 HTTP 方法装饰器；紧随其后的同级装饰器块内允许出现
    // @UseGuards / @HttpCode 等。
    const routes: RouteInfo[] = [];
    for (let line = cursor; line < lines.length; line += 1) {
      const routeMatch = /^ {2}@(Get|Post|Put|Patch|Delete|All|Head|Options)\((?:'([^']*)')?/.exec(lines[line]);
      if (!routeMatch) continue;

      // 守卫可能写在路由装饰器之前（auth.controller 的 profile/password 就是这种
      // 写法），所以同级装饰器块上下都要看。
      let guarded = /@UseGuards\(/.test(lines[line]);
      for (let up = line - 1; up >= 0 && /^ {2}(?:@|\/\/)/.test(lines[up]); up -= 1) {
        if (/@UseGuards\(/.test(lines[up])) guarded = true;
      }
      let blockEnd = line;
      for (let next = line + 1; next < lines.length && /^ {2}@/.test(lines[next]); next += 1) {
        if (/@UseGuards\(/.test(lines[next])) guarded = true;
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
      });
    }

    found.push({ file, className, classGuarded, routes });
  }

  return found;
}

function main() {
  const files = collectControllerFiles(SRC_ROOT);
  const controllers = files.flatMap((file) => (
    analyzeController(sourceKey(file), readFileSync(file, 'utf8'))
  ));

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

  // ── 1. 每个控制器要么有类级守卫，要么说明了为什么没有 ──────────────────
  for (const controller of controllers) {
    if (controller.classGuarded) continue;
    assert.ok(
      CLASS_LEVEL_EXEMPT[controller.file],
      `${controller.file}（${controller.className}）既没有类级 @UseGuards，也不在 CLASS_LEVEL_EXEMPT 清单里。`
      + '请挂上类级守卫；若每条路由各有保护方式，请登记到本测试的清单并写清楚。',
    );
  }

  // ── 2. 每条路由都必须有守卫或显式登记（类级豁免不等于路由豁免）────────
  const seen = new Set<string>();
  for (const controller of controllers) {
    for (const route of controller.routes) {
      const key = `${controller.file}::${route.method}`;
      assert.equal(seen.has(key), false, `${key} 方法名在文件内重复，路由清单无法定位`);
      seen.add(key);
      if (controller.classGuarded || route.guarded) continue;

      const reason = PUBLIC_ROUTES[controller.file]?.[route.method];
      assert.ok(
        reason,
        `${route.httpMethod} /${route.path}（${controller.file} 的 ${route.method}）没有任何守卫。`
        + '请挂 @UseGuards，或在本测试的 PUBLIC_ROUTES 里登记并写明理由。',
      );
    }
  }

  // ── 3. 清单不许腐烂：登记项必须仍然存在 ──────────────────────────────
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
      assert.ok(
        controller!.routes.some((route) => route.method === method),
        `${file} 里的 ${method} 已不存在：公开理由「${reason}」应一并删除`,
      );
    }
  }

  // ── 4. 声称「由 AuthMiddleware 覆盖」的路由，中间件必须还在 ────────────
  const authModule = readFileSync(join(SRC_ROOT, 'auth', 'auth.module.ts'), 'utf8');
  assert.match(authModule, /consumer\.apply\(AuthMiddleware\)/, 'AuthMiddleware 的注册被删了');
  for (const path of MIDDLEWARE_PROTECTED) {
    assert.ok(
      authModule.includes(`'${path}'`),
      `AuthMiddleware 不再覆盖 ${path} —— 该路由会变成无鉴权入口`,
    );
  }

  const routeCount = controllers.reduce((total, item) => total + item.routes.length, 0);
  console.log(
    `鉴权覆盖检查通过: ${controllers.length} 个控制器 / ${routeCount} 条路由；`
    + `${Object.keys(CLASS_LEVEL_EXEMPT).length} 个无类级守卫的控制器均已说明保护方式，`
    + `${Object.values(PUBLIC_ROUTES).reduce((n, item) => n + Object.keys(item).length, 0)} 条公开路由均有理由；`
    + 'AuthMiddleware 覆盖的 3 条执行入口仍在位',
  );
}

main();
