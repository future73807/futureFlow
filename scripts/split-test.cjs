'use strict';
const { chromium } = require('playwright-core');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * 从仓库根 .env 读取本地数据库连接信息。
 *
 * 本脚本此前把 POSTGRES_PASSWORD 明文写死。而 .env 里的密码是 `pnpm env:init`
 * 在每台机器上随机生成的，写死既把真实凭据带进了 git 历史，也让脚本换台机器
 * 必然连不上库。与 compose 保持同一组变量名（POSTGRES_*）。
 */
function loadEnvFile() {
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

loadEnvFile();

/** 前端/网关地址：优先环境变量，其次仓库根 .env，最后回落到默认端口。 */
function resolveBase(envName, envKey, fallbackPort) {
  if (process.env[envName]) return process.env[envName].replace(/\/+$/, '');
  try {
    const env = readFileSync(resolve(__dirname, '..', '.env'), 'utf8');
    const value = env.match(new RegExp('^' + envKey + '=(.*)$', 'm'))?.[1]?.trim();
    if (value) return envKey === 'PUBLIC_GATEWAY_URL' ? value.replace(/\/+$/, '') : `http://localhost:${value}`;
  } catch { /* fall through */ }
  return `http://localhost:${fallbackPort}`;
}

const GATEWAY = resolveBase('GATEWAY_URL', 'PUBLIC_GATEWAY_URL', 3001);
const FRONTEND = resolveBase('FRONTEND_URL', 'FRONTEND_PORT', 3000);

const dbConnection = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  username: process.env.POSTGRES_USER || 'futureflow',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB || 'futureflow',
};

function findBrowser() {
  const c = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  return c.find((x) => x && existsSync(x));
}
async function makeWf(tok, name, nodes, edges) {
  return await (await fetch(`${GATEWAY}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name, description: '二分定位', flowgram: JSON.stringify({ nodes, edges }) }),
  })).json();
}
(async () => {
  const login = await (await fetch(`${GATEWAY}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'futureFlow@' }) })).json();
  const tok = login.accessToken;
  const start = { id: 'start_0', type: 'start', meta: { position: { x: 80, y: 200 } }, data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', title: '用户输入', default: 'hello' } } } } };
  const db = { id: 'db_x', type: 'database', meta: { position: { x: 380, y: 200 } }, data: { title: 'SQL 查询', connection: dbConnection, sqlValue: { type: 'template', content: 'SELECT username FROM users LIMIT 2' }, outputs: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' }, title: '查询结果' }, rowCount: { type: 'integer', title: '行数' } } } } };
  const py = { id: 'py_x', type: 'python', meta: { position: { x: 380, y: 200 } }, data: { title: 'Python 执行', codeValue: { type: 'template', content: 'def main(params):\n    return {"ok": True}' }, outputs: { type: 'object', properties: { result: { type: 'object', title: '返回结果' } } } } };
  const endDB = { id: 'end_0', type: 'end', meta: { position: { x: 700, y: 200 } }, data: { title: '结束', inputsValues: { rows: { type: 'ref', content: ['db_x', 'rows'] } }, inputs: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' }, title: '查询结果' } } } } };
  const endPY = { id: 'end_0', type: 'end', meta: { position: { x: 700, y: 200 } }, data: { title: '结束', inputsValues: { result: { type: 'ref', content: ['py_x', 'result'] } }, inputs: { type: 'object', properties: { result: { type: 'object', title: '返回结果' } } } } };
  const wfA = await makeWf(tok, '二分A-SQL', [start, db, endDB], [{ sourceNodeID: 'start_0', targetNodeID: 'db_x' }, { sourceNodeID: 'db_x', targetNodeID: 'end_0' }]);
  const wfB = await makeWf(tok, '二分B-Python', [JSON.parse(JSON.stringify(start)), py, endPY], [{ sourceNodeID: 'start_0', targetNodeID: 'py_x' }, { sourceNodeID: 'py_x', targetNodeID: 'end_0' }]);

  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('futureFlow@');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2200);
  for (const [label, wf] of [['A-SQL', wfA], ['B-Python', wfB]]) {
    await page.goto(`${FRONTEND}/canvas/${wf.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.getByRole('button', { name: '试运行', exact: true }).first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '开始试运行' }).first().click();
    let out = '';
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(2500);
      const t = await page.evaluate(() => document.body.innerText);
      const idx = t.indexOf('输入表单');
      out = idx >= 0 ? t.slice(idx, idx + 700) : t.slice(-700);
      if (!/运行中/.test(out)) break;
    }
    console.log(`===== ${label} =====`);
    console.log(JSON.stringify(out.replace(/\s+/g, ' ').slice(0, 400)));
    await page.screenshot({ path: `gui-full-screenshots/split_${label}.png` });
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });