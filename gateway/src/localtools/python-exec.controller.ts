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
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
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

// ─────────────────────────────────────────────────────────────
// 执行模式：本机 Python ／ 容器沙箱
// ─────────────────────────────────────────────────────────────
//
// `local` 模式下子进程与网关同用户、同文件权限，**能直接读宿主上的 .env**
// （里面有数据库密码、JWT 密钥、各类加密密钥）。环境变量白名单只堵住了
// 「一行 os.environ 就读走」这条最省事的通道，堵不住读文件。
//
// `docker` 模式把用户代码放进一次性容器里跑，换来四项本机模式给不了的保证：
//   - 读不到宿主文件系统（只挂载本次的临时工作目录，且只读）
//   - 默认无网络（`--network=none`）
//   - 根文件系统只读，只有 /tmp 是可写 tmpfs
//   - 内存/CPU/进程数有硬上限，容器随进程结束一起消失
//
// 默认仍是 `local`：现有部署里 Python 节点可能要靠网络连数据库
// （见 scripts/test-local-tools.cjs），默认切到 docker 会直接打断这类用法。
// 需要隔离的部署显式设 `PYTHON_EXEC_MODE=docker`。

export type PythonExecMode = 'local' | 'docker';

/** 解析执行模式（纯函数）。只认 `docker`，其余一律回落到 `local`。 */
export function resolvePythonExecMode(explicit?: string | null): PythonExecMode {
  return (explicit ?? '').trim().toLowerCase() === 'docker' ? 'docker' : 'local';
}

/**
 * 容器内挂载宿主路径时的写法。
 *
 * Windows 上 `tmpdir()` 给的是 `C:\Users\...`，反斜杠在 `-v` 里会被 Docker 当成
 * 转义符，统一转成正斜杠；POSIX 上原样返回。
 */
export function toDockerMountPath(hostPath: string): string {
  return hostPath.replace(/\\/g, '/');
}

export interface PythonDockerRunOptions {
  image: string;
  containerName: string;
  /** 宿主上的本次工作目录（内含 runner.py / params.json / main.py）。 */
  workDir: string;
  /** 随仓库携带的纯 Python 依赖目录；为 null 或不存在时不挂。 */
  vendoredModulesDir?: string | null;
  /** Docker 网络模式，默认 none。需要连库的部署可改成 bridge。 */
  network?: string;
  /** 额外要挂进容器并加入 PYTHONPATH 的宿主目录。 */
  extraModulesPath?: string | null;
}

/** 容器内的工作目录与依赖挂载点。 */
export const DOCKER_WORK_DIR = '/work';
export const DOCKER_VENDOR_DIR = '/vendor';

/**
 * 组装 `docker run` 的参数（纯函数，便于测试）。
 *
 * 加固项逐条说明：
 * - `--network=none`  默认无网络。用户代码里的 requests/socket 全部失败，
 *                     不能把宿主当跳板去探测内网。
 * - `--read-only`     根文件系统只读，写文件只能落到 /tmp 的 tmpfs 上，
 *                     进程结束即消失，不会在镜像层里留下东西。
 * - `--tmpfs /tmp`    挂 noexec/nosuid，避免把可执行文件写进 tmpfs 再跑。
 * - `--pids-limit`    挡住 fork 炸弹（否则一个 while True: fork() 就能把宿主拖垮）。
 * - `--memory-swap`   与 --memory 相等，禁止用 swap 绕过内存上限。
 * - `--cap-drop=ALL`  丢掉全部 Linux capabilities。
 * - `no-new-privileges` 禁止 setuid 提权。
 * - `--user 65534`    以 nobody 身份运行，不是 root。
 * - 挂载一律 `readonly` 用户代码改不了自己的源码与参数文件。
 *
 * 挂载用 `--mount type=bind,...` 而不是 `-v host:container:opts`：后者用冒号分隔，
 * 而 Windows 盘符自带冒号（`D:\mods`），拼出来的串要靠 Docker 特判才能正确解析。
 * `--mount` 用 `key=value` 逗号分隔，路径里的冒号不参与分隔，语义无歧义。
 */
export function buildPythonDockerArgs(options: PythonDockerRunOptions): string[] {
  const bindMount = (source: string, target: string): string[] => [
    '--mount', `type=bind,source=${toDockerMountPath(source)},target=${target},readonly`,
  ];

  const args: string[] = [
    'run',
    '--rm',
    '--name', options.containerName,
    '--network', options.network || 'none',
    '--memory', '256m',
    '--memory-swap', '256m',
    '--cpus', '1',
    '--pids-limit', '128',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    ...bindMount(options.workDir, DOCKER_WORK_DIR),
    '-w', DOCKER_WORK_DIR,
    // 锁定 UTF-8：容器内同样不继承宿主 locale，否则中文结果会变乱码
    '-e', 'PYTHONIOENCODING=utf-8',
    '-e', 'PYTHONUTF8=1',
  ];

  const pythonPath: string[] = [];
  if (options.vendoredModulesDir) {
    args.push(...bindMount(options.vendoredModulesDir, DOCKER_VENDOR_DIR));
    pythonPath.push(DOCKER_VENDOR_DIR);
  }
  for (const extra of (options.extraModulesPath ?? '').split(delimiter).filter(Boolean)) {
    // 额外目录逐个挂载：容器里看不到宿主其余部分，只能显式放行
    const mountPoint = `/extra/${pythonPath.length}`;
    args.push(...bindMount(extra, mountPoint));
    pythonPath.push(mountPoint);
  }
  if (pythonPath.length) args.push('-e', `PYTHONPATH=${pythonPath.join(':')}`);

  args.push(
    options.image,
    'python',
    `${DOCKER_WORK_DIR}/runner.py`,
    `${DOCKER_WORK_DIR}/params.json`,
    `${DOCKER_WORK_DIR}/main.py`,
  );
  return args;
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
 * 两种执行模式（`PYTHON_EXEC_MODE`）：
 *
 * **`local`（默认）** —— 直接跑宿主 Python。子进程环境是白名单
 * （见 buildPythonExecEnv），但这**不是**沙箱：子进程与网关进程同用户、同文件权限，
 * 照样能读到宿主机上的文件（例如项目根的 .env，里面就是数据库密码、JWT 密钥与各类
 * 加密密钥）。白名单只是拿掉了「一行 os.environ 就读走」这条最省事的通道。
 * - 已知边界：不做依赖白名单、资源配额与网络隔离，仅面向本机开发场景
 * - 已知边界：杀不掉**主动脱离**的后代进程（Windows DETACHED_PROCESS、POSIX
 *   start_new_session）；Windows 上脚本**正常跑完**时派生的后台进程也可能留下
 *   （父进程已退出，taskkill /T 找不到树）。真正的隔离需要 cgroup/Job Object，
 *   这里做不到，所以端点默认只在回环监听时开放（非回环时另加一层：仅管理员），
 *   不要把它当沙箱用
 *
 * **`docker`** —— 把用户代码放进一次性容器里跑（参数见 buildPythonDockerArgs）。
 * 这一模式补上了 local 模式读宿主文件这个缺口：只挂载本次的临时工作目录（只读），
 * 默认 `--network=none`，根文件系统只读，内存/CPU/进程数有硬上限，容器随执行结束消失。
 * 默认仍是 local（现有部署可能靠网络连库，默认切换会打断），需要隔离的部署显式开启。
 */
@UseGuards(JwtAuthGuard)
@Controller('python')
export class PythonExecController {
  private readonly logger = new Logger(PythonExecController.name);
  private pythonCommand: string | null = null;
  private pythonCheck: Promise<string | null> | null = null;
  private dockerCommand: string | null = null;
  private dockerCheck: Promise<string | null> | null = null;
  private execEnabledWarned = false;
  private dockerModeWarned = false;

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

  /**
   * 探测 docker 是否可用（`docker version` 会同时校验客户端与守护进程）。
   * 结果缓存：执行路径上每次调用都探测会白白多花几百毫秒。
   */
  private detectDocker(): Promise<string | null> {
    if (this.dockerCommand) return Promise.resolve(this.dockerCommand);
    if (this.dockerCheck) return this.dockerCheck;
    this.dockerCheck = new Promise((resolve) => {
      const probe = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeout: 10_000,
        windowsHide: true,
        // 探测进程不需要任何宿主凭据
        env: buildPythonExecEnv(undefined, process.env),
      });
      let out = '';
      probe.stdout?.on('data', (d) => { out += String(d); });
      probe.on('error', () => resolve(null));
      probe.on('close', (code) => {
        if (code === 0) {
          this.dockerCommand = 'docker';
          this.logger.log(`Python 执行将走容器沙箱（Docker ${out.trim()}）`);
          resolve('docker');
          return;
        }
        resolve(null);
      });
    });
    return this.dockerCheck;
  }

  /**
   * 确认沙箱镜像已在本地。
   *
   * 不预检的话，镜像缺失时 `docker run` 会先去 pull：既可能因为网络不可达而卡到超时，
   * 也会把一个「镜像没拉」的问题伪装成「Python 执行超时」，排查方向被彻底带偏。
   */
  private async ensureDockerImage(docker: string, image: string): Promise<void> {
    const available = await new Promise<boolean>((resolve) => {
      const probe = spawn(docker, ['image', 'inspect', image], {
        timeout: 10_000,
        windowsHide: true,
        env: buildPythonExecEnv(undefined, process.env),
      });
      probe.on('error', () => resolve(false));
      probe.on('close', (code) => resolve(code === 0));
    });
    if (!available) {
      throw new BadRequestException(
        `容器沙箱镜像 ${image} 不在本地，请先执行 docker pull ${image}`
        + '（网关不会自动拉取：拉取耗时会让执行超时，问题也被伪装成「执行超时」）。',
      );
    }
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

    const mode = resolvePythonExecMode(this.config.get<string>('PYTHON_EXEC_MODE'));

    // 两种模式各自准备执行命令。local 需要宿主 Python，docker 需要可用的 docker 与镜像。
    let command: string;
    let commandArgs: string[];
    let dockerImage = '';
    let containerName = '';
    if (mode === 'docker') {
      const docker = await this.detectDocker();
      if (!docker) {
        throw new BadRequestException(
          'PYTHON_EXEC_MODE=docker 但未检测到可用的 Docker（docker version 失败）。'
          + '请确认 Docker 已安装且守护进程在运行，或改用 PYTHON_EXEC_MODE=local。',
        );
      }
      dockerImage = (this.config.get<string>('PYTHON_EXEC_DOCKER_IMAGE') || 'python:3.11-slim').trim();
      await this.ensureDockerImage(docker, dockerImage);
      if (!this.dockerModeWarned) {
        this.dockerModeWarned = true;
        this.logger.log(`Python 执行使用容器沙箱：镜像 ${dockerImage}，工作目录只读挂载`);
      }
      command = docker;
      commandArgs = [];
      containerName = `ff-py-${randomUUID().slice(0, 8)}`;
    } else {
      const python = await this.detectPython();
      if (!python) {
        throw new BadRequestException('未检测到本机 Python，请安装 Python 3 后重试');
      }
      command = python;
      commandArgs = [];
    }

    const dir = await mkdtemp(join(tmpdir(), 'ff-py-'));
    const userFile = join(dir, 'main.py');
    const runnerFile = join(dir, 'runner.py');
    const paramsFile = join(dir, 'params.json');
    // 超时由这里自己管：Node 的 spawn timeout 只杀直接子进程，杀不掉孙进程
    let child: ChildProcess | null = null;
    let timedOut = false;
    // 容器是否已自行退出。`--rm` 只在容器退出时清理，所以没退出就必须显式 rm。
    let containerExited = false;
    try {
      await writeFile(userFile, code, 'utf8');
      await writeFile(runnerFile, RUNNER_SOURCE, 'utf8');
      await writeFile(paramsFile, JSON.stringify(payload.params ?? {}), 'utf8');

      if (mode === 'docker') {
        // 容器以 nobody(65534) 运行，而 mkdtemp 建出来的是 0700 —— 不放开就读不到
        // 自己的工作文件。只加 o+rx，不写权限（挂载本身也是 :ro）。
        await chmod(dir, 0o755);
        const vendored = existsSync(VENDORED_MODULES_DIR) ? VENDORED_MODULES_DIR : null;
        commandArgs = buildPythonDockerArgs({
          image: dockerImage,
          containerName,
          workDir: dir,
          vendoredModulesDir: vendored,
          network: this.config.get<string>('PYTHON_EXEC_DOCKER_NETWORK') || 'none',
          extraModulesPath: process.env.PYTHON_EXTRA_MODULES_PATH ?? null,
        });
      } else {
        commandArgs = [runnerFile, paramsFile, userFile];
      }

      const stdout = await new Promise<string>((resolve, reject) => {
        const pythonPath = buildPythonPathFromEnv();
        const spawned = spawn(command, commandArgs, {
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
        spawned.on('error', (e) => reject(new BadRequestException(
          mode === 'docker'
            ? `无法启动容器沙箱: ${e.message}`
            : `无法启动 Python: ${e.message}`,
        )));

        const timer = setTimeout(() => {
          timedOut = true;
          // docker run 客户端被杀**不会**带走容器（容器已与客户端脱离），
          // 必须显式 kill；否则「15 秒超时」对容器内的代码是空话，它会继续跑。
          if (mode === 'docker' && containerName) {
            spawn(command, ['kill', containerName], {
              windowsHide: true,
              stdio: 'ignore',
            }).on('error', () => undefined);
          }
          killProcessTree(spawned);
        }, EXEC_TIMEOUT_MS);

        spawned.on('close', (exitCode) => {
          clearTimeout(timer);
          containerExited = true;
          if (timedOut) {
            reject(new BadRequestException(
              mode === 'docker'
                ? `容器沙箱执行超时（${EXEC_TIMEOUT_MS / 1000} 秒上限）`
                : `Python 执行超时（${EXEC_TIMEOUT_MS / 1000} 秒上限）`,
            ));
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
      // 容器没自行退出就补一刀。正常路径上 `--rm` 已经收走了，这里只在
      // 「客户端异常/被杀但容器还活着」时兜底，避免容器名与资源无限堆积。
      if (mode === 'docker' && containerName && !containerExited) {
        await new Promise<void>((resolve) => {
          spawn(command, ['rm', '-f', containerName], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 10_000,
          }).on('error', () => resolve()).on('close', () => resolve());
        }).catch(() => undefined);
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}