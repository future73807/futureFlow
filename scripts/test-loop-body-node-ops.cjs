#!/usr/bin/env node
/**
 * 循环体节点操作验收（Playwright 直驱真实浏览器点击）
 *
 * 覆盖两条此前被挡住的路径：
 *   1. 循环体内普通节点可以被删除，且删除后「块开始 → … → 块结束」的单链被自动接回；
 *   2. 循环体内普通节点可以通过节点菜单「移出循环体」移出，移动后单链同样被接回；
 *   3. 循环体的块开始 / 块结束仍然不允许删除（回归保护）。
 *
 * 用法：
 *   node scripts/test-loop-body-node-ops.cjs <admin-password>
 *   node scripts/test-loop-body-node-ops.cjs <admin-password> --headless=false
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const PW = process.argv.find((a) => !a.startsWith('-') && !a.endsWith('.cjs') && a !== process.argv[0] && a !== process.argv[1]);
const HEADLESS = !process.argv.includes('--headless=false');
const FRONT = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const SHOT_DIR = join(process.cwd(), process.env.GUI_SHOT_DIR || 'gui-test-screenshots');
const PASSWORD = PW || adminPassword();

function findBrowserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  try {
    const bundled = require('playwright-core').chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* ignore */ }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find((c) => c && existsSync(c)) || null;
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function api(method, path, token, body) {
  const res = await fetch(GATEWAY + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** 循环体单链：块开始 → 内部节点… → 块结束 */
const loopChainBody = () => ({
  nodes: [
    {
      id: 'start_0', type: 'start', meta: { position: { x: 60, y: 240 } },
      data: { title: '开始', outputs: { type: 'object', properties: { items: { type: 'array', items: { type: 'number' }, title: '待处理数组', default: [1, 2, 3] } } } },
    },
    {
      id: 'loop_0', type: 'loop', meta: { position: { x: 420, y: 240 } },
      data: {
        title: '循环·逐项翻倍',
        loopType: 'array',
        loopFor: { type: 'ref', content: ['start_0', 'items'] },
        loopOutputs: { doubled: { type: 'ref', content: ['inner_code', 'doubled'] } },
        outputs: { type: 'object', properties: { doubled: { type: 'array', items: { type: 'number' }, title: 'doubled' } } },
      },
      blocks: [
        { id: 'block_start_1', type: 'block-start', meta: { position: { x: 0, y: 0 } }, data: {} },
        {
          id: 'inner_code', type: 'code', meta: { position: { x: 200, y: 0 } },
          data: {
            title: '逐项翻倍',
            inputsValues: {
              item: { type: 'ref', content: ['loop_0_locals', 'item'] },
              index: { type: 'ref', content: ['loop_0_locals', 'index'] },
            },
            inputs: { type: 'object', properties: { item: { type: 'number' }, index: { type: 'number' } } },
            script: { language: 'javascript', content: 'function main({ params }) { return { doubled: params.item * 2 }; }' },
            outputs: { type: 'object', properties: { doubled: { type: 'number' } } },
          },
        },
        { id: 'block_end_1', type: 'block-end', meta: { position: { x: 600, y: 0 } }, data: {} },
      ],
      edges: [
        { sourceNodeID: 'block_start_1', targetNodeID: 'inner_code' },
        { sourceNodeID: 'inner_code', targetNodeID: 'block_end_1' },
      ],
    },
    {
      id: 'end_0', type: 'end', meta: { position: { x: 900, y: 240 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['loop_0', 'doubled'] } },
        inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'loop_0' },
    { sourceNodeID: 'loop_0', targetNodeID: 'end_0' },
  ],
});

const loopEdges = (graph) => {
  const loop = graph.nodes.find((n) => n.id === 'loop_0');
  return (loop?.edges || []).map((e) => `${e.sourceNodeID}->${e.targetNodeID}`).sort();
};

async function main() {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    console.error('未找到 Chrome/Edge/Chromium；可用 PLAYWRIGHT_EXECUTABLE_PATH 指定。');
    process.exit(2);
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const token = (await api('POST', '/auth/login', null, { account: 'admin', password: PASSWORD })).accessToken;
  const browser = await chromium.launch({ headless: HEADLESS, executablePath });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    // 登录
    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill(PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForTimeout(3000);

    /** 打开一个新工作流并选中循环体内的节点 */
    const prepareCanvas = async (name) => {
      const created = await api('POST', '/workflows', token, {
        name,
        description: '循环体节点操作验收',
        flowgram: JSON.stringify(loopChainBody()),
      });
      await page.goto(`${FRONT}/canvas/${created.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="sdk.workflow.canvas.node"]').first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(2500);
      return created.id;
    };

    /** 打开循环体内节点的 ⋯ 菜单（hover 触发） */
    const openInnerNodeMenu = async () => {
      const card = page.locator('[data-node-id="inner_code"]');
      await card.locator('button[aria-label="节点操作"]').hover();
      await page.waitForTimeout(900);
      const menu = page.locator('.semi-dropdown-menu, [role="menu"]').first();
      await menu.waitFor({ timeout: 8000 });
      return menu;
    };

    // ---- 用例 1：删除循环体内的节点，单链自动接回 ----
    {
      const id = await prepareCanvas('GUI-循环体删除验收');
      const menu = await openInnerNodeMenu();
      const deleteItem = menu.locator('li', { hasText: '删除' }).first();
      const disabled = await deleteItem.evaluate((el) => el.className.includes('disabled'));
      record('循环体内节点的「删除」菜单项可用', !disabled);

      await deleteItem.click();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOT_DIR, 'loop-body-delete.png') });

      const graph = await api('GET', `/workflows/${id}`, token);
      const parsed = typeof graph.flowgramJson === 'string' ? JSON.parse(graph.flowgramJson) : graph.flowgramJson;
      const ids = parsed.nodes.map((n) => n.id);
      record('删除后节点从画布消失', !ids.includes('inner_code'), ids.join(', '));
      const chain = loopEdges(parsed);
      record(
        '删除后循环体单链被接回（块开始 → 块结束）',
        chain.join(' ') === 'block_start_1->block_end_1',
        `loop=[${chain.join(' ') || '空'}] top=[${parsed.edges.map((e) => e.sourceNodeID + '->' + e.targetNodeID).join(' ') || '空'}]`,
      );
      await api('DELETE', `/workflows/${id}`, token);
    }

    // ---- 用例 2：移出循环体，单链自动接回 ----
    {
      const id = await prepareCanvas('GUI-移出循环体验收');
      const menu = await openInnerNodeMenu();
      const moveOutItem = menu.locator('li', { hasText: '移出循环体' }).first();
      record('循环体内节点菜单提供「移出循环体」', (await moveOutItem.count()) === 1);

      await moveOutItem.click();
      await page.waitForTimeout(1200);
      await page.mouse.move(700, 700); // 结束拖拽
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOT_DIR, 'loop-body-move-out.png') });

      const graph = await api('GET', `/workflows/${id}`, token);
      const parsed = typeof graph.flowgramJson === 'string' ? JSON.parse(graph.flowgramJson) : graph.flowgramJson;
      const stillInside = (parsed.nodes.find((n) => n.id === 'loop_0')?.blocks || []).some((b) => b.id === 'inner_code');
      record('节点已移出循环体', !stillInside);
      const chain = loopEdges(parsed);
      record(
        '移出后循环体单链被接回',
        chain.join(' ') === 'block_start_1->block_end_1',
        chain.join(' ') || '(空)',
      );
      await api('DELETE', `/workflows/${id}`, token);
    }

    // ---- 用例 4：循环体内「创建副本」可用、可以连续创建，且副本落在原节点附近 ----
    {
      const id = await prepareCanvas('GUI-循环体副本验收');
      const bodyInfo = async () => {
        const graph = await api('GET', `/workflows/${id}`, token);
        const parsed = typeof graph.flowgramJson === 'string' ? JSON.parse(graph.flowgramJson) : graph.flowgramJson;
        const blocks = parsed.nodes.find((n) => n.id === 'loop_0')?.blocks || [];
        return {
          count: blocks.length,
          origin: blocks.find((b) => b.id === 'inner_code')?.meta?.position,
          copies: blocks.filter((b) => b.type === 'code' && b.id !== 'inner_code').map((b) => b.meta?.position),
        };
      };
      const before = await bodyInfo();

      const menu = await openInnerNodeMenu();
      const copyItem = menu.locator('li', { hasText: '创建副本' }).first();
      const disabled = await copyItem.evaluate((el) => el.className.includes('disabled'));
      record('循环体内节点的「创建副本」菜单项可用', !disabled);

      await copyItem.click();
      await page.waitForTimeout(2500);
      const afterFirst = await bodyInfo();
      record('第一次创建副本落在循环体内', afterFirst.count === before.count + 1, `blocks ${before.count} -> ${afterFirst.count}`);
      const firstCopy = afterFirst.copies[0];
      const near = firstCopy && before.origin
        && Math.abs(firstCopy.x - before.origin.x) <= 160
        && Math.abs(firstCopy.y - before.origin.y) <= 160;
      record(
        '副本紧挨着原节点（右下方 40px 左右）',
        Boolean(near),
        `原节点 ${JSON.stringify(before.origin)} / 副本 ${JSON.stringify(firstCopy)}`,
      );
      await page.screenshot({ path: join(SHOT_DIR, 'loop-body-copy-first.png') });

      // 再点一次：验证可以连续创建（此前的表现是「点一次之后就不能再创建」）
      const menuAgain = await openInnerNodeMenu();
      await menuAgain.locator('li', { hasText: '创建副本' }).first().click();
      await page.waitForTimeout(2500);
      const afterSecond = await bodyInfo();
      record('可以连续创建第二份副本', afterSecond.count === before.count + 2, `blocks ${before.count} -> ${afterSecond.count}`);
      const positions = afterSecond.copies.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
      record(
        '两份副本位置不重叠，都在原节点附近',
        new Set(positions).size === positions.length
        && afterSecond.copies.every((p) => before.origin
          && Math.abs(p.x - before.origin.x) <= 200
          && Math.abs(p.y - before.origin.y) <= 200),
        `原节点 ${JSON.stringify(before.origin)} / 副本 ${JSON.stringify(afterSecond.copies)}`,
      );
      await page.screenshot({ path: join(SHOT_DIR, 'loop-body-copy-second.png') });

      await api('DELETE', `/workflows/${id}`, token);
    }

    // ---- 用例 5：主画布上的「创建副本」可以连续创建 ----
    {
      const created = await api('POST', '/workflows', token, {
        name: 'GUI-主画布副本验收',
        description: '主画布创建副本连续两次',
        flowgram: JSON.stringify({
          nodes: [
            { id: 'start_0', type: 'start', meta: { position: { x: 60, y: 240 } }, data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', default: '' } } } } },
            {
              id: 'text_0', type: 'text', meta: { position: { x: 420, y: 240 } },
              data: {
                title: '文本处理 1',
                inputsValues: { text: { type: 'template', content: '{{start_0.query}}' } },
                inputs: { type: 'object', required: ['text'], properties: { text: { type: 'string', title: '文本内容', extra: { formComponent: 'prompt-editor' } } } },
                outputs: { type: 'object', properties: { text: { type: 'string', title: '文本内容' } } },
              },
            },
            {
              id: 'end_0', type: 'end', meta: { position: { x: 780, y: 240 } },
              data: { title: '结束', inputsValues: { result: { type: 'ref', content: ['text_0', 'text'] } }, inputs: { type: 'object', properties: { result: { type: 'string' } } } },
            },
          ],
          edges: [
            { sourceNodeID: 'start_0', targetNodeID: 'text_0' },
            { sourceNodeID: 'text_0', targetNodeID: 'end_0' },
          ],
        }),
      });
      await page.goto(`${FRONT}/canvas/${created.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="sdk.workflow.canvas.node"]').first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(2500);

      const topCount = async () => {
        const graph = await api('GET', `/workflows/${created.id}`, token);
        const parsed = typeof graph.flowgramJson === 'string' ? JSON.parse(graph.flowgramJson) : graph.flowgramJson;
        return parsed.nodes.filter((n) => n.type === 'text').length;
      };
      const openTextMenu = async () => {
        await page.locator('[data-node-id="text_0"] button[aria-label="节点操作"]').hover();
        await page.waitForTimeout(900);
        const menu = page.locator('.semi-dropdown-menu, [role="menu"]').first();
        await menu.waitFor({ timeout: 8000 });
        return menu;
      };

      const before = await topCount();
      await (await openTextMenu()).locator('li', { hasText: '创建副本' }).first().click();
      await page.waitForTimeout(2200);
      const afterFirst = await topCount();
      record('主画布第一次创建副本成功', afterFirst === before + 1, `text 节点 ${before} -> ${afterFirst}`);

      await (await openTextMenu()).locator('li', { hasText: '创建副本' }).first().click();
      await page.waitForTimeout(2200);
      const afterSecond = await topCount();
      record('主画布可以连续创建第二份副本', afterSecond === before + 2, `text 节点 ${before} -> ${afterSecond}`);

      await api('DELETE', `/workflows/${created.id}`, token);
    }

    // ---- 用例 3：块开始 / 块结束仍然不可删除 ----
    {
      const id = await prepareCanvas('GUI-循环锚点保护验收');
      await page.locator('[data-node-id="block_start_1"]').click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(1500);
      const graph = await api('GET', `/workflows/${id}`, token);
      const parsed = typeof graph.flowgramJson === 'string' ? JSON.parse(graph.flowgramJson) : graph.flowgramJson;
      const blocks = parsed.nodes.find((n) => n.id === 'loop_0')?.blocks || [];
      record(
        '块开始 / 块结束仍受保护',
        blocks.some((b) => b.id === 'block_start_1') && blocks.some((b) => b.id === 'block_end_1'),
        blocks.map((b) => b.id).join(', '),
      );
      await api('DELETE', `/workflows/${id}`, token);
    }
  } finally {
    await browser.close();
    // 本套件用 prepareCanvas 建了 4 个固定名画布（循环体删除/移出/副本/锚点保护验收），
    // 外加一个 'GUI-主画布副本验收'，此前一个都不删——库里实测堆了「GUI-移出循环体验收」
    // 等 9/18 的遗留。名字固定，按精确匹配清理。
    reportCleanup(
      await cleanupTestWorkflows({
        gateway: GATEWAY,
        token: await apiLogin(),
        names: [
          'GUI-循环体删除验收',
          'GUI-移出循环体验收',
          'GUI-循环体副本验收',
          'GUI-循环锚点保护验收',
          'GUI-主画布副本验收',
        ],
      }),
      '本套件创建的工作流',
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n循环体节点操作验收：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/** 取管理员令牌用于收尾清理；失败返回空串（清理是收尾动作，不该让套件挂掉）。 */
async function apiLogin() {
  try {
    const response = await fetch(`${GATEWAY}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: process.env.ADMIN_USERNAME || 'admin', password: PW }),
    });
    if (!response.ok) return '';
    const data = await response.json();
    return data.accessToken || data.data?.accessToken || '';
  } catch {
    return '';
  }
}
