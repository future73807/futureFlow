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

// ==================== 配置 ====================
const CONFIG = {
  DIFY_API_BASE: 'http://localhost:5001',
  DIFY_CONSOLE_BASE: 'http://localhost:5001/console/api',
  GATEWAY_PORT: 3001,
  GATEWAY_URL: 'http://localhost:3001',
  ADMIN_EMAIL: 'admin@futureflow.ai',
  ADMIN_PASSWORD: 'admin123456',
  APP_NAME: 'futureFlow Bridge',
  MAX_RETRIES: 5,
  RETRY_DELAY: 5000,
  DIFY_MAX_WAIT: 180000,
};

// ==================== 工具函数 ====================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    log('success', `API key created: ${apiKey.substring(0, 20)}...`);
  }
  
  // 更新 .env
  updateEnv({
    DIFY_API_KEY: apiKey,
    DIFY_APP_ID: appId,
    DIFY_CONSOLE_TOKEN: token,
    DIFY_AUTO_BOOTSTRAP: 'true',
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
  
  // 杀掉旧的网关进程（如果存在）
  try {
    const netstat = execSync('netstat -ano | findstr :3001', { encoding: 'utf8' });
    const lines = netstat.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[4] === 'LISTENING') {
        const pid = parts[parts.length - 1];
        log('info', `Killing old gateway process (PID: ${pid})`);
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
      }
    }
    await sleep(2000);
  } catch (err) {
    log('info', 'No old gateway process to kill');
  }
  
  // 运行数据库 migration（如果是全新环境）
  try {
    log('info', 'Running database migrations...');
    execSync('npm run migration:run', { cwd: gatewayDir, stdio: 'pipe', timeout: 60000 });
    log('success', 'Database migrations completed');
  } catch (err) {
    log('warn', `Migration may have already run: ${err.message}`);
  }
  
  // 构建（如果需要）
  if (!existsSync(resolve(gatewayDir, 'dist/src/main.js'))) {
    log('info', 'Building gateway...');
    execSync('npm run build', { cwd: gatewayDir, stdio: 'pipe', timeout: 120000 });
  }
  
  const child = spawn('node', ['dist/src/main.js'], {
    cwd: gatewayDir,
    env: { ...process.env, NODE_ENV: 'development', GATEWAY_JWT_SECRET: 'e2e-test-jwt-secret-that-is-long-enough-1234567890' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref();
  
  // 等待就绪
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/workflows/health`);
      if (res.status === 200) {
        log('success', 'Gateway is ready');
        // 等待 seed 用户创建完成
        log('info', 'Waiting for seed user to be ready...');
        const loginStart = Date.now();
        while (Date.now() - loginStart < 30000) {
          try {
            const loginRes = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
              account: 'demo',
              password: 'demo123456'
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
  await runTest('GET /workflows/health', async () => {
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/workflows/health`);
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return res.data;
  }, results);
  
  // 测试 2: 管理员登录
  await runTest('POST /auth/login', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: 'demo', password: 'demo123456'
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
    if (!res.body.includes('workflow_finished') && !res.body.includes('succeeded')) {
      throw new Error('Workflow did not complete: ' + res.body.substring(0, 300));
    }
    return { completed: true, length: res.body.length };
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

// ==================== 步骤 6: UI 模拟测试 ====================
async function step6_uiSimulationTests() {
  log('info', 'Step 6: Running UI simulation tests (via API calls)...');
  
  const results = [];
  
  // 模拟 UI 登录
  await runTest('UI: Login page load', async () => {
    const res = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: 'demo', password: 'demo123456'
    });
    if (res.status !== 201) throw new Error(`Login failed: ${res.status}`);
    return { loggedIn: true };
  }, results);
  
  // 模拟 UI 获取工作流列表
  await runTest('UI: Load workflow list', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: 'demo', password: 'demo123456'
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/workflows`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    return { workflowCount: res.data?.length || res.data?.items?.length || 0 };
  }, results);
  
  // 模拟 UI 获取仪表盘
  await runTest('UI: Load dashboard stats', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: 'demo', password: 'demo123456'
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/stats`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    return { hasStats: !!res.data };
  }, results);
  
  // 模拟 UI 获取 Dify 状态
  await runTest('UI: Load Dify status', async () => {
    const login = await httpRequest('POST', `${CONFIG.GATEWAY_URL}/auth/login`, {
      account: 'demo', password: 'demo123456'
    });
    const token = login.data.accessToken;
    const res = await httpRequest('GET', `${CONFIG.GATEWAY_URL}/admin/dify/status`, null, {
      Authorization: `Bearer ${token}`
    });
    if (res.status !== 200) throw new Error(`Failed: ${res.status}`);
    return { difyStatus: res.data?.status };
  }, results);
  
  return results;
}

// ==================== 主流程（带重试） ====================
async function main() {
  log('info', '========================================');
  log('info', 'futureFlow E2E Test with Retry');
  log('info', '========================================');
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    log('info', `--- Attempt ${attempt}/${CONFIG.MAX_RETRIES} ---`);
    
    try {
      // Step 1: 启动容器
      await step1_startContainers();
      
      // Step 2: 初始化 Dify
      const { appId, apiKey, token } = await step2_initDify();
      
      // Step 3: 发布工作流
      await step3_publishWorkflow(token, appId);
      
      // Step 4: 启动网关
      await step4_startGateway();
      
      // Step 5: API 测试
      const apiResults = await step5_apiTests();
      
      // Step 6: UI 模拟测试
      const uiResults = await step6_uiSimulationTests();
      
      // 汇总
      const allResults = [...apiResults, ...uiResults];
      const passed = allResults.filter(r => r.status === 'PASS').length;
      const total = allResults.length;
      
      log('info', '========================================');
      log('info', `RESULTS: ${passed}/${total} tests passed`);
      log('info', '========================================');
      
      if (passed === total) {
        log('success', '🎉 ALL TESTS PASSED!');
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
    }
  }
  
  log('error', 'All retry attempts exhausted');
  return 1;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
