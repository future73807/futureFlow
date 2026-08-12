#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://localhost:5001';
const DIFY_CONSOLE_BASE = DIFY_API_BASE + '/console/api';
const ADMIN_EMAIL = process.env.DIFY_ADMIN_EMAIL || 'admin@futureflow.local';
const ADMIN_PASSWORD = process.env.DIFY_ADMIN_PASSWORD || '';
const APP_NAME = 'futureFlow Bridge';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDify() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(DIFY_API_BASE + '/health');
      if (r.ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error('Dify API did not become ready in time');
}

async function trySetupAdmin() {
  try {
    const res = await fetch(DIFY_CONSOLE_BASE + '/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' })
    });
    const data = await res.json();
    if (res.ok && data.result === 'success') {
      console.log('Admin account created successfully');
      return true;
    }
    // 如果已经设置过，API 会返回错误，这是正常的
    console.log('Admin setup skipped (may already exist):', data.message || 'unknown reason');
    return false;
  } catch (err) {
    console.log('Admin setup attempt failed:', err.message);
    return false;
  }
}

async function login() {
  const res = await fetch(DIFY_CONSOLE_BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const data = await res.json();
  if (!res.ok || !data.data?.access_token) {
    throw new Error('Login failed: ' + JSON.stringify(data));
  }
  console.log('Login successful');
  return data.data.access_token;
}

async function findExistingApp(token) {
  try {
    const res = await fetch(DIFY_CONSOLE_BASE + '/apps?page=1&limit=50', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.data) {
      const existing = data.data.find(app => app.name === APP_NAME);
      if (existing) {
        console.log('Found existing app:', existing.id);
        return existing.id;
      }
    }
  } catch (err) {
    console.log('Could not list apps:', err.message);
  }
  return null;
}

async function createApp(token) {
  const existingId = await findExistingApp(token);
  if (existingId) return existingId;

  const res = await fetch(DIFY_CONSOLE_BASE + '/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: APP_NAME, mode: 'workflow' })
  });
  const data = await res.json();
  if (!data.id) {
    throw new Error('Failed to create app: ' + JSON.stringify(data));
  }
  console.log('App created:', data.id);
  return data.id;
}

async function getOrCreateApiKey(token, appId) {
  // 先尝试列出已有的 keys
  try {
    const listRes = await fetch(DIFY_CONSOLE_BASE + '/apps/' + appId + '/api-keys', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const listData = await listRes.json();
    if (listData.data && listData.data.length > 0) {
      console.log('Using existing API key');
      return listData.data[0].token;
    }
  } catch (err) {
    console.log('Could not list API keys:', err.message);
  }

  // 创建新 key
  const res = await fetch(DIFY_CONSOLE_BASE + '/apps/' + appId + '/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({})
  });
  const data = await res.json();
  if (!data.token) {
    throw new Error('Failed to create API key: ' + JSON.stringify(data));
  }
  console.log('API key created');
  return data.token;
}

function updateEnvFile(appId, apiKey) {
  const envPath = resolve(process.cwd(), '.env');
  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  
  const newline = env.includes('\r\n') ? '\r\n' : '\n';
  
  // 更新或添加 DIFY_API_KEY
  if (/^DIFY_API_KEY=/m.test(env)) {
    env = env.replace(/^DIFY_API_KEY=.*/m, 'DIFY_API_KEY=' + apiKey);
  } else {
    env += `${newline}DIFY_API_KEY=${apiKey}${newline}`;
  }
  
  // 更新或添加 DIFY_APP_ID
  if (/^DIFY_APP_ID=/m.test(env)) {
    env = env.replace(/^DIFY_APP_ID=.*/m, 'DIFY_APP_ID=' + appId);
  } else {
    env += `${newline}DIFY_APP_ID=${appId}${newline}`;
  }
  
  writeFileSync(envPath, env);
  console.log('Updated .env with DIFY_API_KEY and DIFY_APP_ID');
}

async function main() {
  if (ADMIN_PASSWORD.length < 16) {
    throw new Error('DIFY_ADMIN_PASSWORD must contain at least 16 characters; run pnpm env:init');
  }
  console.log('Waiting for Dify API...');
  await waitForDify();
  
  // 尝试创建管理员（如果已存在会失败，这是正常的）
  await trySetupAdmin();
  
  // 登录
  const token = await login();
  
  // 创建或获取应用
  const appId = await createApp(token);
  
  // 创建或获取 API Key
  const apiKey = await getOrCreateApiKey(token, appId);
  
  // 更新 .env 文件
  updateEnvFile(appId, apiKey);
  
  console.log('=== Dify Initialization Complete ===');
  console.log('App ID:', appId);
  console.log('Service API key saved to .env');
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
