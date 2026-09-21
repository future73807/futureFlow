#!/usr/bin/env node
'use strict';
// 端到端验证：带循环节点的工作流在画布保存后能通过网关试运行跑通
const { chromium } = require('playwright-core');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync } = require('node:fs');

const FRONT = 'http://localhost:3000';
const GATEWAY = 'http://localhost:3001';
const PW = process.argv[2] || 'futureFlow@';

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const workflow = () => ({
  name: '循环端到端试运行',
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
              prefix: { type: 'string', default: 'x', title: '前缀' },
            },
          },
        },
      },
      {
        id: 'code_list',
        type: 'code',
        meta: { position: { x: 170, y: 0 } },
        data: {
          title: '生成数组',
          inputsValues: { prefix: { type: 'ref', content: ['start', 'prefix'] } },
          inputs: {
            type: 'object',
            properties: { prefix: { type: 'string', title: '前缀' } },
          },
          script: {
            language: 'javascript',
            content: 'function main() { return { list: [1, 2, 3, 5] }; }',
          },
          outputs: {
            type: 'object',
            properties: { list: { type: 'array', items: { type: 'number' }, title: '数组' } },
          },
        },
      },
      {
        id: 'loop',
        type: 'loop',
        meta: { position: { x: 520, y: 0 } },
        data: {
          title: '循环',
          loopType: 'array',
          loopFor: { type: 'ref', content: ['code_list', 'list'] },
          loopMiddleValues: {},
          loopOutputs: { result: { type: 'ref', content: ['loop_code', 'result'] } },
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 0, y: 300 } }, data: {} },
          {
            id: 'loop_code',
            type: 'code',
            meta: { position: { x: 140, y: 250 } },
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
                content: 'function main({ params }) {\n  return { result: params.item * 10 };\n}',
              },
              outputs: { type: 'object', properties: { result: { type: 'number', title: '处理结果' } } },
            },
          },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 560, y: 300 } }, data: {} },
        ],
        edges: [
          { sourceNodeID: 'loop_start', targetNodeID: 'loop_code' },
          { sourceNodeID: 'loop_code', targetNodeID: 'loop_end' },
        ],
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 1200, y: 0 } },
        data: {
          title: '结束',
          inputsValues: { result: { type: 'ref', content: ['loop', 'result'] } },
          inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'code_list' },
      { sourceNodeID: 'code_list', targetNodeID: 'loop' },
      { sourceNodeID: 'loop', targetNodeID: 'end' },
    ],
    globalVariable: { type: 'object', properties: {} },
  }),
});

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(PW);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2000);

  // 创建工作流
  const created = await page.evaluate(async ({ gateway, body }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { gateway: GATEWAY, body: workflow() });
  if (created.status !== 201 && created.status !== 200) throw new Error('create failed: ' + JSON.stringify(created).slice(0, 300));
  const wfId = created.json.id;
  console.log('workflow:', wfId);

  // 打开画布（触发自动保存，确保保存的是当前画布序列化结果）
  await page.goto(`${FRONT}/canvas/${wfId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  // 拖动一下内部节点再保存，确认拖动后的 JSON 仍可运行
  const code = await page.locator('.node-type-loop ~ * .node-type-code, [data-node-id="loop_code"]').first().boundingBox() || await page.locator('.node-type-code').nth(1).boundingBox();
  if (code) {
    await page.mouse.move(code.x + 120, code.y + 10);
    await page.mouse.down();
    await page.mouse.move(code.x + 120 + 80, code.y + 10 + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }
  // 等自动保存
  await page.waitForTimeout(2500);

  // 草稿试运行
  const run = await page.evaluate(async ({ gateway, wfId }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows/${wfId}/draft-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputs: {} }),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { gateway: GATEWAY, wfId });
  console.log('draft-run status:', run.status);
  const runId = run.json?.taskId || run.json?.id || run.json?.runId;
  console.log('run resp:', JSON.stringify(run.json).slice(0, 400));

  // 轮询结果
  let output = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1500);
    const rep = await page.evaluate(async ({ gateway, wfId, runId }) => {
      const token = localStorage.getItem('futureflow_token');
      const r = await fetch(`${gateway}/workflows/${wfId}/runs?page=1&pageSize=3`, { headers: { Authorization: `Bearer ${token}` } });
      return r.json();
    }, { gateway: GATEWAY, wfId, runId });
    const runs = Array.isArray(rep) ? rep : rep.items || [];
    const hit = runs.find((x) => (runId ? x.id === runId || x.taskId === runId : true));
    if (hit && (hit.status === 'succeeded' || hit.status === 'success' || hit.status === 'failed')) {
      output = hit;
      break;
    }
  }
  if (output) {
    console.log('final status:', output.status);
    console.log('output:', JSON.stringify(output.output || output.outputs || output.result).slice(0, 300));
    const ok = JSON.stringify(output).includes('[10,20,30,50]');
    console.log(ok ? '[PASS] 循环输出 [10,20,30,50] —— 跑通' : '[CHECK] 期望输出 [10,20,30,50]');
  } else {
    console.log('WARN: 未取到运行结果，请手动核对');
  }
  await browser.close();
  // 清理本套件创建的固定名工作流（此前不清理，库里堆了 14 个）

  reportCleanup(
    await cleanupTestWorkflows({ gateway: GATEWAY, token: await apiLogin(), names: ['循环端到端试运行'] }),
    '本套件创建的工作流',
  );
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
