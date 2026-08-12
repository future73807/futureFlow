#!/usr/bin/env node
/**
 * futureFlow 端到端全自动测试（带重试机制）
 * 
 * 功能：
 * 1. 启动 Docker 容器
 * 2. 等待 Dify 就绪
 * 3. 自动创建管理员、应用、API Key
 * 4. 发布工作流到 Dify
 * 5. 启动网关服务
 * 6. 模拟 UI 点击（通过 API 调用）
 * 7. 接口测试直到全部通过
 * 
 * 用法：node scripts/e2e-test-with-retry.cjs
 */

const { spawn, execSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const net = require('node:net');

const randomSecret = () => randomBytes(32).toString('hex');

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
  DIFY_API_BASE: 'http://localhost:5001',
  DIFY_CONSOLE_BASE: 'http://localhost:5001/console/api',
  GATEWAY_PORT: 3201,
  GATEWAY_URL: 'http://localhost:3201',
  GATEWAY_ADMIN_USERNAME:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME || 'futureflow-e2e-admin',
  GATEWAY_ADMIN_EMAIL:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL || 'futureflow-e2e-admin@futureflow.test',
  GATEWAY_ADMIN_PASSWORD:
    process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD ||
    'futureflow-e2e-admin-secret-2026-08-09-strong',
  ADMIN_EMAIL: process.env.DIFY_ADMIN_EMAIL || 'admin-e2e@futureflow.local',
  ADMIN_PASSWORD: process.env.DIFY_ADMIN_PASSWORD || randomSecret(),
  DIFY_SECRET_KEY: process.env.DIFY_SECRET_KEY || randomSecret(),
  DIFY_SANDBOX_API_KEY: process.env.DIFY_SANDBOX_API_KEY || randomSecret(),
  APP_NAME: 'futureFlow Bridge',
  MAX_RETRIES: 5,
  RETRY_DELAY: 5000,
  DIFY_MAX_WAIT: 180000,
};

// ==================== 工具函数 ====================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

function log(level, message) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
  const prefix = { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' };
  console.log(`${colors[level]}[${timestamp}] ${prefix[level]} ${message}${colors.reset}`);
}

// ==================== 参数处理 ====================
const CLEAN_MODE = process.argv.includes('--clean');

function httpRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, data: data, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function parseSseEvents(body) {
  const source = String(body).replace(/\r\n/g, '\n');
  if (!source.trim()) throw new Error('Workflow returned an empty SSE stream');
  const frames = source.split('\n\n');
  const trailing = frames.pop();
  if (trailing?.trim()) {
    throw new Error(`Workflow SSE stream was truncated: ${trailing.trim().slice(0, 120)}`);
  }

  return frames
    .map((frame) => frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim())
    .filter(Boolean)
    .map((jsonText) => {
      try {
        return JSON.parse(jsonText);
      } catch {
        throw new Error(`Workflow returned malformed SSE JSON: ${jsonText.slice(0, 120)}`);
      }
    });
}

// ==================== 步骤 1: 启动容器 ====================
async function step1_startContainers() {
  log('info', 'Step 1: Starting Docker containers...');
  
  if (CLEAN_MODE) {
    log('info', 'Clean mode: stopping containers and removing volumes...');
    try {
      execSync('docker compose down -v --remove-orphans', { stdio: 'pipe', timeout: 60000 });
      log('success', 'Old containers and volumes removed');
    } catch (err) {
      log('warn', 'No old containers to clean');
    }
  }
  
  try {
    execSync('docker compose up -d', { stdio: 'pipe', timeout: 120000 });
  } catch (err) {
    throw new Error(`Failed to start containers: ${err.message}`);
  }
  
  // 等待 Dify API
  const start = Date.now();
  while (Date.now() - start < CONFIG.DIFY_MAX_WAIT) {
    try {
      const res = await httpRequest('GET', `${CONFIG.DIFY_API_BASE}/health`);
      if (res.status === 200) {
        log('success', 'Dify API is ready');
        return;
      }
    } catch {}
    await sleep(3000);
  }
  throw new Error('Dify API did not become ready');
}

// ==================== 步骤 2: 初始化 Dify ====================
async function step2_initDify() {
  log('info', 'Step 2: Initializing Dify...');
  
  // 尝试创建管理员（如果是全新环境）
  try {
    const setupRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/setup`, {
      email: CONFIG.ADMIN_EMAIL,
      password: CONFIG.ADMIN_PASSWORD,
      name: 'Admin'
    });
    if (setupRes.data?.result === 'success') {
      log('success', 'Admin account created (fresh environment)');
    } else {
      log('info', 'Admin already exists, skipping setup');
    }
  } catch (err) {
    log('info', 'Admin setup skipped (may already exist)');
  }
  
  // 登录
  const loginRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/login`, {
    email: CONFIG.ADMIN_EMAIL,
    password: CONFIG.ADMIN_PASSWORD
  });
  const token = loginRes.data?.data?.access_token || loginRes.data?.access_token;
  if (!token) {
    throw new Error(`Login failed: ${JSON.stringify(loginRes.data)}`);
  }
  log('success', 'Login successful');
  
  // 查找应用
  let appId = null;
  const appsRes = await httpRequest('GET', `${CONFIG.DIFY_CONSOLE_BASE}/apps?page=1&limit=50`, null, {
    Authorization: `Bearer ${token}`
  });
  if (appsRes.data?.data) {
    const existing = appsRes.data.data.find(app => app.name === CONFIG.APP_NAME);
    if (existing) appId = existing.id;
  }
  
  // 创建应用
  if (!appId) {
    const createRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/apps`, {
      name: CONFIG.APP_NAME,
      mode: 'workflow'
    }, { Authorization: `Bearer ${token}` });
    appId = createRes.data.id;
    if (!appId) throw new Error('Failed to create app');
    log('success', `App created: ${appId}`);
  } else {
    log('info', `Using existing app: ${appId}`);
  }
  
  // 获取 API Key
  let apiKey = null;
  const keysRes = await httpRequest('GET', `${CONFIG.DIFY_CONSOLE_BASE}/apps/${appId}/api-keys`, null, {
    Authorization: `Bearer ${token}`
  });
  if (keysRes.data?.data?.length > 0) {
    apiKey = keysRes.data.data[0].token;
    log('info', `Using existing API key: ${apiKey.substring(0, 20)}...`);
  } else {
    const keyRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/apps/${appId}/api-keys`, {}, {
      Authorization: `Bearer ${token}`
    });
    apiKey = keyRes.data.token;
    log('success', 'Service API key created');
  }
  
  // 更新 .env
  updateEnv({
    DIFY_API_KEY: apiKey,
    DIFY_APP_ID: appId,
    DIFY_CONSOLE_TOKEN: token,
    DIFY_AUTO_BOOTSTRAP: 'true',
    DIFY_ADMIN_EMAIL: CONFIG.ADMIN_EMAIL,
    DIFY_ADMIN_PASSWORD: CONFIG.ADMIN_PASSWORD,
    DIFY_SECRET_KEY: CONFIG.DIFY_SECRET_KEY,
    DIFY_SANDBOX_API_KEY: CONFIG.DIFY_SANDBOX_API_KEY,
  });
  
  return { appId, apiKey, token };
}

function updateEnv(updates) {
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
  log('info', 'Updated .env');
}

// ==================== 步骤 3: 发布工作流 ====================
async function step3_publishWorkflow(token, appId) {
  log('info', 'Step 3: Publishing workflow to Dify...');
  
  const dsl = `app:
  mode: workflow
  version: 0.1.5
workflow:
  graph:
    nodes:
      - id: start_0
        type: start
        data:
          type: start
          title: Start
          outputs:
            - name: query
              type: string
      - id: llm_0
        type: llm
        data:
          type: llm
          title: LLM
          inputsValues:
            modelName:
              type: constant
              content: deepseek-chat
            prompt:
              type: template
              content: '{{start_0.query}}'
      - id: end_0
        type: end
        data:
          type: end
          title: End
    edges:
      - sourceNodeID: start_0
        targetNodeID: llm_0
      - sourceNodeID: llm_0
        targetNodeID: end_0`;

  // 导入 DSL
  const importRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/apps/imports`, {
    mode: 'yaml-content',
    yaml_content: dsl,
    app_id: appId
  }, { Authorization: `Bearer ${token}` });
  
  if (importRes.data?.error) {
    throw new Error(`Import failed: ${importRes.data.error}`);
  }
  log('info', 'Workflow DSL imported');
  
  // 发布
  const publishRes = await httpRequest('POST', `${CONFIG.DIFY_CONSOLE_BASE}/apps/${appId}/workflows/publish`, {}, {
    Authorization: `Bearer ${token}`
  });
  
  if (publishRes.data?.result !== 'success') {
    throw new Error(`Publish failed: ${JSON.stringify(publishRes.data)}`);
  }
  log('success', 'Workflow published');
}

// ==================== 步骤 4: 启动网关 ====================
async function step4_startGateway() {
  log('info', 'Step 4: Starting gateway...');
  
  const gatewayDir = resolve(process.cwd(), 'gateway');
  await assertPortAvailable(CONFIG.GATEWAY_PORT);
  
  // 运行数据库 migration（如果是全新环境）
  try {
    log('info', 'Running database migrations...');
    execSync('corepack pnpm run migration:run', { cwd: gatewayDir, stdio: 'pipe', timeout: 60000 });
    log('success', 'Database migrations completed');
  } catch (err) {
    log('warn', `Migration may have already run: ${err.message}`);
  }
  
  // 始终构建当前工作区，避免复用过期 dist。
  log('info', 'Building gateway...');
  execSync('corepack pnpm run build', { cwd: gatewayDir, stdio: 'pipe', timeout: 120000 });
  
  const child = spawn('node', ['dist/src/main.js'], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      GATEWAY_PORT: String(CONFIG.GATEWAY_PORT),
      GATEWAY_JWT_SECRET: 'e2e-test-jwt-secret-that-is-long-enough-1234567890',
      GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'true',
      GATEWAY_BOOTSTRAP_ADMIN_USERNAME: CONFIG.GATEWAY_ADMIN_USERNAME,
      GATEWAY_BOOTSTRAP_ADMIN_EMAIL: CONFIG.GATEWAY_ADMIN_EMAIL,
      GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: CONFIG.GATEWAY_ADMIN_PASSWORD,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref();
  
  // 等待就绪
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/healthz`);
      if (res.status === 200) {
        log('success', 'Gateway is ready');
        // 等待 seed 用户创建完成
        log('info', 'Waiting for seed user to be ready...');
        const loginStart = Date.now();
        while (Date.now() - loginStart < 30000) {
          try {
            const loginRes = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
              account: CONFIG.GATEWAY_ADMIN_USERNAME,
              password: CONFIG.GATEWAY_ADMIN_PASSWORD,
            });
            if (loginRes.status === 201) {
              log('success', 'Seed user is ready');
              return child;
            }
          } catch {}
          await sleep(2000);
        }
        log('warn', 'Seed user not ready, proceeding anyway');
        return child;
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error('Gateway did not start');
}

// ==================== 步骤 5: API 测试 ====================
async function step5_apiTests() {
  log('info', 'Step 5: Running API tests...');
  
  const results = [];
  let adminToken = null;
  let apiKey = null;
  let apiKeyId = null;
  let workflowId = null;
  
  // 测试 1: 健康检查
  await runTest('GET /healthz', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/healthz`);
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return res.data;
  }, results);
  
  // 测试 2: 管理员登录
  await runTest('POST /auth/login', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: CONFIG.GATEWAY_ADMIN_USERNAME,
      password: CONFIG.GATEWAY_ADMIN_PASSWORD,
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    if (res.data.user?.role !== 'admin') throw new Error('Not admin');
    adminToken = res.data.accessToken;
    return { role: res.data.user.role };
  }, results);
  
  // 测试 3: 获取资料
  await runTest('GET /auth/profile', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/auth/profile`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { username: res.data.username };
  }, results);
  
  // 测试 4: 仪表盘统计
  await runTest('GET /admin/stats', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/stats`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { users: res.data.userCount, workflows: res.data.workflowCount };
  }, results);
  
  // 测试 5: Dify 状态
  await runTest('GET /admin/dify/status', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/dify/status`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { status: res.data.status };
  }, results);
  
  // 测试 6: 创建 API Key
  await runTest('POST /user/api-keys', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/user/api-keys`, {
      name: `e2e-${Date.now()}`
    }, { Authorization: `Bearer ${adminToken}` });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    apiKey = res.data.plaintext;
    apiKeyId = res.data.id;
    return { id: res.data.id };
  }, results);
  
  // 测试 7: 创建工作流
  await runTest('POST /workflows', async () => {
    const flowgram = {
      nodes: [
        { id: 'start_0', type: 'start', data: { title: 'Start', outputs: { type: 'object', properties: { query: { type: 'string' } } } } },
        { id: 'llm_0', type: 'llm', data: { title: 'LLM', inputsValues: { modelName: { type: 'constant', content: 'deepseek-chat' }, prompt: { type: 'template', content: '{{start_0.query}}' } } } },
        { id: 'end_0', type: 'end', data: { title: 'End' } }
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
        { sourceNodeID: 'llm_0', targetNodeID: 'end_0' }
      ]
    };
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/workflows`, {
      name: `E2E Workflow ${Date.now()}`,
      flowgram: JSON.stringify(flowgram)
    }, { Authorization: `Bearer ${adminToken}` });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    workflowId = res.data.id;
    return { id: res.data.id };
  }, results);
  
  // 测试 8: 发布工作流
  await runTest('POST /workflows/:id/publish', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/workflows/${workflowId}/publish`, {}, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    return { publishedVersion: res.data.workflow?.publishedVersion };
  }, results);
  
  // 测试 9: 执行工作流
  await runTest('POST /workflows/:id/execute', async () => {
    const http = require('node:http');
    const url = new URL(`${CONFIG.GATEWAY_URL}/workflows/${workflowId}/execute`);
    const postData = JSON.stringify({ inputs: { query: 'Hello from E2E test' } });
    
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(postData);
      req.end();
    });
    
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    const events = parseSseEvents(res.body);
    const terminalEvents = events.filter((event) => event.event === 'workflow_finished');
    if (terminalEvents.length !== 1) {
      throw new Error(`Expected exactly one workflow_finished event, received ${terminalEvents.length}`);
    }
    const finished = terminalEvents[0];
    if (finished.data?.status !== 'succeeded') {
      throw new Error(`Workflow failed: ${finished.data?.error || finished.data?.status || 'unknown'}`);
    }
    if (!Object.values(finished.data?.outputs || {}).some((value) =>
      typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null
    )) {
      throw new Error('Workflow completed without non-empty outputs');
    }
    const nodeResults = events.filter((event) => event.event === 'node_finished');
    const failedNode = nodeResults.find((event) => event.data?.status !== 'succeeded');
    if (failedNode) {
      throw new Error(`Node failed: ${failedNode.data?.title || failedNode.data?.node_id || 'unknown'}`);
    }
    for (const nodeId of ['start_0', 'llm_0', 'end_0']) {
      if (!nodeResults.some((event) => event.data?.node_id === nodeId)) {
        throw new Error(`Missing successful node event: ${nodeId}`);
      }
    }
    return {
      completed: true,
      events: events.length,
      succeededNodes: nodeResults.length,
      totalSteps: finished.data?.total_steps,
    };
  }, results);
  
  // 测试 10: 获取运行记录
  await runTest('GET /workflows/:id/runs', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/workflows/${workflowId}/runs`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    if (res.data.total < 1) throw new Error('No runs recorded');
    return { total: res.data.total };
  }, results);
  
  // 测试 11: 更新工作流
  await runTest('PUT /workflows/:id', async () => {
    const flowgram = {
      nodes: [
        { id: 'start_0', type: 'start', data: { title: 'Start' } },
        { id: 'end_0', type: 'end', data: { title: 'End' } }
      ],
      edges: [{ sourceNodeID: 'start_0', targetNodeID: 'end_0' }]
    };
    const res = await httpRequest('PUT', `${CONFIG.GATEWAY_URL}/workflows/${workflowId}`, {
      name: `Updated E2E ${Date.now()}`,
      flowgram: JSON.stringify(flowgram)
    }, { Authorization: `Bearer ${adminToken}` });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { version: res.data.version };
  }, results);
  
  // 测试 12: 删除 API Key
  await runTest('DELETE /user/api-keys/:id', async () => {
    const res = await httpRequest('DELETE', `${CONFIG.GATEWAY_URL}/user/api-keys/${apiKeyId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { deleted: true };
  }, results);
  
  // 测试 13: 删除工作流
  await runTest('DELETE /workflows/:id', async () => {
    const res = await httpRequest('DELETE', `${CONFIG.GATEWAY_URL}/workflows/${workflowId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { deleted: true };
  }, results);
  
  // 测试 14: 用户列表
  await runTest('GET /admin/users', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/users?page=1&pageSize=10`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { total: res.data.total };
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

// ==================== 步骤 6: 页面数据 API 契约测试 ====================
async function step6_pageDataContractTests() {
  log('info', 'Step 6: Running page-data API contract tests (not browser UI tests)...');
  
  const results = [];
  
  await runTest('Page data: login contract', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: CONFIG.GATEWAY_ADMIN_USERNAME,
      password: CONFIG.GATEWAY_ADMIN_PASSWORD,
    });
    if (res.status !== 201) throw new Error(`Login failed: ${res.status}`);
    return { loggedIn: true };
  }, results);
  
  await runTest('Page data: workflow list contract', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: CONFIG.GATEWAY_ADMIN_USERNAME,
      password: CONFIG.GATEWAY_ADMIN_PASSWORD,
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/workflows`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    return { workflowCount: res.data?.length || res.data?.items?.length || 0 };
  }, results);
  
  await runTest('Page data: dashboard stats contract', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: CONFIG.GATEWAY_ADMIN_USERNAME,
      password: CONFIG.GATEWAY_ADMIN_PASSWORD,
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/stats`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    if (!res.data || typeof res.data !== 'object') throw new Error('Dashboard payload missing');
    return { hasStats: true };
  }, results);
  
  await runTest('Page data: Dify status contract', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: CONFIG.GATEWAY_ADMIN_USERNAME,
      password: CONFIG.GATEWAY_ADMIN_PASSWORD,
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/dify/status`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    if (!res.data?.status) throw new Error('Dify status payload missing');
    return { difyStatus: res.data.status };
  }, results);
  
  return results;
}

// ==================== 主流程（带重试） ====================
async function main() {
  log('info', '========================================');

  Object.assign(process.env, {
    DIFY_ADMIN_EMAIL: CONFIG.ADMIN_EMAIL,
    DIFY_ADMIN_PASSWORD: CONFIG.ADMIN_PASSWORD,
    DIFY_SECRET_KEY: CONFIG.DIFY_SECRET_KEY,
    DIFY_SANDBOX_API_KEY: CONFIG.DIFY_SANDBOX_API_KEY,
  });
  log('info', 'futureFlow E2E Test with Retry');
  log('info', '========================================');
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    log('info', `--- Attempt ${attempt}/${CONFIG.MAX_RETRIES} ---`);
    let gatewayProcess = null;
    
    try {
      // Step 1: 启动容器
      await step1_startContainers();
      
      // Step 2: 初始化 Dify
      const { appId, apiKey, token } = await step2_initDify();
      
      // Step 3: 发布工作流
      await step3_publishWorkflow(token, appId);
      
      // Step 4: 启动网关
      gatewayProcess = await step4_startGateway();
      
      // Step 5: API 测试
      const apiResults = await step5_apiTests();
      
      // Step 6: 页面数据 API 契约测试（浏览器 UI 由 e2e-full-test.cjs 负责）
      const contractResults = await step6_pageDataContractTests();
      
      // 汇总
      const allResults = [...apiResults, ...contractResults];
      const passed = allResults.filter(r => r.status === 'PASS').length;
      const total = allResults.length;
      
      log('info', '========================================');
      log('info', `RESULTS: ${passed}/${total} tests passed`);
      log('info', '========================================');
      
      if (passed === total) {
        log('success', '🎉 API AND PAGE-DATA CONTRACT TESTS PASSED!');
        return 0;
      } else {
        const failed = allResults.filter(r => r.status === 'FAIL');
        failed.forEach(f => log('error', `  - ${f.name}: ${f.error}`));
        
        if (attempt < CONFIG.MAX_RETRIES) {
          log('warn', `Retrying in ${CONFIG.RETRY_DELAY / 1000}s...`);
          await sleep(CONFIG.RETRY_DELAY);
        }
      }
    } catch (err) {
      log('error', `Attempt ${attempt} failed: ${err.message}`);
      if (attempt < CONFIG.MAX_RETRIES) {
        log('warn', `Retrying in ${CONFIG.RETRY_DELAY / 1000}s...`);
        await sleep(CONFIG.RETRY_DELAY);
      }
    } finally {
      if (gatewayProcess && gatewayProcess.exitCode === null) {
        gatewayProcess.kill();
        await sleep(500);
      }
    }
  }
  
  log('error', 'All retry attempts exhausted');
  return 1;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
