import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import {
  buildPythonDockerArgs,
  resolvePythonExecMode,
  toDockerMountPath,
  DOCKER_WORK_DIR,
  DOCKER_VENDOR_DIR,
} from '../src/localtools/python-exec.controller';

/**
 * Python 执行节点「容器沙箱」模式的结构与行为回归。
 *
 * 为什么需要这个测试：`PYTHON_EXEC_MODE=docker` 的价值全在**加固参数**上 ——
 * 少一个 `--network=none`、把工作目录挂成读写、忘了 `--read-only`，功能照样
 * 「能跑」，但隔离承诺已经不成立了，而且不会有任何报错。这类退化必须由测试挡住。
 *
 * 分两层：
 *   1. 参数断言（纯函数，永远跑）—— 加固项一个都不能少，且不能出现读写挂载。
 *   2. 真实容器验证（有 docker 与镜像时才跑）—— 在容器里实际尝试读宿主文件、
 *      连网络、写根目录，确认全部失败。参数对不等于隔离成立，得实测。
 */

const IMAGE = process.env.PYTHON_EXEC_DOCKER_IMAGE || 'python:3.11-slim';

/** 取参数里紧跟在某个选项后面的值（用于断言 --mount / --network 的具体取值）。 */
function valuesAfter(args: string[], option: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === option) out.push(args[i + 1]);
  }
  return out;
}

interface BindMount { source: string; target: string; readonly: boolean }

/** 解析 `--mount type=bind,...` 的取值，便于逐项断言。 */
function bindMounts(args: string[]): BindMount[] {
  return valuesAfter(args, '--mount').map((spec) => {
    const fields = Object.fromEntries(
      spec.split(',').map((part) => {
        const idx = part.indexOf('=');
        return idx === -1 ? [part, ''] : [part.slice(0, idx), part.slice(idx + 1)];
      }),
    );
    return {
      source: fields.source ?? '',
      target: fields.target ?? '',
      readonly: 'readonly' in fields,
    };
  });
}

function dockerAvailable(): boolean {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeout: 15_000,
    windowsHide: true,
    encoding: 'utf8',
  });
  return probe.status === 0;
}

function imageAvailable(image: string): boolean {
  const probe = spawnSync('docker', ['image', 'inspect', image], {
    timeout: 15_000,
    windowsHide: true,
  });
  return probe.status === 0;
}

// ── 1. 纯函数：模式解析 ────────────────────────────────────────────────
function assertModeParsing(): void {
  // 大小写与首尾空白都归一化后再判定
  for (const value of ['docker', 'DOCKER', '  docker  ', 'Docker', 'DoCkEr']) {
    assert.equal(
      resolvePythonExecMode(value),
      'docker',
      `${JSON.stringify(value)} 应被识别为 docker`,
    );
  }

  // 其余一律回落到 local：拼错时宁可退回「有边界说明的本机模式」，
  // 也不要因为一个 typo 让请求静默跑到未加固的路径上。
  for (const value of ['local', 'host', 'dock', 'dockers', 'true', '1', '', '   ', undefined, null]) {
    assert.equal(
      resolvePythonExecMode(value as string | null | undefined),
      'local',
      `${JSON.stringify(value)} 应回落到 local`,
    );
  }
}

// ── 2. 纯函数：挂载路径写法 ────────────────────────────────────────────
function assertMountPath(): void {
  assert.equal(
    toDockerMountPath('C:\\Users\\me\\AppData\\Local\\Temp\\ff-py-x'),
    'C:/Users/me/AppData/Local/Temp/ff-py-x',
    'Windows 反斜杠必须转正斜杠，否则 Docker 把 \\ 当转义符',
  );
  assert.equal(toDockerMountPath('/tmp/ff-py-x'), '/tmp/ff-py-x', 'POSIX 路径应原样返回');
}

// ── 3. 纯函数：加固参数一个都不能少 ────────────────────────────────────
function assertHardeningArgs(): void {
  const args = buildPythonDockerArgs({
    image: IMAGE,
    containerName: 'ff-py-test0001',
    workDir: 'C:\\tmp\\ff-py-test0001',
    vendoredModulesDir: null,
    network: 'none',
  });

  const required: Array<[string, string]> = [
    ['--network', 'none'],
    ['--memory', '256m'],
    ['--memory-swap', '256m'],
    ['--cpus', '1'],
    ['--pids-limit', '128'],
    ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'],
    ['--user', '65534:65534'],
    ['-w', DOCKER_WORK_DIR],
  ];
  for (const [option, expected] of required) {
    assert.ok(
      valuesAfter(args, option).includes(expected),
      `缺少加固项 ${option} ${expected}（实际 ${JSON.stringify(valuesAfter(args, option))}）`,
    );
  }

  // 布尔型开关没有取值，单独断言存在性
  for (const flag of ['--rm', '--read-only']) {
    assert.ok(args.includes(flag), `缺少加固开关 ${flag}`);
  }
  assert.ok(
    args.includes('--name') && valuesAfter(args, '--name').includes('ff-py-test0001'),
    '必须显式命名容器，否则超时后无法 docker kill',
  );

  // tmpfs 必须带 noexec/nosuid
  const tmpfs = valuesAfter(args, '--tmpfs');
  assert.equal(tmpfs.length, 1, '应有且只有一个 tmpfs');
  assert.match(tmpfs[0], /^\/tmp:/, 'tmpfs 应挂在 /tmp');
  assert.match(tmpfs[0], /noexec/, 'tmpfs 必须 noexec（否则可写可执行）');
  assert.match(tmpfs[0], /nosuid/, 'tmpfs 必须 nosuid');

  // 工作目录必须只读挂载 —— 这是「读不到宿主」的核心，挂成读写等于白做
  const mounts = bindMounts(args);
  const workMount = mounts.find((m) => m.target === DOCKER_WORK_DIR);
  assert.ok(workMount, `应挂载工作目录，实际挂载 ${JSON.stringify(mounts)}`);
  assert.equal(workMount!.readonly, true, `工作目录必须只读挂载，实际 ${JSON.stringify(workMount)}`);

  // 绝不能出现宿主根目录、项目目录或用户主目录的挂载
  for (const mount of mounts) {
    const source = mount.source;
    assert.ok(
      !/^[A-Za-z]?:?\/?$/.test(source) && source !== '/' && source !== '',
      `不应把宿主根目录挂进容器，实际 ${JSON.stringify(mount)}`,
    );
    assert.ok(
      !source.endsWith('futureFlow') && !/\/Desktop\/?$/.test(source),
      `不应把项目目录或桌面挂进容器，实际 ${JSON.stringify(mount)}`,
    );
  }
  assert.equal(
    mounts.length, 1,
    `未配置依赖目录时只应挂载工作目录，实际 ${JSON.stringify(mounts)}`,
  );

  // 入口命令必须是容器内路径，不能泄露宿主路径
  const tail = args.slice(args.indexOf(IMAGE));
  assert.equal(tail[0], IMAGE, '镜像名应在位置参数最前');
  assert.ok(
    tail.slice(1).every((a) => !/^[A-Za-z]:[\\/]/.test(a)),
    `容器内参数不应出现 Windows 宿主路径，实际 ${JSON.stringify(tail)}`,
  );
  assert.ok(tail.includes(`${DOCKER_WORK_DIR}/runner.py`), '应执行容器内的 runner.py');

  // 不继承宿主环境：除了显式 -e 之外不应有别的环境注入
  const envs = valuesAfter(args, '-e');
  for (const item of envs) {
    assert.ok(
      /^(PYTHONIOENCODING|PYTHONUTF8|PYTHONPATH)=/.test(item),
      `只应注入 Python 自身的编码/路径变量，实际 ${item}`,
    );
  }
}

// ── 4. 纯函数：依赖目录挂载与 PYTHONPATH ───────────────────────────────
function assertVendorMounts(): void {
  // 没带依赖目录时不挂 /vendor、也不设 PYTHONPATH
  const bare = buildPythonDockerArgs({
    image: IMAGE, containerName: 'c', workDir: '/tmp/w', vendoredModulesDir: null,
  });
  assert.ok(
    !bindMounts(bare).some((m) => m.target === DOCKER_VENDOR_DIR),
    '未提供依赖目录时不应挂 /vendor',
  );
  assert.ok(
    !valuesAfter(bare, '-e').some((e) => e.startsWith('PYTHONPATH=')),
    '未提供依赖目录时不应设 PYTHONPATH',
  );

  // 带了就挂成只读，并进 PYTHONPATH
  const withVendor = buildPythonDockerArgs({
    image: IMAGE, containerName: 'c', workDir: '/tmp/w',
    vendoredModulesDir: '/repo/gateway/vendor/python',
  });
  const vendorMount = bindMounts(withVendor).find((m) => m.target === DOCKER_VENDOR_DIR);
  assert.ok(vendorMount, '应挂载 /vendor');
  assert.equal(vendorMount!.readonly, true, '/vendor 必须只读');
  assert.ok(
    valuesAfter(withVendor, '-e').includes(`PYTHONPATH=${DOCKER_VENDOR_DIR}`),
    'PYTHONPATH 应指向容器内的 /vendor（不是宿主路径）',
  );

  // 额外目录：每个都单独只读挂载，并一起进 PYTHONPATH。
  // 分隔符必须用 path.delimiter —— Windows 上是 `;`，写死 `:` 会把整串当成一个路径。
  const withExtra = buildPythonDockerArgs({
    image: IMAGE, containerName: 'c', workDir: '/tmp/w',
    vendoredModulesDir: '/repo/gateway/vendor/python',
    extraModulesPath: ['/opt/a', '/opt/b'].join(delimiter),
  });
  const extraMounts = bindMounts(withExtra).filter((m) => m.target.startsWith('/extra/'));
  assert.equal(extraMounts.length, 2, `两个额外目录应各挂一次，实际 ${JSON.stringify(extraMounts)}`);
  for (const mount of extraMounts) assert.equal(mount.readonly, true, '额外目录必须只读');
  assert.deepEqual(
    extraMounts.map((m) => m.source), ['/opt/a', '/opt/b'],
    '额外目录的 source 应与传入顺序一致',
  );
  const pythonPath = valuesAfter(withExtra, '-e').find((e) => e.startsWith('PYTHONPATH='))!;
  assert.equal(
    pythonPath,
    `PYTHONPATH=${DOCKER_VENDOR_DIR}:/extra/1:/extra/2`,
    'PYTHONPATH 应使用容器内挂载点，且顺序与传入一致',
  );

  // 路径含盘符冒号时不能把 mount 规格拆坏（这正是弃用 `-v` 的原因）
  const withColon = buildPythonDockerArgs({
    image: IMAGE, containerName: 'c', workDir: 'D:\\tmp\\w',
    vendoredModulesDir: null,
    extraModulesPath: 'D:\\mods',
  });
  const colonMount = bindMounts(withColon).find((m) => m.target === '/extra/0');
  assert.ok(colonMount, '含盘符的路径也应能挂上');
  assert.equal(colonMount!.source, 'D:/mods', '盘符冒号应保留在 source 里，不参与分隔');
}

// ── 5. 真实容器：隔离承诺必须实测成立 ──────────────────────────────────
async function assertRealIsolation(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'ff-py-sbx-'));
  const runner = join(dir, 'runner.py');
  const probe = join(dir, 'main.py');
  const params = join(dir, 'params.json');

  // runner 与生产用的同构：读 params、执行用户源码、调用 main、打印结果标记
  await writeFile(runner, `import json, sys
params = {}
if len(sys.argv) > 1:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        params = json.load(f)
with open(sys.argv[2], 'r', encoding='utf-8') as f:
    source = f.read()
scope = {'__name__': '__main__'}
exec(compile(source, 'main.py', 'exec'), scope)
print('__FF_RESULT__' + json.dumps(scope['main'](params), ensure_ascii=False, default=str))
`, 'utf8');

  // 探针：逐项尝试突破隔离边界
  await writeFile(probe, `import json, os, socket

def main(params):
    out = {}
    # 宿主项目目录：容器里绝不该能看到
    readable = []
    for candidate in params.get('host_paths', []):
        try:
            with open(candidate, 'r', encoding='utf-8') as f:
                f.read(64)
            readable.append(candidate)
        except Exception:
            pass
    out['host_files_readable'] = readable
    # 网络
    try:
        socket.create_connection(('1.1.1.1', 53), timeout=3).close()
        out['network'] = 'reachable'
    except Exception:
        out['network'] = 'blocked'
    # 根文件系统
    try:
        with open('/probe_write', 'w', encoding='utf-8') as f:
            f.write('x')
        out['root_writable'] = True
    except Exception:
        out['root_writable'] = False
    # /tmp 应当可写（tmpfs），否则正常的临时文件用法会被误伤
    try:
        with open('/tmp/probe_write', 'w', encoding='utf-8') as f:
            f.write('x')
        out['tmp_writable'] = True
    except Exception:
        out['tmp_writable'] = False
    # 环境变量里不应有服务凭据
    out['credential_env'] = sorted(
        k for k in os.environ
        if 'SECRET' in k.upper() or 'PASSWORD' in k.upper() or 'TOKEN' in k.upper()
    )
    out['uid'] = os.getuid() if hasattr(os, 'getuid') else -1
    return out
`, 'utf8');

  const repoRoot = resolve(__dirname, '..', '..');
  await writeFile(params, JSON.stringify({
    host_paths: [
      join(repoRoot, '.env'),
      join(repoRoot, 'gateway', 'package.json'),
      join(repoRoot, 'README.md'),
    ],
  }), 'utf8');

  const containerName = `ff-py-smoke-${Date.now().toString(36)}`;
  const args = buildPythonDockerArgs({
    image: IMAGE,
    containerName,
    workDir: dir,
    vendoredModulesDir: existsSync(join(__dirname, '..', 'vendor', 'python'))
      ? join(__dirname, '..', 'vendor', 'python')
      : null,
    network: 'none',
  });

  // 容器以 nobody 运行，而 mkdtemp 建出来的是 0700
  await chmod(dir, 0o755);

  try {
    const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn('docker', args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        if (code === 0) resolvePromise(out);
        else rejectPromise(new Error(`docker run 退出码 ${code}: ${err.trim().slice(-400)}`));
      });
    });

    const line = stdout.split('\n').reverse().find((l) => l.startsWith('__FF_RESULT__'));
    assert.ok(line, `容器未返回结果标记，输出: ${stdout.slice(-300)}`);
    const result = JSON.parse(line!.slice('__FF_RESULT__'.length));

    assert.deepEqual(
      result.host_files_readable, [],
      `容器内读到了宿主文件，隔离失效: ${JSON.stringify(result.host_files_readable)}`,
    );
    assert.equal(result.network, 'blocked', '--network=none 下不应能建立连接');
    assert.equal(result.root_writable, false, '--read-only 下根目录不应可写');
    assert.equal(result.tmp_writable, true, '/tmp 应可写（tmpfs），否则正常用法被误伤');
    assert.deepEqual(result.credential_env, [], `容器内不应有凭据类环境变量: ${JSON.stringify(result.credential_env)}`);
    assert.notEqual(result.uid, 0, '不应以 root 运行');

    console.log(
      `  真实容器隔离验证通过：宿主文件不可读 / 网络 ${result.network} / 根目录只读 / `
      + `/tmp 可写 / 凭据环境变量 0 个 / uid=${result.uid}`,
    );
    return true;
  } finally {
    // 兜底：容器没自行退出就删掉，别留垃圾
    spawnSync('docker', ['rm', '-f', containerName], { timeout: 15_000, windowsHide: true });
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  assertModeParsing();
  assertMountPath();
  assertHardeningArgs();
  assertVendorMounts();
  console.log('  参数断言通过：模式解析 / 挂载路径 / 加固项齐全 / 工作目录只读 / 依赖挂载');

  if (!dockerAvailable()) {
    console.log('  跳过真实容器验证：本机没有可用的 Docker（参数断言已覆盖加固项的存在性）');
  } else if (!imageAvailable(IMAGE)) {
    console.log(`  跳过真实容器验证：镜像 ${IMAGE} 不在本地（先 docker pull ${IMAGE}）`);
  } else {
    await assertRealIsolation();
  }

  console.log(
    'python 容器沙箱测试通过: 模式解析回落 / 挂载路径转义 / 加固项齐全 / 工作目录只读 / '
    + '依赖目录只读挂载与 PYTHONPATH / 真实容器隔离验证',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
