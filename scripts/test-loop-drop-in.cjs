#!/usr/bin/env node
'use strict';
// 验证：把画布上的节点拖进循环体（flowgram NodeIntoContainer 原生路径）
const { chromium } = require('playwright-core');
const { existsSync } = require('node:fs');

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const loopWorkflow = () => ({
  name: `拖入验证-${Date.now()}`,
  flowgram: JSON.stringify({
    nodes: [
      { id: 'start', type: 'start', meta: { position: { x: 0, y: 200 } },
        data: { title: '开始', outputs: { type: 'object', properties: { items: { type: 'array', items: { type: 'number' } } } } } },
      { id: 'extra', type: 'variable', meta: { position: { x: 60, y: 520 } },
        data: { title: '变量赋值' } },
      { id: 'loop', type: 'loop', meta: { position: { x: 420, y: 100 } },
        data: { title: '循环', loopType: 'array', loopFor: { type: 'ref', content: ['start', 'items'] },
          loopMiddleValues: {}, loopOutputs: { result: { type: 'ref', content: ['loop_code', 'result'] } },
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } } },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 96, y: 313 } }, data: {} },
          { id: 'loop_code', type: 'code', meta: { position: { x: 230, y: 252 } },
            data: { title: '逐项处理',
              inputsValues: { item: { type: 'ref', content: ['loop_locals', 'item'] }, index: { type: 'ref', content: ['loop_locals', 'index'] } },
              inputs: { type: 'object', properties: { item: { type: 'number', title: '当前项' }, index: { type: 'number', title: '序号' } } },
              script: { language: 'javascript', content: 'function main({ params }) {\n  return { result: params.item * 2 };\n}' },
              outputs: { type: 'object', properties: { result: { type: 'number', title: '处理结果' } } } } },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 616, y: 313 } }, data: {} } ],
        edges: [
          { sourceNodeID: 'loop_start', targetNodeID: 'loop_code' },
          { sourceNodeID: 'loop_code', targetNodeID: 'loop_end' } ] },
      { id: 'end', type: 'end', meta: { position: { x: 1250, y: 200 } },
        data: { title: '结束', inputsValues: { result: { type: 'ref', content: ['loop', 'result'] } },
          inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } } } } ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'loop' },
      { sourceNodeID: 'loop', targetNodeID: 'end' } ],
    globalVariable: { type: 'object', properties: {} },
  }),
});

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const wfid = await page.evaluate(async (body) => {
    const r = await fetch('http://localhost:3001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'futureFlow@' }),
    });
    const j = await r.json();
    localStorage.setItem('futureflow_token', j.accessToken);
    const wr = await fetch('http://localhost:3001/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + j.accessToken },
      body: JSON.stringify(body),
    });
    return (await wr.json()).id;
  }, loopWorkflow());
  await page.goto(`http://localhost:3000/canvas/${wfid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const read = () =>
    page.evaluate(() => {
      const body = document.querySelector('.node-type-loop .ff-loop-body').getBoundingClientRect();
      const extra = document.querySelector('[data-node-id="extra"]');
      return {
        body: { x: body.x, y: body.y, w: body.width, h: body.height },
        extra: extra
          ? (() => {
              const r = extra.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            })()
          : null,
      };
    });

  const m1 = await read();
  if (!m1.extra) { console.log('[FAIL] extra 节点不存在'); await browser.close(); process.exit(1); }
  console.log('before:', JSON.stringify(m1));

  // 把 extra 拖到循环体中心（HTML5 拖拽：原生事件序列）
  await page.mouse.move(m1.extra.x + m1.extra.w / 2, m1.extra.y + 12);
  await page.mouse.down();
  await page.mouse.move(m1.body.x + m1.body.w / 2, m1.body.y + m1.body.h / 2, { steps: 20 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/drag_over_body.png' });
  await page.mouse.up();
  await page.waitForTimeout(2000);

  const m2 = await read();
  console.log('after:', JSON.stringify(m2));
  const inside =
    m2.extra.x >= m2.body.x - 2 && m2.extra.x + m2.extra.w <= m2.body.x + m2.body.w + 2 &&
    m2.extra.y >= m2.body.y - 2 && m2.extra.y + m2.extra.h <= m2.body.y + m2.body.h + 2;
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/after_drag_in.png' });

  // 关键验证：成为循环子节点后，拖循环体空白 → 它应跟着一起动
  const pBody = await page.evaluate(() => {
    const b = document.querySelector('.node-type-loop .ff-loop-body').getBoundingClientRect();
    for (let dx = 20; dx < b.width - 20; dx += 12) {
      for (let dy = 20; dy < b.height - 20; dy += 12) {
        const x = b.x + dx;
        const y = b.y + dy;
        const el = document.elementFromPoint(x, y);
        if (el && String(el.className).includes('ff-loop-body')) return { x, y };
      }
    }
    return null;
  });
  let childMoved = false;
  if (pBody) {
    const before = await read();
    await page.mouse.move(pBody.x, pBody.y);
    await page.mouse.down();
    await page.mouse.move(pBody.x - 60, pBody.y - 30, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const after = await read();
    const dx = after.extra.x - before.extra.x;
    const dy = after.extra.y - before.extra.y;
    console.log('body moved:', JSON.stringify({ extra: [dx, dy] }));
    childMoved = Math.abs(dx) > 40;
  }
  await browser.close();
  console.log(inside ? '[PASS] 节点拖入循环体成功' : '[FAIL] 拖入未生效');
  console.log(childMoved ? '[PASS] 拖入的节点是循环体子节点（随框移动）' : '[FAIL] 节点未真正挂到循环体');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
