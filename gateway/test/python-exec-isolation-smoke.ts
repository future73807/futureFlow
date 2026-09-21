import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { PythonExecController } from '../src/localtools/python-exec.controller';
import {
  buildPythonExecEnv,
  isLoopbackHost,
  resolvePythonExecEnabled,
} from '../src/localtools/python-exec.controller';

/** 用桩配置构造控制器，只验证「闸门是否真的拦得住」。 */
function controllerWith(values: Record<string, string | undefined>): PythonExecController {
  const config = {
    get: (key: string, fallback?: string) => {
      const value = values[key];
      return value === undefined ? fallback : value;
    },
  };
  return new PythonExecController(config as never);
}

/** 调用私有的 ensureExecAllowed：放行返回 true，拦截返回 false。 */
function execAllowed(controller: PythonExecController, user?: { role?: string }): boolean {
  try {
    (controller as unknown as { ensureExecAllowed(user?: { role?: string }): void })
      .ensureExecAllowed(user);
    return true;
  } catch (error) {
    assert.match(
      String((error as Error).message),
      /Python|PYTHON_EXEC_ENABLED/,
      '拒绝时应给出可操作的说明，而不是笼统的 Forbidden',
    );
    return false;
  }
}

/**
 * 「Python 执行」端点的两条安全属性回归。
 *
 * 背景：该端点只用 `@UseGuards(JwtAuthGuard)`，也就是**任意登录账号**（不要求
 * 管理员）都能在网关宿主上执行任意 Python 代码，且此前子进程原样继承
 * process.env——网关自己的数据库密码、JWT 密钥、LLM API Key、媒体加密密钥都
 * 在里面，用户代码一行 `os.environ` 就能读走。文件里那句「仅面向本机开发场
 * 景」只是注释，运行时并没有任何东西强制它。
 *
 * 这里守住两件事：
 *   1. 子进程环境是白名单，服务凭据不会流进去；
 *   2. 网关对外监听时端点默认关闭（把「仅本机」从注释变成可执行的约束）。
 *
 * 两条都是静默退化型：写错的表现是「一切正常、只是凭据已经漏了」，不会报错。
 */

/** 模拟网关进程里真实存在的服务凭据。 */
const GATEWAY_SECRETS = {
  POSTGRES_PASSWORD: 'pg-super-secret',
  GATEWAY_JWT_SECRET: 'jwt-super-secret',
  LLM_API_KEY: 'sk-super-secret',
  DIFY_SECRET_KEY: 'dify-super-secret',
  MEDIA_CREDENTIAL_ENCRYPTION_SECRET: 'media-super-secret',
  DIFY_KEY_ENCRYPTION_SECRET: 'dify-key-super-secret',
};

async function main() {
  // ── 1. 服务凭据一个都不应进入子进程环境 ──────────────────────────
  {
    const env = buildPythonExecEnv(undefined, { ...GATEWAY_SECRETS, PATH: '/usr/bin' }, 'linux');
    for (const name of Object.keys(GATEWAY_SECRETS)) {
      assert.equal(env[name], undefined, `${name} 不应出现在子进程环境中`);
    }
  }

  // ── 2. 任意非白名单键都被剥离（不止已知的那一批）──────────────────
  {
    const env = buildPythonExecEnv(
      undefined,
      { PATH: '/usr/bin', SOME_FUTURE_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'y' },
      'linux',
    );
    assert.equal(env.SOME_FUTURE_SECRET, undefined, '未知键不应透传');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, '未知键不应透传');
  }

  // ── 3. 运行 Python 真正需要的键被保留 ────────────────────────────
  {
    const posix = buildPythonExecEnv(
      undefined,
      { PATH: '/usr/bin', HOME: '/home/u', LANG: 'zh_CN.UTF-8', TMPDIR: '/tmp' },
      'linux',
    );
    assert.equal(posix.PATH, '/usr/bin', 'PATH 必须保留，否则找不到 python');
    assert.equal(posix.HOME, '/home/u');
    assert.equal(posix.LANG, 'zh_CN.UTF-8');
    assert.equal(posix.TMPDIR, '/tmp');

    // Windows 缺 SystemRoot/COMSPEC 时 CPython 可能起不来
    const win = buildPythonExecEnv(
      undefined,
      { PATH: 'C:\\Python', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\x\\cmd.exe', TEMP: 'C:\\t' },
      'win32',
    );
    assert.equal(win.SystemRoot, 'C:\\Windows', 'Windows 下必须保留 SystemRoot');
    assert.equal(win.COMSPEC, 'C:\\x\\cmd.exe');
    assert.equal(win.TEMP, 'C:\\t');
  }

  // ── 4. 空值不写入（空串会让 Python 把当前目录或空路径当搜索路径）────
  {
    const env = buildPythonExecEnv(undefined, { PATH: '/usr/bin', HOME: '', TMPDIR: '' }, 'linux');
    assert.equal('HOME' in env, false, '空值应整键省略，而不是写入空串');
    assert.equal('TMPDIR' in env, false);
  }

  // ── 5. 锁定 UTF-8 输出编码 ───────────────────────────────────────
  // 白名单剥掉 LANG/LC_ALL 的场景下，Windows 会退回系统代码页，结果里的
  // 中文会让网关这侧的 JSON 解析失败。
  {
    const env = buildPythonExecEnv(undefined, { PATH: '/usr/bin' }, 'linux');
    assert.equal(env.PYTHONIOENCODING, 'utf-8', '必须锁定 stdout 编码');
    assert.equal(env.PYTHONUTF8, '1');
  }

  // ── 6. 注入的 PYTHONPATH 仍然生效（不能因为收紧环境而丢掉连库能力）──
  {
    const env = buildPythonExecEnv('/vendor/python', { PATH: '/usr/bin' }, 'linux');
    assert.equal(env.PYTHONPATH, '/vendor/python');
  }

  // ── 7. 无副作用：不修改父进程环境 ────────────────────────────────
  // 用序列化快照而不是 deepEqual：Windows 上 process.env 是特化对象，
  // 与展开出来的普通对象原型不同，deepStrictEqual 会误判。
  {
    const before = JSON.stringify(process.env);
    buildPythonExecEnv('/vendor/python', process.env);
    assert.equal(JSON.stringify(process.env), before, 'buildPythonExecEnv 不应改动 process.env');
  }

  // ── 8. 回环判定 ──────────────────────────────────────────────────
  {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.5.5.5']) {
      assert.equal(isLoopbackHost(host), true, `${host} 应判定为回环`);
    }
    for (const host of ['0.0.0.0', '192.168.1.10', '10.0.0.5', 'example.com', '', null]) {
      assert.equal(isLoopbackHost(host), false, `${String(host)} 不应判定为回环`);
    }
    // 大小写与空格不应影响判定（配置文件里常被写成 " 127.0.0.1 "）
    assert.equal(isLoopbackHost('  LocalHost '), true, '应容忍大小写与空白');
  }

  // ── 9. 启用开关：显式优先，未显式时跟随监听地址 ───────────────────
  {
    assert.equal(
      resolvePythonExecEnabled({ explicit: 'true', host: '0.0.0.0' }),
      true,
      '显式开启应覆盖非回环默认值',
    );
    assert.equal(
      resolvePythonExecEnabled({ explicit: 'false', host: '127.0.0.1' }),
      false,
      '显式关闭应覆盖回环默认值',
    );
    assert.equal(resolvePythonExecEnabled({ host: '127.0.0.1' }), true, '回环时默认开放');
    assert.equal(resolvePythonExecEnabled({ host: '0.0.0.0' }), false, '对外监听时默认关闭');
    assert.equal(resolvePythonExecEnabled({ host: '192.168.1.10' }), false, '内网地址也默认关闭');
    // 拿不到监听地址时必须 fail closed——宁可让功能不可用，也不能默认放行 RCE
    assert.equal(resolvePythonExecEnabled({ host: null }), false, '未知监听地址应默认关闭');
    assert.equal(resolvePythonExecEnabled({}), false);
  }

  // ── 10. 真实集成：用净化后的环境跑 python，确认凭据读不到且中文不乱码 ──
  {
    const env = buildPythonExecEnv(undefined, { ...process.env, ...GATEWAY_SECRETS });
    const probe = spawnSync(
      'python',
      [
        '-c',
        'import os,json;'
        + 'print(json.dumps({k: os.environ.get(k) for k in '
        + JSON.stringify(Object.keys(GATEWAY_SECRETS))
        + "}, ensure_ascii=False));print('中文编码检查')",
      ],
      { encoding: 'utf8', windowsHide: true, env, timeout: 20_000 },
    );
    if (probe.error || probe.status !== 0) {
      // 本机没有 python 时跳过；有 python 却失败才是真问题
      if (/ENOENT/.test(String(probe.error))) {
        console.log('  跳过真实子进程检查：本机无 python');
      } else {
        assert.fail(
          `净化后的环境应能正常启动 python，实际: ${String(probe.stderr || probe.error).slice(0, 300)}`,
        );
      }
    } else {
      const lines = String(probe.stdout).trim().split('\n');
      const dumped = JSON.parse(lines[0]);
      for (const [key, value] of Object.entries(dumped)) {
        assert.equal(value, null, `子进程不应读到 ${key}`);
      }
      assert.equal(lines[1], '中文编码检查', 'stdout 应按 UTF-8 解码，中文不能乱码');
      // 反向确认：同一段代码在完整环境下**确实**能读到，证明上面的 null
      // 来自净化而非探针写错（否则这条测试会假通过）
      const control = spawnSync(
        'python',
        ['-c', 'import os;print(os.environ.get("POSTGRES_PASSWORD") or "NONE")'],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...GATEWAY_SECRETS } },
      );
      assert.equal(
        String(control.stdout).trim(),
        'pg-super-secret',
        '对照组应能读到凭据（否则前一条断言是假通过）',
      );
    }
  }

  // ── 11. 端点级：控制器确实执行了闸门，而不只是纯函数算对了 ─────────
  // 纯函数正确 ≠ 有人调用它。这一条直接构造控制器并触发校验，防止将来
  // 重构时把 ensureExecAllowed 的调用漏掉（漏掉的表现是「一切正常、只是
  // 又对外放开了 RCE」，不会有任何报错）。
  {
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '127.0.0.1' })),
      true,
      '本机监听时应放行（否则本地试运行直接不可用）',
    );
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '0.0.0.0' })),
      false,
      '对外监听时应拦截',
    );
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '0.0.0.0', PYTHON_EXEC_ENABLED: 'true' }), { role: 'admin' }),
      true,
      '显式开启后应放行（管理员）',
    );
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '127.0.0.1', PYTHON_EXEC_ENABLED: 'false' })),
      false,
      '显式关闭后应拦截',
    );
    // .env.example 里留空表示「未设置」，应回落到按监听地址判定
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '127.0.0.1', PYTHON_EXEC_ENABLED: '' })),
      true,
      '留空应视为未设置，回落到监听地址判定',
    );
    // 与 main.ts 的归一化保持一致：空值按 127.0.0.1 处理，而不是禁用
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '  ' })),
      true,
      'GATEWAY_HOST 为空时应按 main.ts 的默认 127.0.0.1 处理',
    );
  }

  // ── 12. 非回环启用时再收一层：只放管理员 ──────────────────────────
  // 注册是自助的（POST /auth/register 仅按来源限流），所以「跨机 + 已启用」
  // 若不额外收紧，等于对任何注册用户开放宿主任意代码执行。
  {
    const remote = { GATEWAY_HOST: '0.0.0.0', PYTHON_EXEC_ENABLED: 'true' };
    assert.equal(
      execAllowed(controllerWith(remote), { role: 'user' }),
      false,
      '对外监听下普通用户必须被拦住（这是本轮真正的收口）',
    );
    assert.equal(
      execAllowed(controllerWith(remote)),
      false,
      '拿不到用户信息时也必须 fail-closed，而不是当成管理员',
    );
    assert.equal(
      execAllowed(controllerWith({ ...remote, GATEWAY_HOST: '192.168.1.10' }), { role: 'admin' }),
      true,
      '内网地址同样属于非回环，管理员可用',
    );
    // 本机场景不受影响：本地试运行是「本机开发者自己的机器」，无需管理员
    assert.equal(
      execAllowed(controllerWith({ GATEWAY_HOST: '127.0.0.1' }), { role: 'user' }),
      true,
      '回环监听下普通用户仍可用（否则本地画布试运行会被打断）',
    );
    // 关闭优先于管理员：功能关掉时不该顺带泄露「谁是不是管理员」
    assert.equal(
      execAllowed(
        controllerWith({ GATEWAY_HOST: '0.0.0.0', PYTHON_EXEC_ENABLED: 'false' }),
        { role: 'admin' },
      ),
      false,
      '显式关闭时管理员也不能用',
    );
  }

  // ── 13. 探测进程也走净化环境，且仍能探测到本机 Python ─────────────
  // 若白名单漏了启动必需键，表现是「未检测到本机 Python」——又是一条静默
  // 不可用型故障：功能看着是关的，实际是环境键漏了。
  {
    const detectPython = (controller: PythonExecController) => (
      controller as unknown as { detectPython(): Promise<string | null> }
    ).detectPython();
    const localPython = ['python', 'python3', 'py'].some((candidate) => (
      spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true }).status === 0
    ));
    if (!localPython) {
      console.log('  跳过探测一致性检查：本机无 python');
    } else {
      assert.ok(
        await detectPython(controllerWith({ GATEWAY_HOST: '127.0.0.1' })),
        '净化后的环境应仍能启动并探测到 Python',
      );
    }
  }

  console.log(
    'python-exec 隔离测试通过: 凭据剥离 / 未知键剥离 / 必需键保留 / 空值省略 / 编码锁定 / '
    + 'PYTHONPATH 保留 / 无副作用 / 回环判定 / 开关优先与 fail-closed / 真实子进程 / 端点闸门 / '
    + '非回环仅管理员 / 探测环境一致',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
