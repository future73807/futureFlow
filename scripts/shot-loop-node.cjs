#!/usr/bin/env node
'use strict';
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
  name: '循环节点视觉核对',
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
            properties: {
              items: { type: 'array', items: { type: 'object' } },
            },
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
          loopOutputs: {
            result: { type: 'ref', content: ['loop_code', 'result'] },
          },
          outputs: {
            type: 'object',
            properties: {
              result: { type: 'array', items: { type: 'number' } },
            },
          },
        },
        blocks: [
          {
            id: 'loop_start',
            type: 'block-start',
            meta: { position: { x: 114, y: 180 } },
            data: {},
          },
          {
            id: 'loop_code',
            type: 'code',
            meta: { position: { x: 220, y: 156 } },
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
              script: {
                language: 'javascript',
                content: 'function main({ params }) {\n  return { result: params.item * 2 };\n}',
              },
              outputs: {
                type: 'object',
                properties: { result: { type: 'number', title: '处理结果' } },
              },
            },
          },
          {
            id: 'loop_end',
            type: 'block-end',
            meta: { position: { x: 666, y: 180 } },
            data: {},
          },
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
          inputsValues: {
            result: { type: 'ref', content: ['loop', 'result'] },
          },
          inputs: {
            type: 'object',
            properties: {
              result: { type: 'array', items: { type: 'number' } },
            },
          },
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

  // 1. login via UI to get token
  await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(PW);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2000);
  const token = await page.evaluate(() => localStorage.getItem('futureflow_token'));
  if (!token) throw new Error('login failed: no token');

  // 2. create workflow via gateway API
  const res = await page.evaluate(async ({ gateway, body }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { gateway: GATEWAY, body: loopWorkflow() });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error('create workflow failed: ' + JSON.stringify(res).slice(0, 400));
  }
  const wfId = res.json.id || res.json.workflow?.id;
  console.log('workflow created:', wfId);

  // 3. open canvas
  await page.goto(`${FRONT}/canvas/${wfId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: join(OUT, 'loop_before.png'), fullPage: false });

  // 4. select loop node to see side panel（点击卡片本体：卡片在 DOM 内有 156px 缩进）
  const loopNode = page.locator('.node-type-loop .ff-loop-card').first();
  if (await loopNode.count()) {
    await loopNode.click({ position: { x: 70, y: 15 } });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'loop_before_panel.png'), fullPage: false });
  } else {
    console.log('WARN: .node-type-loop not found');
  }

  await browser.close();
  // 清理本套件创建的固定名工作流（此前不清理，库里堆了 15 个）

  reportCleanup(
    await cleanupTestWorkflows({ gateway: GATEWAY, token: await apiLogin(), names: ['循环节点视觉核对'] }),
    '本套件创建的工作流',
  );

  console.log('screenshots written to', OUT);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; });

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
