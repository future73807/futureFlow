#!/usr/bin/env node
/**
 * Dify 自动初始化脚本
 * 在 Docker 启动时自动创建管理员、应用和 API Key
 * 
 * 使用方法: node scripts/init-dify.cjs
 */

const { execSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://localhost:5001';
const DIFY_CONSOLE_BASE = DIFY_API_BASE + '/console/api';
const ADMIN_EMAIL = 'admin@futureflow.ai';
const ADMIN_PASSWORD = 'admin123456';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDify() {
  console.log('等待 Dify 服务启动...');
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${DIFY_API_BASE}/health`);
      if (res.ok) {
        console.log('Dify 服务已就绪');
        return true;
      }
    } catch {
      // 服务未就绪，继续等待
    }
    await sleep(2000);
  }
  throw new Error('Dify 服务启动超时');
}

async function setupAdmin() {
  console.log('创建 Dify 管理员账户...');
  const res = await fetch(`${DIFY_CONSOLE_BASE}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: <REDACTED>
      name: 'Admin',
    }),
  });
  const data = await res.json();
  if (data.result === 'success') {
    console.log('管理员账户创建成功');
    return true;
  }
  // 可能已经初始化过
  console.log('管理员账户可能已存在:', data);
  return true;
}

async function login() {
  console.log('登录 Dify 控制台...');
  const res = await fetch(`${DIFY_CONSOLE_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: <REDACTED>
    }),
  });
  const data = await res.json();
  if (data.result === 'success') {
    console.log('登录成功');
    return data.data.access_token;
  }
  throw new Error('登录失败: ' + JSON.stringify(data));
}

async function createApp(token) {
  console.log('创建 futureFlow Bridge 应用...');
  const res = await fetch(`${DIFY_CONSOLE_BASE}/apps`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: 'futureFlow Bridge',
      mode: 'workflow',
      icon: '🤖',
      icon_background: '#FFEAD5',
    }),
  });
  const data = await res.json();
  if (data.id) {
    console.log('应用创建成功:', data.id);
    return data.id;
  }
  // 应用可能已存在
  if (data.code === 'app_name_already_exists') {
    console.log('应用已存在，获取应用列表...');
    const listRes = await fetch(`${DIFY_CONSOLE_BASE}/apps?page=1&limit=100`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const listData = await listRes.json();
    const app = listData.data?.find(a => a.name === 'futureFlow Bridge');
    if (app) {
      console.log('找到已存在的应用:', app.id);
      return app.id;
    }
  }
  throw new Error('创建应用失败: ' + JSON.stringify(data));
}

async function generateApiKey(token, appId) {
  console.log('生成 API Key...');
  const res = await fetch(`${DIFY_CONSOLE_BASE}/apps/${appId}/api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (data.token) {
    console.log('API Key 生成成功:', data.token);
    return data.token;
  }
  throw new Error('生成 API Key 失败: ' + JSON.stringify(data));
}

async function addProvider(token, appId) {
  console.log('添加 LongCat 模型提供商...');
  const res = await fetch(`${DIFY_CONSOLE_BASE}/apps/${appId}/model-configs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      provider: 'longcat',
      model_id: 'LongCat-2.0',
      model_type: 'llm',
      configs: {
        api_key: process.env.LLM_API_KEY || '***REMOVED***',
        api_base: process.env.LLM_API_HOST || 'https://api.longcat.chat/openai',
      },
    }),
  });
  const data = await res.json();
  console.log('模型提供商添加结果:', data);
  return true;
}

function updateEnvFile(apiKey, appId) {
  console.log('更新 .env 文件...');
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.log('.env 文件不存在，跳过更新');
    return;
  }
  
  let content = readFileSync(envPath, 'utf8');
  
  // 更新 DIFY_API_KEY
  if (content.includes('DIFY_API_KEY=')) {
    content = content.replace(/DIFY_API_KEY=.*/, `DIFY_API_KEY=${apiKey}`);
  } else {
    content += `\nDIFY_API_KEY=${apiKey}`;
  }
  
  // 更新 DIFY_APP_ID
  if (content.includes('DIFY_APP_ID=')) {
    content = content.replace(/DIFY_APP_ID=.*/, `DIFY_APP_ID=${appId}`);
  } else {
    content += `\nDIFY_APP_ID=${appId}`;
  }
  
  writeFileSync(envPath, content);
  console.log('.env 文件已更新');
}

async function main() {
  try {
    await waitForDify();
    await setupAdmin();
    const token = await login();
    const appId = await createApp(token);
    const apiKey = await generateApiKey(token, appId);
    await addProvider(token, appId);
    updateEnvFile(apiKey, appId);
    
    console.log('\n=== Dify 初始化完成 ===');
    console.log(`App ID: ${appId}`);
    console.log(`API Key: ${apiKey}`);
    console.log('请重启网关服务以应用新配置');
  } catch (err) {
    console.error('初始化失败:', err.message);
    process.exit(1);
  }
}

main();
