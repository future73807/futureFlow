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
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return c.find((x) => x && existsSync(x));
}
const results = [];
const record = (name, ok, detail = '') => { results.push(ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + String(detail).slice(0, 160) : ''}`); };

(async () => {
  if (!dbConnection.password) {
    console.error('缺少 POSTGRES_PASSWORD：请先在仓库根目录执行 `pnpm run env:init` 生成 .env');
    process.exit(1);
  }

  // ---- 通过 API 构建工作流 ----
  const login = await (await fetch(`${GATEWAY}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'futureFlow@' }),
  })).json();
  const tok = login.accessToken;
  const flowgram = {
    nodes: [
      { id: 'start_0', type: 'start', meta: { position: { x: 80, y: 200 } }, data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', title: '用户输入', default: 'hello' } } } } },
      { id: 'db_test1', type: 'database', meta: { position: { x: 380, y: 200 } }, data: {
        title: 'SQL 查询', connection: dbConnection,
        sqlValue: { type: 'template', content: 'SELECT username, role FROM users LIMIT 2' },
        outputs: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' }, title: '查询结果' }, rowCount: { type: 'integer', title: '行数' }, truncated: { type: 'boolean', title: '是否截断' } } },
      } },
      { id: 'py_test1', type: 'python', meta: { position: { x: 700, y: 200 } }, data: {
        title: 'Python 执行',
        codeValue: { type: 'template', content: 'def main(params):\n    return {"note": "python-ok", "answer": 42}' },
        outputs: { type: 'object', properties: { result: { type: 'object', title: '返回结果' } } },
      } },
      { id: 'end_0', type: 'end', meta: { position: { x: 1020, y: 200 } }, data: {
        title: '结束',
        inputsValues: {
          rows: { type: 'ref', content: ['db_test1', 'rows'] },
          report: { type: 'ref', content: ['py_test1', 'result'] },
        },
        inputs: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' }, title: '查询结果' }, report: { type: 'object', title: '执行报告' } } },
      } },
    ],
    edges: [
      { sourceNodeID: 'start_0', targetNodeID: 'db_test1' },
      { sourceNodeID: 'db_test1', targetNodeID: 'py_test1' },
      { sourceNodeID: 'py_test1', targetNodeID: 'end_0' },
    ],
  };
  const wf = await (await fetch(`${GATEWAY}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: '本地扩展节点验收', description: 'SQL+Python 节点端到端', flowgram: JSON.stringify(flowgram) }),
  })).json();
  record('T1 API 创建含 SQL/Python 节点的工作流', !!wf.id, wf.id || JSON.stringify(wf).slice(0, 120));

  // ---- 浏览器打开画布并试运行 ----
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill('futureFlow@');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2200);

  // 节点面板列出新节点(先进入任一画布)
  await page.getByRole('button', { name: '创建画布' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('input[placeholder="如：翻译助手"]').first().fill('节点面板检查');
  await page.getByRole('button', { name: '创建并进入编辑' }).click();
  await page.waitForURL('**/canvas/**', { timeout: 20000 });
  await page.waitForTimeout(4000);
  const addBtn = page.locator('[data-testid="demo.free-layout.add-node"]');
  await addBtn.first().click();
  await page.waitForTimeout(800);
  let panelText = '';
  const panel = page.locator('.canvas-node-panel:visible');
  if ((await panel.count()) >= 1) panelText = await panel.innerText();
  record('T2 添加节点面板展示「SQL 查询」', panelText.includes('SQL 查询'), panelText.slice(0, 80));
  record('T2 添加节点面板展示「Python 执行」', panelText.includes('Python 执行'));
  await page.keyboard.press('Escape').catch(() => {});

  // 打开验收工作流
  await page.goto(`${FRONTEND}/canvas/${wf.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const nodeCount = await page.evaluate(() => document.querySelectorAll('[class*="node-type-"]').length);
  record('T3 画布渲染 4 个节点', nodeCount === 4, String(nodeCount));
  await page.screenshot({ path: 'gui-full-screenshots/ext_canvas.png' });

  await page.getByRole('button', { name: '试运行', exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '开始试运行' }).first().click();
  let output = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const t = await page.evaluate(() => document.body.innerText);
    const idx = t.indexOf('输入表单');
    output = idx >= 0 ? t.slice(idx, idx + 900) : t.slice(-900);
    if (!/运行中/.test(output)) break;
  }
  await page.screenshot({ path: 'gui-full-screenshots/ext_run.png' });
  record('T4 SQL 节点真实查询返回 rows', /rows/.test(output) && /username/.test(output), output.replace(/\s+/g, ' ').slice(0, 180));
  record('T5 Python 节点真实执行返回 result', /python-ok/.test(output) && /42/.test(output));
  record('T6 试运行整体成功(无失败标记)', !/执行失败/.test(output));
  await browser.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n===== 本地扩展节点验收: ${passed}/${results.length} passed =====`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });