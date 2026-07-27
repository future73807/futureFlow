#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://localhost:5001';
const DIFY_CONSOLE_BASE = DIFY_API_BASE + '/console/api';
const ADMIN_EMAIL = 'admin@futureflow.ai';
const ADMIN_PASSWORD = 'admin123456';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitForDify() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(DIFY_API_BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(2000);
  }
  throw new Error('timeout');
}
async function main() {
  await waitForDify();
  await fetch(DIFY_CONSOLE_BASE + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: '<REDACTED>', name: 'Admin' }) });
  const login = await (await fetch(DIFY_CONSOLE_BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: '<REDACTED>' }) })).json();
  const token = login.data.access_token;
  const app = await (await fetch(DIFY_CONSOLE_BASE + '/apps', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name: 'futureFlow Bridge', mode: 'workflow' }) })).json();
  const appId = app.id;
  const key = await (await fetch(DIFY_CONSOLE_BASE + '/apps/' + appId + '/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({}) })).json();
  const apiKey = key.token;
  let env = readFileSync('.env', 'utf8');
  env = env.replace(/DIFY_API_KEY=.*/, 'DIFY_API_KEY=' + apiKey);
  env = env.replace(/DIFY_APP_ID=.*/, 'DIFY_APP_ID=' + appId);
  writeFileSync('.env', env);
  console.log('Done. AppId:', appId, 'Key:', apiKey);
}
main().catch(e => { console.error(e); process.exit(1); });
