/**
 * 触发器「连续失败」可见性验收。
 *
 * 为什么需要单独一个套件：其它 GUI 套件都不创建定时触发器，因此「连续失败 N 次」
 * 这条界面分支从未真正渲染过。这里造一个必然失败的已发布工作流、挂上定时触发器、
 * 等真实调度把它跑失败，再用真实浏览器展开触发器抽屉，断言界面文案。
 *
 * 用法：FRONTEND_URL=http://localhost:3400 GATEWAY_URL=http://localhost:3401 \
 *         node scripts/test-trigger-failure-display.cjs
 *   前置：网关与前端已启动；建议把 WORKFLOW_SCHEDULE_TICK_SECONDS 调小以便快速触发。
 */
const { chromium } = require('playwright-core');
const { existsSync, readFileSync } = require('node:fs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');

const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
  env[m[1]] = v;
}

const B = (process.env.GATEWAY_URL || 'http://localhost:3401').replace(/\/+$/, '');
const FRONT = (process.env.FRONTEND_URL || 'http://localhost:3400').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const PW = process.env.ADMIN_PASSWORD || env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD;

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => p && existsSync(p));
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + String(detail).slice(0, 200) : ''}`);
};

async function api(path, options = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(B + path, { ...options, headers });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

/** 本套件建的工作流名是 `连续失败展示-<时间戳>`，只能前缀匹配。 */
const WORKFLOW_PREFIX = '连续失败展示-';

(async () => {
  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account: ADMIN, password: PW }),
  });
  const tok = login.data.accessToken || login.data.data?.accessToken;

  const wfName = `连续失败展示-${Date.now()}`;
  const flowgram = {
    nodes: [
      { id: 'start_0', type: 'start', meta: { position: { x: 80, y: 200 } }, data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', title: '输入', default: 'x' } } } } },
      {
        id: 'code_0', type: 'code', meta: { position: { x: 380, y: 200 } },
        data: {
          title: '故意失败',
          inputs: { type: 'object', properties: {} }, inputsValues: {},
          script: { language: 'javascript', content: 'function main({ params }) { throw new Error("display-probe"); }' },
          outputs: { type: 'object', properties: { result: { type: 'string' } } },
        },
      },
      { id: 'end_0', type: 'end', meta: { position: { x: 700, y: 200 } }, data: { title: '结束', inputsValues: { result: { type: 'ref', content: ['code_0', 'result'] } } } },
    ],
    edges: [
      { sourceNodeID: 'start_0', targetNodeID: 'code_0' },
      { sourceNodeID: 'code_0', targetNodeID: 'end_0' },
    ],
  };

  // 从创建工作流起就进 try：发布或挂触发器失败时，工作流已经落库了，
  // 原来这几步在 try 之外，失败就直接漏在用户列表里没人清。
  let workflowId = '';
  let triggerId = '';
  let browser = null;
  try {
    const wf = await api('/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: wfName, description: '连续失败展示验证', flowgram: JSON.stringify(flowgram) }),
    }, tok);
    workflowId = wf.data.id;
    if (!workflowId) throw new Error(`创建工作流失败 ${JSON.stringify(wf).slice(0, 200)}`);

    const pub = await api(`/workflows/${workflowId}/publish`, { method: 'POST', body: '{}' }, tok);
    if (!pub.ok) throw new Error(`发布失败 ${JSON.stringify(pub).slice(0, 200)}`);

    const trg = await api(`/workflows/${workflowId}/triggers`, {
      method: 'POST',
      body: JSON.stringify({ name: '展示验证探针', type: 'schedule', intervalMinutes: 1, staticInputs: { query: 'x' } }),
    }, tok);
    triggerId = trg.data.trigger?.id;
    if (!triggerId) throw new Error(`创建触发器失败 ${JSON.stringify(trg).slice(0, 200)}`);
    console.log('已挂定时触发器，等待真实调度失败…');

    // 等真实调度把它跑失败。
    //
    // 预算必须明显大于「一个 interval + 一个调度 tick」：新建触发器的 nextRunAt 是
    // now + intervalMinutes（1 分钟），调度器再按 WORKFLOW_SCHEDULE_TICK_SECONDS
    // （默认 30 秒）去捞到期行，所以首次执行最早落在 60 秒、最晚 90 秒，跑完并记录
    // 失败还要几秒。原来只等 30×3s=90s，正好卡在这个边界上——同一份代码有时会
    // 超时失败（实测：三次里挂一次），属于验收体系的假失败，不是产品缺陷。
    // 这里放宽到 50×3s=150s，并在仍超时时打印调度字段便于定位。
    const MAX_POLLS = 50;
    let failureCount = 0;
    let snapshot = null;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const tl = await api(`/workflows/${workflowId}/triggers`, {}, tok);
      const t = (tl.data.triggers || tl.data)[0];
      snapshot = t;
      failureCount = t.failureCount || 0;
      if (failureCount >= 1) {
        console.log(`真实调度已失败 ${failureCount} 次（lastRunStatus=${t.lastRunStatus}，第 ${i + 1} 次轮询）`);
        break;
      }
    }
    record('前置：真实调度已产生失败计数', failureCount >= 1, `failureCount=${failureCount}`);
    if (failureCount < 1) {
      console.error('调度未产生失败，无法验证界面');
      console.error('触发器快照:', JSON.stringify({
        status: snapshot?.status,
        nextRunAt: snapshot?.nextRunAt,
        lastRunAt: snapshot?.lastRunAt,
        lastRunStatus: snapshot?.lastRunStatus,
        intervalMinutes: snapshot?.intervalMinutes,
      }));
      throw new Error(`已等待 ${MAX_POLLS * 3}s 仍未产生失败；若 nextRunAt 仍在未来，说明等待预算或调度 tick 配置需要调整`);
    }

    // ── 真实浏览器验证界面 ──
    browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('#account').fill(ADMIN);
    await page.locator('#password').fill(PW);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);

    // 列表是 div 结构（非 table）：先按名称搜索缩小范围，再取该行内的「更多操作」按钮。
    const search = page.locator('input[type="search"], input[placeholder*="搜索"]').first();
    if (await search.count()) {
      await search.fill(wfName);
      await page.waitForTimeout(1500);
    }
    const nameEl = page.locator('.resource-name', { hasText: wfName }).first();
    await nameEl.waitFor({ timeout: 15000 });
    // 沿祖先找到第一个包含「更多操作」按钮的容器 = 该行
    const row = nameEl.locator('xpath=ancestor::div[.//button[@aria-label="更多操作"]][1]');
    await row.locator('button[aria-label="更多操作"]').first().click();
    await page.waitForTimeout(900);

    // Semi UI 的菜单渲染在 portal 里
    const menuItem = page.locator('.semi-dropdown-item', { hasText: '触发器' }).first();
    const menuOpen = (await page.locator('.semi-dropdown-item').count()) > 0;
    console.log(`  菜单项数量: ${await page.locator('.semi-dropdown-item').count()}`);
    record('T1 打开操作菜单并出现「触发器」项', menuOpen && (await menuItem.count()) > 0);

    await menuItem.click();
    await page.waitForTimeout(2500);

    const bodyText = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: 'gui-full-screenshots/trigger-failure-count.png' });

    // 抽屉标题含工作流名 = 确实打开了触发器抽屉
    record('T2 触发器抽屉已打开', bodyText.includes(`${wfName} · 触发器`), bodyText.includes('· 触发器') ? '已打开' : '未见抽屉标题');

    record(
      'T3 界面展示「连续失败 N 次」',
      new RegExp(`连续失败\\s*${failureCount}\\s*次`).test(bodyText),
      (bodyText.match(/连续失败[^\n]{0,20}/) || ['未出现「连续失败」'])[0],
    );
    record('T4 上次状态已译为中文「失败」', /上次\s*失败/.test(bodyText), (bodyText.match(/上次[^\n]{0,12}/) || ['未出现「上次」'])[0]);

  } finally {
    // 必须先关浏览器：改用 exitCode 而非 process.exit 后，句柄不释放进程就不会退出。
    await browser?.close().catch(() => {});
    // 触发器一定要带走。遗留的 1 分钟触发器会一直失败重试，占满该用户的并发名额，
    // 让完全不相干的套件随机报 concurrency_limit —— 实测库里就堆了 3 个「展示验证探针」
    // （连续失败 190 / 97 / 44 次），正好吃满 WORKFLOW_MAX_CONCURRENT_PER_USER=3。
    // 这一步共享清理件管不了（它只删工作流），所以显式保留。
    if (workflowId && triggerId) {
      await api(`/workflows/${workflowId}/triggers/${triggerId}`, { method: 'DELETE' }, tok).catch(() => {});
    }
    // 工作流走共享清理件：按前缀扫描，连此前中断残留的一起收拾。
    reportCleanup(
      await cleanupTestWorkflows({ gateway: B, token: tok, prefixes: [WORKFLOW_PREFIX] }),
      '连续失败展示工作流',
    );
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n===== 连续失败展示验证: ${passed}/${results.length} passed =====`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
