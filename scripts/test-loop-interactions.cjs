#!/usr/bin/env node
'use strict';
// 循环节点交互验证：展开/收缩、框随节点伸缩、整体拖动、选中面板
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const FRONT = process.env.FRONTEND_URL || 'http://localhost:3000';
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3001';
const PW = process.argv[2] || adminPassword();
const OUT = process.env.SHOT_DIR || join(process.cwd(), 'gui-test-screenshots');

function findBrowser() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return c.find((p) => existsSync(p));
}

const loopWorkflow = () => ({
  name: '循环交互验证',
  flowgram: JSON.stringify({
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'object' } } },
          },
        },
      },
      {
        id: 'loop',
        type: 'loop',
        meta: { position: { x: 300, y: 0 } },
        data: {
          title: '循环',
          loopType: 'array',
          loopFor: { type: 'ref', content: ['start', 'items'] },
          loopMiddleValues: {},
          loopOutputs: { result: { type: 'ref', content: ['loop_code', 'result'] } },
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 0, y: 300 } }, data: {} },
          {
            id: 'loop_code',
            type: 'code',
            meta: { position: { x: 124, y: 240 } },
            data: {
              title: '逐项处理',
              inputsValues: {
                item: { type: 'ref', content: ['loop_locals', 'item'] },
                index: { type: 'ref', content: ['loop_locals', 'index'] },
              },
              inputs: {
                type: 'object',
                properties: {
                  item: { type: 'number', title: '当前项' },
                  index: { type: 'number', title: '序号' },
                },
              },
              script: { language: 'javascript', content: 'function main({ params }) {\n  return { result: params.item * 2 };\n}' },
              outputs: { type: 'object', properties: { result: { type: 'number', title: '处理结果' } } },
            },
          },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 520, y: 300 } }, data: {} },
        ],
        edges: [
          { sourceNodeID: 'loop_start', targetNodeID: 'loop_code' },
          { sourceNodeID: 'loop_code', targetNodeID: 'loop_end' },
        ],
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 1100, y: 0 } },
        data: {
          title: '结束',
          inputsValues: { result: { type: 'ref', content: ['loop', 'result'] } },
          inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'loop' },
      { sourceNodeID: 'loop', targetNodeID: 'end' },
    ],
    globalVariable: { type: 'object', properties: {} },
  }),
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300)); });

  await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(PW);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2000);
  const token = await page.evaluate(() => localStorage.getItem('futureflow_token'));
  if (!token) throw new Error('login failed');

  const res = await page.evaluate(async ({ gateway, body }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { gateway: GATEWAY, body: loopWorkflow() });
  if (res.status !== 201 && res.status !== 200) throw new Error('create failed: ' + JSON.stringify(res).slice(0, 300));
  const wfId = res.json.id || res.json.workflow?.id;

  await page.goto(`${FRONT}/canvas/${wfId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: join(OUT, 'it_1_initial.png') });

  const card = page.locator('.node-type-loop .ff-loop-card').first();
  if (!(await card.count())) throw new Error('loop card not found');
  const cardBox = await card.boundingBox();
  console.log('card box:', JSON.stringify(cardBox));

  // 选中卡片 → 侧栏出现
  await card.click({ position: { x: 80, y: 20 } });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'it_2_selected.png') });

  // 收缩：点击折叠按钮（aria-label=折叠节点）
  const collapseBtn = page.locator('.node-type-loop [aria-label="折叠节点"]').first();
  if (await collapseBtn.count()) {
    await collapseBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT, 'it_3_collapsed.png') });
    const frame = await page.locator('.node-type-loop .ff-loop-body').count();
    const innerNode = await page.locator('.node-type-loop ~ * .node-type-batch_code, .gedit-flow-render-layer .node-type-code').count();
    console.log('after collapse: frame count =', frame);
    // 展开恢复
    const expandBtn = page.locator('.node-type-loop [aria-label="展开节点"]').first();
    if (await expandBtn.count()) {
      await expandBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(OUT, 'it_4_expanded_back.png') });
      const frame2 = await page.locator('.node-type-loop .ff-loop-body').count();
      console.log('after re-expand: frame count =', frame2);
    } else {
      console.log('WARN: expand button not found');
    }
  } else {
    console.log('WARN: collapse button not found');
  }

  // 拖动内部代码节点向右下 → 框应自动伸缩
  const codeNode = page.locator('.gedit-flow-render-layer [data-node-id="loop_code"], .node-type-code').first();
  if (await codeNode.count()) {
    const b = await codeNode.boundingBox();
    if (b) {
      await page.mouse.move(b.x + b.width / 2, b.y + 10);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 160, b.y + 90, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(OUT, 'it_5_after_drag_inner.png') });
      const frameBox = await page.locator('.node-type-loop .ff-loop-body').first().boundingBox();
      console.log('frame box after inner drag:', JSON.stringify(frameBox));
    }
  } else {
    console.log('WARN: inner code node not found');
  }

  // 拖动循环卡片 → 整体（含内部节点）移动
  const cardBox2 = await card.boundingBox();
  const frameBefore = await page.locator('.node-type-loop .ff-loop-body').first().boundingBox();
  if (cardBox2) {
    await page.mouse.move(cardBox2.x + 80, cardBox2.y + 20);
    await page.mouse.down();
    await page.mouse.move(cardBox2.x + 80 - 200, cardBox2.y + 20 - 60, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'it_6_after_drag_card.png') });
    const cardBox3 = await card.boundingBox();
    const frameAfter = await page.locator('.node-type-loop .ff-loop-body').first().boundingBox();
    console.log('card moved by:', cardBox3 && cardBox2 ? JSON.stringify({ dx: cardBox3.x - cardBox2.x, dy: cardBox3.y - cardBox2.y }) : 'n/a');
    console.log('frame moved by:', frameAfter && frameBefore ? JSON.stringify({ dx: frameAfter.x - frameBefore.x, dy: frameAfter.y - frameBefore.y }) : 'n/a');
  }

  await browser.close();

  // 清理本套件创建的固定名工作流（此前不清理，库里堆了 31 个「循环交互验证」）
  reportCleanup(
    await cleanupTestWorkflows({ gateway: GATEWAY, token: await apiLogin(), names: ['循环交互验证'] }),
    '本套件创建的工作流',
  );

  console.log('interaction shots written to', OUT);
}

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

main().catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; });
