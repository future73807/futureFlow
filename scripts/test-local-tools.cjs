'use strict';
/**
 * 本地扩展节点验收（Python）。
 *
 * 原脚本同时验收「SQL 查询 + Python 执行」。SQL 查询节点已移除——它只能本地试运行
 * 却需要用户手工配置连接串、且发布后不可用；同样的需求改由 Python 节点承担
 * （驱动随仓库携带，见 gateway/vendor/README.md），只读兜底由「查询 PostgreSQL」
 * 预置模板提供（BEGIN READ ONLY）。
 *
 * 因此本脚本现在验收的是替代路径是否真的成立：
 *   T1 建含 Python 节点的工作流
 *   T2 节点面板展示「Python 执行」且不再展示「SQL 查询」
 *   T3 画布渲染
 *   T4 Python 节点真实执行（读 params.query，验证输入透传）
 *   T5 开箱连库：直接调网关 /python/exec，不传 driverPath 即可 import pg8000
 *   T6 试运行整体无失败
 *
 * T5 刻意不走前端试运行：前端试运行的 params 只包含开始节点声明的字段，要把
 * 数据库连接信息传进去就得把它写进工作流定义（等于让凭据落库），不适合放进
 * 验收；而「驱动是否随平台提供」本质是网关侧能力，直接验更准确也更稳定。
 */
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
  || process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD
  || adminPassword();

const dbConnection = {
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB,
};

/** 画布内执行：验证 params 透传（开始节点声明的字段会被展开成 {{引用}} 模板）。 */
const CODE_ECHO = [
  'def main(params):',
  '    text = str(params.get("query", ""))',
  '    return {"echo": text, "length": len(text)}',
].join('\n');

/** 开箱连库：刻意不写 sys.path.insert，验证网关的 PYTHONPATH 注入生效。 */
const CODE_PY_DB = [
  'def main(params):',
  '    import pg8000.native',
  '    conn = pg8000.native.Connection(',
  '        user=str(params["user"]), password=str(params["password"]),',
  '        host=str(params["host"]), port=int(params["port"]), database=str(params["database"]))',
  '    rows = conn.run("SELECT username, role FROM users ORDER BY username LIMIT 2")',
  '    conn.close()',
  '    return {"rows": [[str(c) for c in r] for r in rows], "pg8000": pg8000.__version__}',
].join('\n');

function findBrowser() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return c.find((x) => x && existsSync(x));
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + String(detail).slice(0, 170) : ''}`);
};

(async () => {
  if (!dbConnection.password) {
    console.error('缺少 POSTGRES_PASSWORD：请先在仓库根目录执行 `pnpm run env:init` 生成 .env');
    process.exit(1);
  }

  const login = await (await fetch(`${GATEWAY}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: ADMIN_PASSWORD }),
  })).json();
  const tok = login.accessToken || login.data?.accessToken;

  const flowgram = {
    nodes: [
      {
        id: 'start_0',
        type: 'start',
        meta: { position: { x: 80, y: 200 } },
        data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', title: '用户输入', default: 'hello' } } } },
      },
      {
        id: 'py_test1',
        type: 'python',
        meta: { position: { x: 380, y: 200 } },
        data: {
          title: 'Python 执行·透传',
          codeValue: { type: 'template', content: CODE_ECHO },
          outputs: { type: 'object', properties: { result: { type: 'object', title: '返回结果' } } },
        },
      },
      {
        id: 'end_0',
        type: 'end',
        meta: { position: { x: 700, y: 200 } },
        data: {
          title: '结束',
          inputsValues: { report: { type: 'ref', content: ['py_test1', 'result'] } },
          inputs: { type: 'object', properties: { report: { type: 'object', title: '执行报告' } } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start_0', targetNodeID: 'py_test1' },
      { sourceNodeID: 'py_test1', targetNodeID: 'end_0' },
    ],
  };

  const wf = await (await fetch(`${GATEWAY}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: '本地扩展节点验收', description: 'Python 节点端到端（含连库）', flowgram: JSON.stringify(flowgram) }),
  })).json();
  record('T1 API 创建含 Python 节点的工作流', !!wf.id, wf.id || JSON.stringify(wf).slice(0, 120));

  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2200);

  // 节点面板
  await page.getByRole('button', { name: '创建画布' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('input[placeholder="如：翻译助手"]').first().fill('节点面板检查');
  await page.getByRole('button', { name: '创建并进入编辑' }).click();
  await page.waitForURL('**/canvas/**', { timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.locator('[data-testid="demo.free-layout.add-node"]').first().click();
  await page.waitForTimeout(800);
  let panelText = '';
  const panel = page.locator('.canvas-node-panel:visible');
  if ((await panel.count()) >= 1) panelText = await panel.innerText();
  record('T2 节点面板展示「Python 执行」', panelText.includes('Python 执行'), panelText.slice(0, 80));
  record('T2b 面板不再展示「SQL 查询」', !panelText.includes('SQL 查询'));
  await page.keyboard.press('Escape').catch(() => {});

  // 验收工作流
  await page.goto(`${FRONTEND}/canvas/${wf.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const nodeCount = await page.evaluate(() => document.querySelectorAll('[class*="node-type-"]').length);
  record('T3 画布渲染 3 个节点', nodeCount === 3, String(nodeCount));

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
  record('T4 Python 节点真实执行并透传输入', /echo/.test(output) && /length/.test(output), output.replace(/\s+/g, ' ').slice(0, 170));
  record('T6 试运行整体成功(无失败标记)', !/执行失败/.test(output));
  await browser.close();

  // ── T7/T8：只读模板的安全属性 ─────────────────────────────────
  // SQL 节点被移除后，「只读」这条保障改由 Python 节点的预置模板承担。它是一条
  // **安全属性**：若日后有人编辑模板时删掉 BEGIN READ ONLY，界面上不会有任何异常，
  // 但「查数据库」就悄悄变成了「可以改库」。所以这里直接抽取**真实模板文本**执行，
  // 而不是另写一段等价代码——否则模板被改坏时测试照样通过。
  const templatePath = resolve(__dirname, '..', 'frontend/src/nodes/python/form-meta.tsx');
  const templateSource = readFileSync(templatePath, 'utf8');
  const templateMatch = templateSource.match(
    /export const POSTGRES_READONLY_TEMPLATE = `([\s\S]*?)`;/,
  );
  // 抽不到就报错退出，而不是跳过：模板格式变了要让测试失败，不能静默漏测。
  if (!templateMatch) {
    record('T7 抽取只读模板文本', false, '未能在 form-meta.tsx 中匹配到 POSTGRES_READONLY_TEMPLATE');
  } else {
    const template = templateMatch[1];
    record('T7 只读模板包含 BEGIN READ ONLY 保障', /BEGIN READ ONLY/.test(template), template.split('\n').length + ' 行');

    const runTemplate = async (sql) => {
      const r = await fetch(`${GATEWAY}/python/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          code: template,
          params: {
            dbHost: dbConnection.host,
            dbPort: dbConnection.port,
            dbUser: dbConnection.user,
            dbPassword: dbConnection.password,
            dbName: dbConnection.database,
            sql,
          },
        }),
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    };

    const readResult = await runTemplate('SELECT count(*)::int AS n FROM users');
    record(
      'T8a 只读模板可正常执行 SELECT',
      readResult.ok && /rowCount/.test(readResult.text),
      readResult.text.slice(0, 150),
    );

    const writeResult = await runTemplate('DELETE FROM users');
    // 预期被 PostgreSQL 以 25006（只读事务）拒绝 —— 这正是「只读」生效的证据
    const blockedByReadOnly = /25006|read-only transaction/.test(writeResult.text);
    record(
      'T8b 只读模板拒绝写入（数据库层拦截）',
      !writeResult.ok && blockedByReadOnly,
      writeResult.text.slice(0, 170),
    );
  }

  // T5：开箱连库（API 级，理由见文件头注释）
  const dbRes = await fetch(`${GATEWAY}/python/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ code: CODE_PY_DB, params: dbConnection }),
  });
  const dbText = await dbRes.text();
  record(
    'T5 Python 节点开箱连库（无需 pip install）',
    dbRes.ok && /pg8000/.test(dbText) && /admin|username/.test(dbText),
    dbText.slice(0, 170),
  );

  // 清理本套件创建的工作流：'本地扩展节点验收'（API 建）与 '节点面板检查'（画布建）。
  // 此前两者都留在库里，实测堆积了 33 个 '本地扩展节点验收'，全都在用户的工作流列表中。
  reportCleanup(
    await cleanupTestWorkflows({
      gateway: GATEWAY,
      token: tok,
      names: ['本地扩展节点验收', '节点面板检查'],
    }),
    '本套件创建的工作流',
  );

  const passed = results.filter(Boolean).length;  console.log(`\n===== 本地扩展节点验收: ${passed}/${results.length} passed =====`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
