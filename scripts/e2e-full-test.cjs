#!/usr/bin/env node
/**
 * futureFlow 端到端全自动测试脚本
 * 
 * 功能：
 * 1. 启动 Docker 容器
 * 2. 等待 Dify 就绪
 * 3. 自动创建管理员、应用、API Key
 * 4. 启动网关服务
 * 5. 模拟 UI 点击测试
 * 6. 接口测试直到全部通过
 * 
 * 用法：node scripts/e2e-full-test.cjs
 */

const { spawn, spawnSync, execSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const net = require('node:net');

const randomSecret = () => randomBytes(32).toString('hex');
const SKIP_UI = process.argv.includes('--skip-ui');

function loadExistingEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

// Reuse the deployment's existing credentials and encryption keys. Explicit
// environment variables still win, while missing values are generated below.
loadExistingEnv();

// ==================== 配置 ====================
const CONFIG = {
  // 服务端口
  DIFY_API_PORT: 5001,
  DIFY_WEB_PORT: 8080,
  GATEWAY_PORT: 3201,
  FRONTEND_PORT: 3200,
  
  // Dify 配置
  DIFY_API_BASE: 'http://localhost:5001',
  DIFY_CONSOLE_BASE: 'http://localhost:5001/console/api',
  ADMIN_EMAIL: process.env.DIFY_ADMIN_EMAIL || 'admin-e2e@futureflow.local',
  ADMIN_PASSWORD: process.env.DIFY_ADMIN_PASSWORD || randomSecret(),
  APP_NAME: 'futureFlow Bridge',
  
  // LLM 配置
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_API_HOST: process.env.LLM_API_HOST || 'https://api.longcat.chat/openai',
  
  // 网关配置
  GATEWAY_JWT_SECRET: 'e2e-test-secret-key-for-testing-only',
  GATEWAY_ADMIN_USERNAME:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME || 'futureflow-e2e-admin',
  GATEWAY_ADMIN_EMAIL:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL || 'futureflow-e2e-admin@futureflow.test',
  GATEWAY_ADMIN_PASSWORD:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD ||
    'futureflow-e2e-admin-secret-2026-08-09-strong',
  DIFY_KEY_ENCRYPTION_SECRET: 'e2e-encryption-secret-that-is-long-enough-1234567890',
  DIFY_SECRET_KEY: process.env.DIFY_SECRET_KEY || randomSecret(),
  DIFY_SANDBOX_API_KEY: process.env.DIFY_SANDBOX_API_KEY || randomSecret(),
  
  // 重试配置
  MAX_RETRIES: 30,
  RETRY_INTERVAL: 3000,
  DIFY_MAX_WAIT: 120000, // Dify 启动较慢，最多等 2 分钟
};

// ==================== 工具函数 ====================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseSseEvents(body) {
  return String(body)
    .split(/\r?\n\r?\n/)
    .map((message) => message
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim())
    .filter(Boolean)
    .map((jsonText) => JSON.parse(jsonText));
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => {
      reject(new Error(`E2E port ${port} is already in use; stop the process you own on that port and retry.`));
    });
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

function stopOwnedProcess(child, name) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      if (result.error) throw result.error;
      if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
        throw new Error(`taskkill exited with status ${result.status}`);
      }
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
    log('info', `${name} process stopped`);
  } catch (error) {
    try {
      child.kill('SIGTERM');
    } catch {}
    log('warn', `Could not stop the complete ${name} process tree: ${error.message}`);
  }
}

function log(level, message) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const colors = {
    info: '\x1b[36m',   // cyan
    success: '\x1b[32m', // green
    warn: '\x1b[33m',    // yellow
    error: '\x1b[31m',   // red
    reset: '\x1b[0m',
  };
  const prefix = { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' };
  console.log(`${colors[level]}[${timestamp}] ${prefix[level]} ${message}${colors.reset}`);
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const { cwd, env, timeout = 60000 } = options;
    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (options.verbose) process.stdout.write(data);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (options.verbose) process.stderr.write(data);
    });
    
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
    }, timeout);
    
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}: ${command}\n${stderr}`));
      }
    });
    
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForService(url, name, maxWait = 60000) {
  const start = Date.now();
  let lastError = null;
  
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(url, { 
        signal: AbortSignal.timeout(5000),
        method: 'GET'
      });
      if (response.ok) {
        log('success', `${name} is ready at ${url}`);
        return true;
      }
    } catch (err) {
      lastError = err.message;
    }
    await sleep(2000);
  }
  
  throw new Error(`${name} did not become ready within ${maxWait}ms. Last error: ${lastError}`);
}

// ==================== 步骤 1: 启动容器 ====================
async function step1_startContainers() {
  log('info', 'Step 1: Starting Docker containers...');
  
  // 检查 Docker 是否可用
  try {
    execSync('docker --version', { stdio: 'pipe' });
  } catch {
    throw new Error('Docker is not available. Please install Docker first.');
  }
  
  // 停止旧容器（如果存在）
  try {
    await runCommand('docker compose down --remove-orphans', { timeout: 30000 });
    log('info', 'Cleaned up old containers');
  } catch {
    log('warn', 'No old containers to clean up');
  }
  
  // 启动容器
  log('info', 'Starting containers with docker compose up -d...');
  await runCommand('docker compose up -d', { timeout: 120000, verbose: true });
  
  // 等待 PostgreSQL
  await waitForService('http://localhost:5432', 'PostgreSQL', 30000).catch(() => {
    log('warn', 'PostgreSQL health check via HTTP failed, checking via docker...');
  });
  
  // 等待 Dify API
  await waitForService(`${CONFIG.DIFY_API_BASE}/health`, 'Dify API', CONFIG.DIFY_MAX_WAIT);
  
  log('success', 'All containers started successfully');
}

// ==================== 步骤 2: 初始化 Dify ====================
async function step2_initDify() {
  log('info', 'Step 2: Initializing Dify (create admin, app, API key)...');
  
  // 尝试创建管理员
  let adminCreated = false;
  try {
    const setupRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: CONFIG.ADMIN_EMAIL,
        password: CONFIG.ADMIN_PASSWORD,
        name: 'Admin'
      })
    });
    const setupData = await setupRes.json();
    if (setupRes.ok && setupData.result === 'success') {
      log('success', 'Admin account created successfully');
      adminCreated = true;
    } else {
      log('info', `Admin setup: ${setupData.message || 'already exists'}`);
    }
  } catch (err) {
    log('warn', `Admin setup attempt: ${err.message}`);
  }
  
  // 登录获取 token
  log('info', 'Logging in to Dify Console...');
  const loginRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CONFIG.ADMIN_EMAIL,
      password: CONFIG.ADMIN_PASSWORD
    })
  });
  const loginData = await loginRes.json();
  if (!loginData.data?.access_token) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const token = loginData.data.access_token;
  log('success', 'Login successful');
  
  // 查找或创建应用
  let appId = null;
  try {
    const appsRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/apps?page=1&limit=50`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const appsData = await appsRes.json();
    if (appsData.data) {
      const existing = appsData.data.find(app => app.name === CONFIG.APP_NAME);
      if (existing) {
        appId = existing.id;
        log('info', `Found existing app: ${appId}`);
      }
    }
  } catch (err) {
    log('warn', `Could not list apps: ${err.message}`);
  }
  
  if (!appId) {
    const createRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: CONFIG.APP_NAME, mode: 'workflow' })
    });
    const createData = await createRes.json();
    appId = createData.id;
    if (!appId) throw new Error(`Failed to create app: ${JSON.stringify(createData)}`);
    log('success', `App created: ${appId}`);
  }
  
  // 获取或创建 API Key
  let apiKey = null;
  try {
    const keysRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/apps/${appId}/api-keys`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const keysData = await keysRes.json();
    if (keysData.data && keysData.data.length > 0) {
      apiKey = keysData.data[0].token;
      log('info', 'Using existing API key');
    }
  } catch (err) {
    log('warn', `Could not list API keys: ${err.message}`);
  }
  
  if (!apiKey) {
    const keyRes = await fetch(`${CONFIG.DIFY_CONSOLE_BASE}/apps/${appId}/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    const keyData = await keyRes.json();
    apiKey = keyData.token;
    if (!apiKey) throw new Error(`Failed to create API key: ${JSON.stringify(keyData)}`);
    log('success', 'API key created');
  }
  
  // 更新 .env 文件
  updateEnvFile({
    DIFY_API_KEY: apiKey,
    DIFY_APP_ID: appId,
    DIFY_CONSOLE_TOKEN: token,
    DIFY_AUTO_BOOTSTRAP: 'true',
    DIFY_KEY_ENCRYPTION_SECRET: CONFIG.DIFY_KEY_ENCRYPTION_SECRET,
    DIFY_ADMIN_EMAIL: CONFIG.ADMIN_EMAIL,
    DIFY_ADMIN_PASSWORD: CONFIG.ADMIN_PASSWORD,
    DIFY_SECRET_KEY: CONFIG.DIFY_SECRET_KEY,
    DIFY_SANDBOX_API_KEY: CONFIG.DIFY_SANDBOX_API_KEY,
  });
  
  log('success', 'Dify initialization complete');
  return { appId, apiKey, token };
}

function updateEnvFile(updates) {
  const envPath = resolve(process.cwd(), '.env');
  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const newline = env.includes('\r\n') ? '\r\n' : '\n';
  
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    if (new RegExp(`^${key}=`, 'm').test(env)) {
      env = env.replace(new RegExp(`^${key}=.*`, 'm'), line);
    } else {
      env += `${newline}${line}${newline}`;
    }
  }
  
  writeFileSync(envPath, env);
  log('info', 'Updated .env with new configuration');
}

// ==================== 步骤 3: 启动网关 ====================
async function step3_startGateway() {
  log('info', 'Step 3: Starting gateway service...');
  await assertPortAvailable(CONFIG.GATEWAY_PORT);
  
  // E2E 不隐式修改依赖树；依赖必须由调用方预先安装。
  const gatewayDir = resolve(process.cwd(), 'gateway');
  if (!existsSync(resolve(gatewayDir, 'node_modules'))) {
    throw new Error('Gateway dependencies are missing; run corepack pnpm install --frozen-lockfile first.');
  }
  
  // 构建网关
  log('info', 'Building gateway...');
  await runCommand('corepack pnpm --filter futureflow-gateway build', { timeout: 120000 });
  
  // 启动网关（后台）
  log('info', 'Starting gateway server...');
  const gatewayProcess = spawn('node', ['dist/src/main.js'], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      GATEWAY_PORT: String(CONFIG.GATEWAY_PORT),
      GATEWAY_JWT_SECRET: CONFIG.GATEWAY_JWT_SECRET,
      GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'true',
      GATEWAY_BOOTSTRAP_ADMIN_USERNAME: CONFIG.GATEWAY_ADMIN_USERNAME,
      GATEWAY_BOOTSTRAP_ADMIN_EMAIL: CONFIG.GATEWAY_ADMIN_EMAIL,
      GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: CONFIG.GATEWAY_ADMIN_PASSWORD,
      DIFY_KEY_ENCRYPTION_SECRET: CONFIG.DIFY_KEY_ENCRYPTION_SECRET,
      DIFY_AUTO_BOOTSTRAP: 'true',
      NODE_ENV: 'production',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  
  gatewayProcess.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output.includes('started')) {
      log('info', `Gateway: ${output}`);
    }
  });
  
  gatewayProcess.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (/error/i.test(output)) {
      log('error', `Gateway error: ${output}`);
    }
  });
  
  gatewayProcess.unref();
  
  // 等待网关就绪
  await waitForService(`http://localhost:${CONFIG.GATEWAY_PORT}/healthz`, 'Gateway', 30000);
  log('success', 'Gateway started successfully');
  
  return gatewayProcess;
}

// ==================== UI 前端：由本次 E2E 独占启动 ====================
async function startFrontendForUi() {
  log('info', 'Starting the current frontend source for UI verification...');
  await assertPortAvailable(CONFIG.FRONTEND_PORT);

  const frontendDir = resolve(process.cwd(), 'demo-free-layout');
  const rsbuildCli = resolve(
    frontendDir,
    'node_modules',
    '@rsbuild',
    'core',
    'bin',
    'rsbuild.js',
  );
  if (!existsSync(rsbuildCli)) {
    throw new Error(
      'Frontend dependencies are missing; run corepack pnpm install --frozen-lockfile first.',
    );
  }

  let outputTail = '';
  let spawnError = null;
  const rememberOutput = (data) => {
    outputTail = `${outputTail}${data.toString()}`.slice(-6000);
  };

  const frontendProcess = spawn(
    process.execPath,
    [rsbuildCli, 'dev', '--host', '127.0.0.1', '--port', String(CONFIG.FRONTEND_PORT)],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        FRONTEND_PORT: String(CONFIG.FRONTEND_PORT),
        PUBLIC_GATEWAY_URL: `http://127.0.0.1:${CONFIG.GATEWAY_PORT}`,
        MODE: 'app',
        NODE_ENV: 'development',
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    },
  );
  frontendProcess.stdout.on('data', rememberOutput);
  frontendProcess.stderr.on('data', rememberOutput);
  frontendProcess.on('error', (error) => {
    spawnError = error;
  });
  frontendProcess.unref();

  const frontendUrl = `http://127.0.0.1:${CONFIG.FRONTEND_PORT}/login`;
  const startedAt = Date.now();
  let lastError = 'not reachable yet';

  try {
    while (Date.now() - startedAt < 60000) {
      if (spawnError) throw spawnError;
      if (frontendProcess.exitCode !== null || frontendProcess.signalCode !== null) {
        throw new Error(
          `Frontend exited before becoming ready (exit ${frontendProcess.exitCode ?? frontendProcess.signalCode})`,
        );
      }

      let response = null;
      try {
        response = await fetch(frontendUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
      } catch (error) {
        lastError = error.message;
      }

      if (response?.ok) {
        const html = await response.text();
        if (!/<title[^>]*>\s*futureFlow\s*<\/title>/i.test(html)) {
          throw new Error(
            `Unexpected page responded at ${frontendUrl}; refusing to test an unknown frontend`,
          );
        }
        log('success', `Frontend is ready at ${frontendUrl}`);
        return frontendProcess;
      }
      if (response) lastError = `HTTP ${response.status}`;
      await sleep(500);
    }

    throw new Error(`Frontend did not become ready within 60000ms. Last error: ${lastError}`);
  } catch (error) {
    stopOwnedProcess(frontendProcess, 'Frontend');
    const details = outputTail.trim();
    throw new Error(details ? `${error.message}\nFrontend output:\n${details}` : error.message);
  }
}

// ==================== 步骤 4: API 接口测试 ====================
async function step4_apiTests() {
  log('info', 'Step 4: Running API endpoint tests...');
  
  const BASE_URL = `http://localhost:${CONFIG.GATEWAY_PORT}`;
  const results = [];
  
  // 测试 1: 健康检查
  await runTest('GET /healthz', async () => {
    const res = await fetch(`${BASE_URL}/healthz`);
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 2: 管理员登录
  let adminToken = null;
  await runTest('POST /auth/login (admin)', async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: CONFIG.GATEWAY_ADMIN_USERNAME,
        password: CONFIG.GATEWAY_ADMIN_PASSWORD,
      })
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const data = await res.json();
    if (!data.accessToken) throw new Error('No access token returned');
    if (data.user?.role !== 'admin') throw new Error('User is not admin');
    adminToken = data.accessToken;
    return data;
  }, results);
  
  // 测试 3: 获取用户资料
  await runTest('GET /auth/profile', async () => {
    const res = await fetch(`${BASE_URL}/auth/profile`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 4: 获取仪表盘统计
  await runTest('GET /admin/stats', async () => {
    const res = await fetch(`${BASE_URL}/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 5: 获取 Dify 状态
  await runTest('GET /admin/dify/status', async () => {
    const res = await fetch(`${BASE_URL}/admin/dify/status`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 6: 创建 API Key
  let apiKey = null;
  let apiKeyId = null;
  await runTest('POST /user/api-keys', async () => {
    const res = await fetch(`${BASE_URL}/user/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'e2e-test-key' })
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const data = await res.json();
    if (!data.plaintext) throw new Error('No API key returned');
    if (!data.id) throw new Error('No API key ID returned');
    apiKey = data.plaintext;
    apiKeyId = data.id;
    return data;
  }, results);
  
  // 测试 7: 创建工作流
  let workflowId = null;
  await runTest('POST /workflows', async () => {
    const workflowJson = {
      nodes: [
        {
          id: 'start_0',
          type: 'start',
          data: {
            title: 'Start',
            outputs: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
        {
          id: 'llm_0',
          type: 'llm',
          data: {
            title: 'LLM',
            inputsValues: {
              modelName: { type: 'constant', content: 'deepseek-chat' },
              prompt: { type: 'template', content: '{{start_0.query}}' },
            },
          },
        },
        { id: 'end_0', type: 'end', data: { title: 'End' } },
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
        { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
      ],
    };
    
    const res = await fetch(`${BASE_URL}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'E2E Test Workflow', flowgram: JSON.stringify(workflowJson) })
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const data = await res.json();
    if (!data.id) throw new Error('No workflow ID returned');
    workflowId = data.id;
    return data;
  }, results);
  
  // 测试 8: 发布工作流
  await runTest('POST /workflows/:id/publish', async () => {
    const res = await fetch(`${BASE_URL}/workflows/${workflowId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const data = await res.json();
    if (!data.workflow?.publishedVersion) throw new Error('Workflow not published');
    return data;
  }, results);
  
  // 测试 9: 执行工作流（使用 API Key）
  await runTest('POST /workflows/:id/execute', async () => {
    const res = await fetch(`${BASE_URL}/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs: { query: 'Hello from E2E test' } })
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const text = await res.text();
    const events = parseSseEvents(text);
    const finished = events.find((event) => event.event === 'workflow_finished');
    if (!finished) throw new Error('Workflow stream ended without workflow_finished');
    if (finished.data?.status !== 'succeeded') {
      throw new Error(`Workflow failed: ${finished.data?.error || finished.data?.status || 'unknown'}`);
    }
    const failedNode = events.find(
      (event) => event.event === 'node_finished' && event.data?.status !== 'succeeded',
    );
    if (failedNode) throw new Error(`Node failed: ${failedNode.data?.title || failedNode.data?.node_id}`);
    return { completed: true, events: events.length, totalSteps: finished.data?.total_steps };
  }, results);
  
  // 测试 10: 获取工作流运行记录
  await runTest('GET /workflows/:id/runs', async () => {
    const res = await fetch(`${BASE_URL}/workflows/${workflowId}/runs`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    const data = await res.json();
    if (data.total < 1) throw new Error('No runs recorded');
    return data;
  }, results);
  
  // 测试 11: 获取工作流列表
  await runTest('GET /workflows', async () => {
    const res = await fetch(`${BASE_URL}/workflows`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 12: 更新工作流
  await runTest('PUT /workflows/:id', async () => {
    const workflowJson = {
      nodes: [
        { id: 'start_0', type: 'start', data: { title: 'Start' } },
        { id: 'end_0', type: 'end', data: { title: 'End' } },
      ],
      edges: [{ sourceNodeID: 'start_0', targetNodeID: 'end_0' }],
    };
    
    const res = await fetch(`${BASE_URL}/workflows/${workflowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Updated E2E Workflow', flowgram: JSON.stringify(workflowJson) })
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 13: 删除 API Key
  await runTest('DELETE /user/api-keys/:id', async () => {
    const res = await fetch(`${BASE_URL}/user/api-keys/${apiKeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 14: 删除工作流
  await runTest('DELETE /workflows/:id', async () => {
    const res = await fetch(`${BASE_URL}/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  // 测试 15: 获取用户列表
  await runTest('GET /admin/users', async () => {
    const res = await fetch(`${BASE_URL}/admin/users?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Status: ${res.status}`);
    return await res.json();
  }, results);
  
  return results;
}

async function runTest(name, testFn, results) {
  const start = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - start;
    results.push({ name, status: 'PASS', duration, result });
    log('success', `${name} - PASSED (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    results.push({ name, status: 'FAIL', duration, error: err.message });
    log('error', `${name} - FAILED (${duration}ms): ${err.message}`);
  }
}

function findBrowserExecutable(playwright) {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    playwright.chromium.executablePath(),
    ...(process.platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
      : process.platform === 'darwin'
        ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
        : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ]),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

// ==================== 步骤 5: UI 模拟测试 ====================
async function step5_uiTests() {
  log('info', 'Step 5: Running UI simulation tests...');
  
  // UI 验收默认是全链路门禁；只有显式 --skip-ui 才能跳过。
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    throw new Error(
      'UI 验收依赖 playwright-core，请先按锁文件安装项目依赖。',
    );
  }
  const executablePath = findBrowserExecutable(playwright);
  if (!executablePath) {
    throw new Error(
      '未找到可用于 UI 验收的 Chrome/Edge/Chromium；可通过 PLAYWRIGHT_EXECUTABLE_PATH 指定浏览器。',
    );
  }
  
  const results = [];
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    // 测试 1: 访问登录页
    await runUITest('Navigate to login page', async () => {
      await page.goto(`http://127.0.0.1:${CONFIG.FRONTEND_PORT}/login`, { waitUntil: 'networkidle' });
      const title = await page.title();
      if (!title) throw new Error('Page has no title');
      return { title };
    }, results);
    
    // 测试 2: 填写登录表单
    await runUITest('Fill login form', async () => {
      await page.fill(
        'input[name="account"], input[placeholder*="用户名"], input[placeholder*="账号"]',
        CONFIG.GATEWAY_ADMIN_USERNAME,
      );
      await page.fill(
        'input[name="password"], input[type="password"]',
        CONFIG.GATEWAY_ADMIN_PASSWORD,
      );
      return { filled: true };
    }, results);
    
    // 测试 3: 点击登录按钮
    await runUITest('Click login button', async () => {
      await page.click('button[type="submit"], button:has-text("登录"), button:has-text("Login")');
      await page.waitForURL('**/workflows', { timeout: 10000 });
    }, results);
    
    // 测试 4: 验证登录成功（检查页面内容）
    await runUITest('Verify login success', async () => {
      const content = await page.content();
      if (content.includes('登录') && content.includes('密码')) {
        // 可能还在登录页
        const url = page.url();
        if (url.includes('login')) throw new Error('Still on login page');
      }
      return { url: page.url() };
    }, results);
    
    // 测试 5: 导航到管理员页面
    await runUITest('Navigate to admin page', async () => {
      await page.click('a[href="/admin"], button:has-text("管理"), span:has-text("管理")');
      await page.waitForSelector('text=管理员后台', { timeout: 5000 });
    }, results);
    
    // 测试 6: 检查仪表盘
    await runUITest('Check dashboard', async () => {
      const content = await page.content();
      if (!content.includes('仪表盘') && !content.includes('Dashboard')) {
        throw new Error('Dashboard not found');
      }
      return { hasDashboard: true };
    }, results);
    
    // 测试 7: 切换到用户管理
    await runUITest('Switch to users tab', async () => {
      await page.click('text=用户管理');
      await page.waitForSelector('table', { timeout: 5000 });
    }, results);
    
    // 测试 8: 切换到 Dify 状态
    await runUITest('Check Dify status', async () => {
      await page.click('text=Dify');
      await page.waitForTimeout(1000);
      const content = await page.content();
      const hasDifyInfo = content.includes('Dify') || content.includes('dify');
      if (!hasDifyInfo) throw new Error('Dify status information not found');
      return { hasDifyInfo: true };
    }, results);
    
  } finally {
    await browser.close();
  }
  
  return results;
}

async function runUITest(name, testFn, results) {
  const start = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - start;
    results.push({ name, status: 'PASS', duration, result });
    log('success', `${name} - PASSED (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    results.push({ name, status: 'FAIL', duration, error: err.message });
    log('error', `${name} - FAILED (${duration}ms): ${err.message}`);
  }
}

// ==================== 主流程 ====================
async function main() {
  log('info', '========================================');
  log('info', 'futureFlow E2E Full Test Starting...');
  log('info', '========================================');
  
  const startTime = Date.now();
  let gatewayProcess = null;
  let frontendProcess = null;

  if (!CONFIG.LLM_API_KEY) {
    throw new Error('LLM_API_KEY is required for the full end-to-end test');
  }
  Object.assign(process.env, {
    DIFY_ADMIN_EMAIL: CONFIG.ADMIN_EMAIL,
    DIFY_ADMIN_PASSWORD: CONFIG.ADMIN_PASSWORD,
    DIFY_SECRET_KEY: CONFIG.DIFY_SECRET_KEY,
    DIFY_SANDBOX_API_KEY: CONFIG.DIFY_SANDBOX_API_KEY,
  });
  
  try {
    // Fail fast instead of silently reusing an unrelated process on the UI port.
    if (!SKIP_UI) await assertPortAvailable(CONFIG.FRONTEND_PORT);

    // Step 1: 启动容器
    await step1_startContainers();
    
    // Step 2: 初始化 Dify
    const { appId, apiKey, token } = await step2_initDify();
    log('info', `Dify App ID: ${appId}`);
    log('info', 'Dify Service API key created');
    
    // Step 3: 启动网关
    gatewayProcess = await step3_startGateway();
    
    // Step 4: API 测试
    const apiResults = await step4_apiTests();
    
    // Step 5: UI 测试。只允许调用方显式选择 API-only 模式。
    if (!SKIP_UI) frontendProcess = await startFrontendForUi();
    const uiResults = SKIP_UI ? null : await step5_uiTests();
    if (SKIP_UI) log('warn', 'UI tests explicitly skipped by --skip-ui (API-only mode)');
    
    // 汇总结果
    const totalTime = Date.now() - startTime;
    const apiPassed = apiResults.filter(r => r.status === 'PASS').length;
    const apiTotal = apiResults.length;
    const uiPassed = uiResults?.filter(r => r.status === 'PASS').length || 0;
    const uiTotal = uiResults?.length || 0;
    
    log('info', '========================================');
    log('info', 'TEST RESULTS SUMMARY');
    log('info', '========================================');
    log('info', `API Tests:  ${apiPassed}/${apiTotal} passed`);
    if (uiResults === null) {
      log('warn', 'UI Tests:   skipped explicitly');
    } else {
      log('info', `UI Tests:   ${uiPassed}/${uiTotal} passed`);
    }
    log('info', `Total Time: ${(totalTime / 1000).toFixed(1)}s`);
    
    if (apiPassed === apiTotal && (uiResults === null || (uiTotal > 0 && uiPassed === uiTotal))) {
      log('success', uiResults === null ? 'API TESTS PASSED (UI skipped explicitly)' : 'ALL TESTS PASSED! ✨');
      return 0;
    } else {
      log('error', 'SOME TESTS FAILED');
      return 1;
    }
    
  } catch (err) {
    log('error', `Fatal error: ${err.message}`);
    console.error(err.stack);
    return 1;
  } finally {
    // 清理
    if (frontendProcess) stopOwnedProcess(frontendProcess, 'Frontend');
    if (gatewayProcess) {
      stopOwnedProcess(gatewayProcess, 'Gateway');
    }
  }
}

// 运行
main().then(code => process.exit(code)).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
