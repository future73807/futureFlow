const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const net = require('node:net');
const { composeInvocation, composeShellCommand, describeCompose } = require('./lib/docker-compose.cjs');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * 把 compose 参数解析成本机可用的调用形式。
 *
 * 不能写死 `docker compose`：插件缺失的机器上会报
 * `docker: unknown command: docker compose`，看起来像命令敲错，实际是环境缺插件
 * （本机就是这样，`docker info` 的插件列表里只有 dhi）。探测与回退见
 * scripts/lib/docker-compose.cjs。
 */
function resolveDockerArgs(args) {
  return args[0] === 'compose'
    ? composeInvocation(args.slice(1))
    : { command: 'docker', args };
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const outcome = result.status === null
      ? `signal ${result.signal || 'unknown'}`
      : `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed with ${outcome}`);
  }
}

/**
 * 跑一条 compose 命令，前缀按本机情况解析（`docker compose` 或 `docker-compose`）。
 *
 * 刻意**不**写成 `run('docker', ['compose', ...])`：那样在源码里看起来仍是写死的
 * 插件形式，scripts/test-docker-compose.cjs 的静态防回归检查无法与真正的写死区分，
 * 只能放行整类写法、失去意义。
 */
function runCompose(args, env) {
  const { command, args: resolved } = composeInvocation(args);
  run(command, resolved, env);
}

function resolveConfiguredPath(environment, name, fallback) {
  return resolve(process.cwd(), environment[name]?.trim() || fallback);
}

function parseEnvContent(content) {
  const parsed = {};
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = parseEnvValue(match[2]);
    parsed[match[1]] = value;
  }
  return parsed;
}

function parseEnvValue(source) {
  const value = source.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== quote || value[index - 1] === '\\') continue;
      const trailing = value.slice(index + 1).trim();
      if (!trailing || trailing.startsWith('#')) {
        return value.slice(1, index);
      }
    }
    return value;
  }

  const comment = value.search(/\s+#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trimEnd();
}

function loadEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    throw new Error(`Environment file was not created: ${envFilePath}`);
  }
  return parseEnvContent(readFileSync(envFilePath, 'utf8'));
}

function buildChildEnvironment(explicitEnvironment, envFilePath, overrides = {}) {
  // The shell remains authoritative. This also lets CI deliberately override
  // a generated local value without rewriting the selected env file.
  return {
    ...loadEnvFile(envFilePath),
    ...explicitEnvironment,
    ...overrides,
  };
}

function captureDocker(args, env) {
  const resolved = resolveDockerArgs(args);
  // 刻意**不加** shell：Windows 上 shell 模式会把参数拼成一条命令行交给 cmd，
  // Node 不会替我们加引号，于是 `--format '{{json .State}}'` 里的空格被拆成两个
  // 参数，docker 报 `template parsing error: unclosed action` —— 健康检查会因此
  // 永远读不到 Health 字段、一直等到超时。实测确认过。
  return spawnSync(resolved.command, resolved.args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function runningPostgresPort(env) {
  const result = captureDocker(['compose', 'port', 'postgres', '5432'], env);
  if (result.status !== 0) return '';

  // Compose may return IPv4 and IPv6 bindings. Reuse the first published host
  // port from the active Compose project/file context so a second start never
  // recreates that database on another port.
  const match = result.stdout.match(/:(\d+)\s*(?:\r?\n|$)/);
  return match?.[1] || '';
}

async function choosePostgresPort(explicitEnvironment, env) {
  if (explicitEnvironment.POSTGRES_PORT) return explicitEnvironment.POSTGRES_PORT;
  const existingPort = runningPostgresPort(env);
  if (existingPort) return existingPort;
  const configuredPort = env.POSTGRES_PORT?.trim();
  // Keep the historical auto-fallback for the generated default 5432, while
  // respecting a non-default port selected in a custom env file.
  if (configuredPort && configuredPort !== '5432') return configuredPort;
  if (await isPortFree(5432)) return '5432';
  for (let port = 5433; port <= 5450; port += 1) {
    if (await isPortFree(port)) return String(port);
  }
  throw new Error('No free local PostgreSQL port found between 5432 and 5450. Set POSTGRES_PORT explicitly.');
}

function persistRuntimePostgresPort(port, runtimeEnvPath) {
  // Keep command-line migrations and later gateway restarts aligned with the
  // port selected by this starter, without rewriting user-managed .env.
  mkdirSync(dirname(runtimeEnvPath), { recursive: true });
  writeFileSync(
    runtimeEnvPath,
    `# Generated by pnpm start. Do not commit.\nPOSTGRES_PORT=${port}\n`,
    { mode: 0o600 },
  );
}

function composeContainerIds(serviceName, env) {
  const result = captureDocker(
    ['compose', 'ps', '--all', '--quiet', serviceName],
    env,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to resolve the ${serviceName} container in the active Compose context: `
      + (result.stderr || `exit code ${result.status}`).trim(),
    );
  }
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function containerState(containerId, env) {
  const result = captureDocker(
    ['inspect', '--format', '{{json .State}}', containerId],
    env,
  );
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

async function waitForHealth(serviceName, env, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containerIds = composeContainerIds(serviceName, env);
    const states = containerIds.map((containerId) => ({
      containerId,
      state: containerState(containerId, env),
    }));
    if (
      states.length > 0
      && states.every(({ state }) => state?.Health?.Status === 'healthy')
    ) return;

    for (const { containerId, state } of states) {
      const label = `${serviceName} (${containerId.slice(0, 12)})`;
      const logsHint = `Inspect it with: ${composeShellCommand(['logs', serviceName])}`;
      if (state?.Status === 'exited' || state?.Status === 'dead') {
        const exitCode = Number.isInteger(state.ExitCode) ? ` (exit code ${state.ExitCode})` : '';
        throw new Error(
          `${label} ${state.Status}${exitCode} before becoming healthy. ` + logsHint,
        );
      }
      if (state?.Status === 'restarting' || state?.Status === 'paused') {
        throw new Error(
          `${label} entered state ${state.Status} before becoming healthy. ` + logsHint,
        );
      }
      if (state?.Health?.Status === 'unhealthy') {
        throw new Error(`${label} became unhealthy. ` + logsHint);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `${serviceName} did not become healthy in time. `
    + `Inspect it with: ${composeShellCommand(['logs', serviceName])}`,
  );
}

function childProcessExitCode(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

async function main(args = process.argv.slice(2)) {
  const infrastructureOnly = args.includes('--infrastructure-only');
  const gatewayOnly = args.includes('--gateway-only');
  if (infrastructureOnly && gatewayOnly) {
    throw new Error('--infrastructure-only and --gateway-only cannot be used together');
  }

  const explicitEnvironment = { ...process.env };
  const envFilePath = resolveConfiguredPath(
    explicitEnvironment,
    'FUTUREFLOW_ENV_FILE',
    '.env',
  );
  const runtimeEnvPath = resolveConfiguredPath(
    explicitEnvironment,
    'FUTUREFLOW_RUNTIME_ENV_FILE',
    '.futureflow.runtime.env',
  );

  // Repair both Dify secrets for existing .env files before Compose resolves
  // the Sandbox/API shared key.
  run(process.execPath, ['scripts/init-env.cjs'], explicitEnvironment);
  let env = buildChildEnvironment(explicitEnvironment, envFilePath);
  const postgresPort = await choosePostgresPort(explicitEnvironment, env);
  persistRuntimePostgresPort(postgresPort, runtimeEnvPath);
  env = buildChildEnvironment(explicitEnvironment, envFilePath, {
    POSTGRES_PORT: postgresPort,
  });
  if (!explicitEnvironment.POSTGRES_PORT && postgresPort !== '5432') {
    console.log(`Host port 5432 is already in use; futureFlow PostgreSQL will use ${postgresPort}.`);
  }

  console.log('Starting the full futureFlow stack: PostgreSQL, Dify API/Worker/Web, Sandbox, SSRF Proxy, Redis, Weaviate, gateway, and canvas.');
  // 说明实际用的是哪一种 compose：插件缺失时静默回退到独立二进制，
  // 不打印的话排查「为什么用的不是我装的那个版本」会很费劲。
  console.log(`Using ${describeCompose()}`);
  runCompose(['up', '-d'], env);
  await waitForHealth('postgres', env, 90_000);
  await waitForHealth('ssrf_proxy', env, 90_000);
  await waitForHealth('sandbox', env, 90_000);
  await waitForHealth('dify-api', env, 600_000);
  
  // Run the one-shot initializer in the foreground. `run` does not return
  // until the container exits successfully, so Gateway can never read .env
  // while the Dify app/key update is still in flight.
  console.log('Running Dify auto-initialization...');
  runCompose([
    '--profile', 'bootstrap', 'run', '--rm', '--no-TTY',
    '--interactive=false', '--no-deps', 'dify-init',
  ], env);
  console.log('Dify initialization completed successfully.');

  // dify-init writes its bridge app/key only at the end. Reload the selected
  // file after the foreground barrier, while retaining shell precedence and
  // the runtime-selected PostgreSQL port.
  env = buildChildEnvironment(explicitEnvironment, envFilePath, {
    POSTGRES_PORT: postgresPort,
  });
  
  run(pnpm, ['--filter', 'futureflow-gateway', 'migration:run'], env);
  if (infrastructureOnly) {
    console.log('The full container stack is ready and futureFlow database migrations have completed.');
    return;
  }

  const childArgs = gatewayOnly
    ? ['--filter', 'futureflow-gateway', 'start:dev']
    : ['run', 'dev:concurrent'];
  if (gatewayOnly) {
    console.log('Infrastructure is ready; starting Gateway only.');
  }
  const child = spawn(pnpm, childArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const stop = (signal) => child.kill(signal);
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    console.error(`Failed to start futureFlow application services: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (!Number.isInteger(code)) {
      console.error(`futureFlow application services stopped by ${signal || 'an unknown signal'}`);
    }
    process.exit(childProcessExitCode(code, signal));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  buildChildEnvironment,
  childProcessExitCode,
  choosePostgresPort,
  composeContainerIds,
  // 导出给 scripts/test-docker-compose.cjs：`--format '{{json .State}}'` 这类
  // 带空格的模板参数一旦被 shell 模式拆开，健康检查会永远读不到 Health 字段、
  // 一路等到超时（实测踩过），需要真实探测把它挡住。
  containerState,
  loadEnvFile,
  main,
  parseEnvContent,
  parseEnvValue,
  persistRuntimePostgresPort,
  resolveConfiguredPath,
  // 导出给 scripts/test-docker-compose.cjs：验证 compose 前缀确实按本机情况解析，
  // 而不是写死 `docker compose`。
  resolveDockerArgs,
  runningPostgresPort,
  waitForHealth,
};
