import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FixedWindowRateLimiter, resolveRateLimit } from '../common/fixed-window-rate-limit';
import { Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

interface PythonExecPayload {
  code?: string;
  params?: unknown;
}

const MAX_CODE_LENGTH = 50_000;
const EXEC_TIMEOUT_MS = 15_000;
const RESULT_MARKER = '__FF_RESULT__';

/**
 * 随仓库携带的 Python 依赖目录（纯 Python 包，清单与更新方式见 gateway/vendor/README.md）。
 *
 * 本地试运行执行的是**宿主机**的 Python，把依赖装进 Dify Sandbox 镜像对本链路无效。
 * 这里注入 PYTHONPATH，让用户无需 pip install 即可使用常见库（如连接数据库的
 * pg8000），同时不污染用户自己的 Python 环境。
 *
 * 路径说明：运行时 __dirname 是 dist/localtools，经 ts-node 跑测试时是
 * src/localtools，上溯两级都落在 gateway/，因此同一个相对路径两边都成立。
 */
const VENDORED_MODULES_DIR = join(__dirname, '..', '..', 'vendor', 'python');

/**
 * 组装 PYTHONPATH（纯函数，只看入参，便于测试）。
 *
 * 顺序即导入优先级：用户额外目录 ＞ 随仓库携带的目录 ＞ 原有 PYTHONPATH。
 * 目录不存在时跳过；全部为空返回 undefined（而不是空串——空串会作为有效值写进
 * 子进程环境，反而可能影响 Python 的默认搜索路径）。
 *
 * 之所以拆成纯函数 + {@link buildPythonPathFromEnv} 两层：默认参数无法区分
 * 「未提供」与「显式传 undefined」，导致「没有原有 PYTHONPATH」这种情形无法表达、
 * 也无法稳定测试。这里用 null 明确表示「无」。
 */
export function buildPythonPath(
  extra: string | null,
  vendored: string | null,
  existing: string | null,
): string | undefined {
  const parts = [
    ...(extra ? extra.split(delimiter) : []),
    ...(vendored && existsSync(vendored) ? [vendored] : []),
    ...(existing ? existing.split(delimiter) : []),
  ].filter(Boolean);
  return parts.length ? parts.join(delimiter) : undefined;
}

/** 生产入口：读取环境变量与携带目录后交给 {@link buildPythonPath}。 */
export function buildPythonPathFromEnv(): string | undefined {
  return buildPythonPath(
    process.env.PYTHON_EXTRA_MODULES_PATH ?? null,
    VENDORED_MODULES_DIR,
    process.env.PYTHONPATH ?? null,
  );
}

// ─────────────────────────────────────────────────────────────
// 子进程环境变量白名单
// ─────────────────────────────────────────────────────────────
//
// 用户代码在本机 Python 里执行，而网关进程的 process.env 里装着整套服务
// 凭据（POSTGRES_PASSWORD、GATEWAY_JWT_SECRET、LLM_API_KEY、Dify 与媒体
// 的加密密钥……）。若原样继承，任何能登录的账号都能用一行
// `os.environ` 把它们读走——这不是「理论上」，容器化部署里这些值本来
// 就是真正的环境变量。
//
// 因此这里改成显式白名单：只放运行 Python 真正需要的键。
//
// 有意**不放行** HTTP_PROXY/HTTPS_PROXY/NO_PROXY：代理地址常写成
// http://user:pass@host 的形式，放行等于把凭据又送回子进程。需要的场景
// 请改用 PYTHON_EXTRA_CA 之类不含凭据的配置。

/** POSIX 下 Python 运行所需的最小环境。 */
const POSIX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'TERM',
];

/**
 * Windows 下还需要一组系统变量：缺少 SystemRoot / COMSPEC 时 CPython 可能
 * 起不来或加载 DLL 失败，TEMP/TMP 是 tempfile 的前提。
 */
const WINDOWS_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_LEVEL',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

/**
 * 组装子进程环境（纯函数，只看入参，便于测试）。
 *
 * 只保留白名单内的键，并锁定 Python 的 UTF-8 输出编码——白名单剥离了
 * LANG/LC_ALL 之后，Windows 上 Python 会退回系统代码页，结果里的中文
 * 会让网关这侧的 JSON 解析失败或产生乱码。
 */
export function buildPythonExecEnv(
  pythonPath: string | undefined,
  processEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowlist = platform === 'win32' ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const value = processEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  if (pythonPath) env.PYTHONPATH = pythonPath;
  return env;
}

/**
 * 结束整棵进程树（而不只是直接子进程）。
 *
 * `child.kill()` 只杀直接子进程：用户代码里 `subprocess.Popen(...)` 出来的孙进程
 * 会活下来，而且不是理论问题——实测父进程退出后，孙进程 20 秒后照样写入了文件。
 * 那样一来「15 秒超时强杀」就成了空话：任何登录用户都能在网关宿主上留下常驻进程。
 *
 * - POSIX：spawn 时带 detached，子进程自成进程组，负 pid 表示整组。整组在父进程
 *   退出后依然存在，所以**正常结束**的路径也能收掉后代。
 * - Windows：Node 没有进程组等价物，用 `taskkill /T` 递归结束子进程树。
 *
 * ⚠️ Windows 上的**已知缺口**：`taskkill /T` 只能顺着「活着的」父进程找后代。脚本
 * 正常跑完时父进程已经退出，此时再杀就只是对着一个死 pid 空转，它派生的后台进程
 * 会留下来（实测确认）。要堵住这个缺口需要 Job Object，纯 Node 做不到。
 *
 * 因此这里的保证是：**超时**路径一定会连同后代一起结束（父进程此时还活着）；
 * 正常结束路径在 POSIX 上也能收干净，在 Windows 上收不干净。加上主动脱离的后代
 * （DETACHED_PROCESS / start_new_session）本来就杀不掉——所以端点默认只在回环
 * 监听时开放（见 ensureExecAllowed），不要把它当沙箱用。
 */
export function killProcessTree(
  child: ChildProcess | null,
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => undefined);
      return;
    }
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程已退出：属正常路径，无需处理
  }
}

const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  '::ffff:127.0.0.1',
]);

/** 判断网关是否只监听本机（纯函数）。 */
export function isLoopbackHost(host?: string | null): boolean {
  const value = (host ?? '').trim().toLowerCase();
  if (!value) return false;
  if (LOOPBACK_HOSTS.has(value)) return true;
  // 整个 127.0.0.0/8 都是回环，而不只是 127.0.0.1
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * 决定本机 Python 执行是否可用（纯函数）。
 *
 * 默认值跟随网关监听地址：只监听回环时开（对应「本机开发试运行」这一设计
 * 前提），一旦对外监听（0.0.0.0 或具体内网地址）就默认关闭——此时任何能
 * 登录的人都能在网关宿主上执行任意代码，不再是单机场景。
 * 显式设置 PYTHON_EXEC_ENABLED 时以显式值为准，便于部署方自行裁决。
 */
export function resolvePythonExecEnabled(options: {
  explicit?: string | null;
  host?: string | null;
}): boolean {
  const explicit = (options.explicit ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  return isLoopbackHost(options.host);
}

/**
 * 本机 Python 的运行器脚本。
 *
 * 契约：用户代码必须定义 `def main(params)`，**params 就是本次运行的工作流输入
 * 本身**（前端把开始节点声明的字段展开成 {{引用}} 模板后放进 payload.params）。
 * 不要写成 `main({'params': params})` —— 那会多包一层，导致官方默认模板里的
 * `params.get("query")` 永远取到空值且不报错（历史缺陷，已由本文件与
 * frontend/src/nodes/python/runtime.ts 一起修正）。
 *
 * 导出是为了让 scripts/test-python-runtime.cjs 能直接拿真实脚本做回归。
 */
export const RUNNER_SOURCE = `import json, sys

params = {}
if len(sys.argv) > 1:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        params = json.load(f)

with open(sys.argv[2], 'r', encoding='utf-8') as f:
    source = f.read()

code = compile(source, 'main.py', 'exec')
scope = {'__name__': '__main__'}
exec(code, scope)

main = scope.get('main')
if not callable(main):
    print(json.dumps({'error': 'Python 脚本必须定义 main 函数'}, ensure_ascii=False))
    raise SystemExit(2)

try:
    result = main(params)
except Exception as exc:
    print(json.dumps({'error': f'{type(exc).__name__}: {exc}'}, ensure_ascii=False))
    raise SystemExit(3)

print('__FF_RESULT__' + json.dumps(result, ensure_ascii=False, default=str))
`;

/**
 * 本地 Python 执行代理（「Python 执行」节点专用）
 *
 * 浏览器试运行时没有 Python 运行时，由网关调用本机 Python 完成执行：
 * - 与 JS 代码节点一致的同步 main({params}) 契约
 * - 每次执行使用独立临时目录，15 秒超时后连进程树一起结束，目录随后清理
 * 执行环境隔离的边界（这几点容易被误解，务必看准）：
 * - 子进程环境是白名单（见 buildPythonExecEnv），但这**不是**沙箱：子进程与网关进程
 *   同用户、同文件权限，照样能读到宿主机上的文件（例如项目根的 .env，里面就是数据库
 *   密码、JWT 密钥与各类加密密钥）。白名单只是拿掉了「一行 os.environ 就读走」这条
 *   最省事的通道。
 * - 因此真正的控制是 ensureExecAllowed：非回环监听默认关闭；显式开启时也只放管理员。
 * - 已知边界：不做依赖白名单、资源配额与网络隔离，仅面向本机开发场景
 * - 已知边界：杀不掉**主动脱离**的后代进程（Windows DETACHED_PROCESS、POSIX
 *   start_new_session）；Windows 上脚本**正常跑完**时派生的后台进程也可能留下
 *   （父进程已退出，taskkill /T 找不到树）。真正的隔离需要 cgroup/Job Object，
 *   这里做不到，所以端点默认只在回环监听时开放（非回环时另加一层：仅管理员），
 *   不要把它当沙箱用
 */
@UseGuards(JwtAuthGuard)
@Controller('python')
export class PythonExecController {
  private readonly logger = new Logger(PythonExecController.name);
  private pythonCommand: string | null = null;
  private pythonCheck: Promise<string | null> | null = null;
  private execEnabledWarned = false;

  /**
   * 每次调用都会在网关宿主起一个 Python 进程。按用户限流（默认每分钟 20 次），
   * 避免单个账号把宿主机进程/CPU 打满——15 秒超时只保证单次不失控，不保证并发量。
   */
  private readonly limiter: FixedWindowRateLimiter;

  constructor(private readonly config: ConfigService) {
    this.limiter = new FixedWindowRateLimiter({
      limit: resolveRateLimit(this.config.get<string>('PYTHON_EXEC_MAX_PER_MINUTE'), 20),
    });
  }

  /**
   * 本机 Python 执行是否对本次请求开放。
   *
   * 端点在监听回环时等价于「本机开发者在自己的机器上执行代码」，只要求登录；
   * 一旦对外监听，它等价于**对任何登录账号开放宿主任意代码执行**——而注册是
   * 自助的（`POST /auth/register` 只按来源限流），所以此时必须再收一层：只允许
   * 管理员。默认仍是非回环即关闭，`PYTHON_EXEC_ENABLED=true` 是部署方的显式裁决。
   */
  private ensureExecAllowed(user?: { role?: string }): void {
    // 归一化方式与 main.ts 里决定监听地址的那段完全一致，避免「main 绑了
    // 回环、这里却按空值判定」这种两处口径不一致导致的静默不可用。
    const host = this.config.get<string>('GATEWAY_HOST', '127.0.0.1').trim() || '127.0.0.1';
    const enabled = resolvePythonExecEnabled({
      explicit: this.config.get<string>('PYTHON_EXEC_ENABLED') ?? null,
      host,
    });
    if (!enabled) {
      throw new ForbiddenException(
        `本机 Python 执行未启用（当前网关监听 ${host || '(未设置)'}）。` +
        '该端点允许登录用户在网关宿主执行任意代码，跨机部署如需开启请显式设置 PYTHON_EXEC_ENABLED=true 并自行评估风险。',
      );
    }
    if (isLoopbackHost(host)) return;

    // 非回环：只有管理员可以执行。注意这条判断必须在「已启用」之后——
    // 关掉功能时不该顺带泄露「谁是不是管理员」。
    if (user?.role !== 'admin') {
      throw new ForbiddenException(
        `本机 Python 执行在非回环监听（${host}）下仅对管理员开放。` +
        '该端点会在网关宿主执行任意代码；跨机部署请使用管理员账号，或改用回环监听 + 本机画布试运行。',
      );
    }
    if (!this.execEnabledWarned) {
      this.execEnabledWarned = true;
      this.logger.warn(
        `Python 执行节点已在非回环地址（${host}）下启用：仅管理员可调用，请在反向代理与防火墙层再确认可达范围`,
      );
    }
  }

  private detectPython(): Promise<string | null> {
    if (this.pythonCommand) return Promise.resolve(this.pythonCommand);
    if (this.pythonCheck) return this.pythonCheck;
    this.pythonCheck = new Promise((resolve) => {
      const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
      let index = 0;
      const tryNext = () => {
        if (index >= candidates.length) {
          resolve(null);
          return;
        }
        const candidate = candidates[index++];
        // 探测同样使用净化后的环境：一是与真实执行保持一致（否则会出现「探测通过、
        // 真正执行时因环境缺键起不来」的错位），二是不给这个探测进程留一份完整凭据。
        const probe = spawn(candidate, ['-c', 'print(1)'], {
          timeout: 5_000,
          windowsHide: true,
          env: buildPythonExecEnv(buildPythonPathFromEnv(), process.env),
        });
        probe.on('error', () => tryNext());
        probe.on('close', (code) => {
          if (code === 0) {
            this.pythonCommand = candidate;
            resolve(candidate);
          } else {
            tryNext();
          }
        });
      };
      tryNext();
    });
    return this.pythonCheck;
  }

  @Post('exec')
  async exec(@Request() req: any, @Body() payload: PythonExecPayload) {
    if (!req?.user?.id) throw new BadRequestException('未认证');
    this.ensureExecAllowed(req.user);
    this.limiter.assertAllowed(String(req.user.id), 'Python 执行');
    const code = payload.code || '';
    if (!code.trim()) throw new BadRequestException('Python 代码不能为空');
    if (code.length > MAX_CODE_LENGTH) {
      throw new BadRequestException(`Python 代码长度不能超过 ${MAX_CODE_LENGTH} 个字符`);
    }

    const python = await this.detectPython();
    if (!python) {
      throw new BadRequestException('未检测到本机 Python，请安装 Python 3 后重试');
    }

    const dir = await mkdtemp(join(tmpdir(), 'ff-py-'));
    const userFile = join(dir, 'main.py');
    const runnerFile = join(dir, 'runner.py');
    const paramsFile = join(dir, 'params.json');
    // 超时由这里自己管：Node 的 spawn timeout 只杀直接子进程，杀不掉孙进程
    let child: ChildProcess | null = null;
    let timedOut = false;
    try {
      await writeFile(userFile, code, 'utf8');
      await writeFile(runnerFile, RUNNER_SOURCE, 'utf8');
      await writeFile(paramsFile, JSON.stringify(payload.params ?? {}), 'utf8');

      const stdout = await new Promise<string>((resolve, reject) => {
        const pythonPath = buildPythonPathFromEnv();
        const spawned = spawn(python, [runnerFile, paramsFile, userFile], {
          cwd: dir,
          windowsHide: true,
          // POSIX 下自成进程组，配合 killProcessTree 连孙进程一起结束
          detached: process.platform !== 'win32',
          // 不继承 process.env：里面是整套服务凭据，用户代码一行 os.environ 就能读走
          env: buildPythonExecEnv(pythonPath, process.env),
        });
        child = spawned;
        let out = '';
        let err = '';
        spawned.stdout.on('data', (d) => { out += String(d); });
        spawned.stderr.on('data', (d) => { err += String(d); });
        spawned.on('error', (e) => reject(new BadRequestException(`无法启动 Python: ${e.message}`)));

        const timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(spawned);
        }, EXEC_TIMEOUT_MS);

        spawned.on('close', (exitCode) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new BadRequestException(`Python 执行超时（${EXEC_TIMEOUT_MS / 1000} 秒上限）`));
            return;
          }
          if (exitCode !== 0) {
            const markerIndex = err.indexOf('Traceback');
            const detail = (err || out).trim().split('\n').filter(Boolean).slice(-3).join('\n');
            reject(new BadRequestException(
              detail || `Python 执行失败（退出码 ${exitCode ?? markerIndex}）`,
            ));
            return;
          }
          resolve(out);
        });
      });

      const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_MARKER));
      if (!line) {
        throw new BadRequestException('Python 脚本未返回结果（main 需要返回一个对象）');
      }
      const raw = line.slice(RESULT_MARKER.length);
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        result = raw;
      }
      return { result };
    } finally {
      // 收一遍进程树。注意：POSIX 上这对正常结束也有效（整组还在），Windows 上只在
      // 父进程尚未退出（即超时被杀）时有效——正常结束时这里是对着死 pid 空转。
      // 详细边界见 killProcessTree 的注释，别把它当成沙箱保证。
      killProcessTree(child);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}