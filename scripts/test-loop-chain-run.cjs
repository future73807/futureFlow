#!/usr/bin/env node
'use strict';
// 端到端验证：循环体内多节点链（块开始 → 代码1 → 代码2 → 块结束）可试运行
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { existsSync } = require('node:fs');

const FRONT = 'http://localhost:3000';
const GATEWAY = 'http://localhost:3001';
const PW = process.argv[2] || adminPassword();

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const workflow = () => ({
  name: `循环多节点链-${Date.now()}`,
  flowgram: JSON.stringify({
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: { title: '开始', outputs: { type: 'object', properties: {} } },
      },
      {
        id: 'code_list',
        type: 'code',
        meta: { position: { x: 170, y: 0 } },
        data: {
          title: '生成数组',
          inputsValues: {},
          inputs: { type: 'object', properties: {} },
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
          // 循环输出指向链尾节点（第二个代码节点）
          loopOutputs: { result: { type: 'ref', content: ['loop_code2', 'result'] } },
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 0, y: 300 } }, data: {} },
          {
            id: 'loop_code',
            type: 'code',
            meta: { position: { x: 140, y: 250 } },
            data: {
              title: '逐项乘十',
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
              outputs: { type: 'object', properties: { result: { type: 'number', title: '中间结果' } } },
            },
          },
          {
            id: 'loop_code2',
            type: 'code',
            meta: { position: { x: 500, y: 250 } },
            data: {
              title: '再加一',
              inputsValues: {
                prev: { type: 'ref', content: ['loop_code', 'result'] },
              },
              inputs: {
                type: 'object',
                properties: { prev: { type: 'number', title: '上一步结果' } },
              },
              script: {
                language: 'javascript',
                content: 'function main({ params }) {\n  return { result: params.prev + 1 };\n}',
              },
              outputs: { type: 'object', properties: { result: { type: 'number', title: '处理结果' } } },
            },
          },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 860, y: 300 } }, data: {} },
        ],
        edges: [
          { sourceNodeID: 'loop_start', targetNodeID: 'loop_code' },
          { sourceNodeID: 'loop_code', targetNodeID: 'loop_code2' },
          { sourceNodeID: 'loop_code2', targetNodeID: 'loop_end' },
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
  await page.evaluate(async () => {
    const r = await fetch('http://localhost:3001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: adminPassword() }),
    });
    const j = await r.json();
    localStorage.setItem('futureflow_token', j.accessToken);
  });

  const created = await page.evaluate(async ({ gateway, body }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { gateway: GATEWAY, body: workflow() });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error('create failed: ' + JSON.stringify(created).slice(0, 400));
  }
  const wfId = created.json.id;
  console.log('workflow:', wfId);

  await page.goto(`${FRONT}/canvas/${wfId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

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
  console.log('run resp:', JSON.stringify(run.json).slice(0, 400));
  const runId = run.json?.taskId || run.json?.id || run.json?.runId;

  let output = null;
  let status = '';
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(1500);
    const rep = await page.evaluate(async ({ gateway, wfId, runId }) => {
      const token = localStorage.getItem('futureflow_token');
      const r = await fetch(`${gateway}/workflows/${wfId}/runs?page=1&pageSize=5`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return r.json();
    }, { gateway: GATEWAY, wfId, runId });
    const runs = Array.isArray(rep) ? rep : rep.items || [];
    const hit = runs.find((x) => (runId ? x.id === runId || x.taskId === runId : true)) || runs[0];
    status = String(hit?.status || '');
    if (['succeeded', 'success', 'failed', 'error'].includes(status.toLowerCase())) {
      output = hit?.output || hit?.outputs || hit?.result || hit;
      break;
    }
  }
  await browser.close();

  console.log('final status:', status);
  const result =
    output?.result ??
    output?.output?.result ??
    (output?.output && typeof output.output === 'object' ? output.output.result : undefined);
  console.log('result:', JSON.stringify(result));
  const ok = JSON.stringify(result) === JSON.stringify([11, 21, 31, 51]);
  if (!ok) console.log('raw output:', JSON.stringify(output).slice(0, 800));
  console.log(ok ? '[PASS] 循环多节点链输出 [11,21,31,51] —— 跑通' : `[FAIL] 期望 [11,21,31,51]，实际 ${JSON.stringify(result)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
