#!/usr/bin/env node
'use strict';
// 验证：空循环体 → 从面板加节点到循环体内 → 自由连线（左圆点→节点→右圆点）
const { chromium } = require('playwright-core');
const { existsSync } = require('node:fs');

const FRONT = 'http://localhost:3000';
const GATEWAY = 'http://localhost:3001';

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const workflow = () => ({
  name: `自由连线-${Date.now()}`,
  flowgram: JSON.stringify({
    nodes: [
      { id: 'start', type: 'start', meta: { position: { x: 0, y: 200 } },
        data: { title: '开始', outputs: { type: 'object', properties: { items: { type: 'array', items: { type: 'number' } } } } } },
      { id: 'loop', type: 'loop', meta: { position: { x: 420, y: 100 } },
        data: { title: '循环', loopType: 'array', loopFor: { type: 'ref', content: ['start', 'items'] },
          loopMiddleValues: {}, loopOutputs: {}, outputs: { type: 'object', properties: {} } },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 0, y: 313 } }, data: {} },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 496, y: 313 } }, data: {} },
        ],
        edges: [] },
      { id: 'end', type: 'end', meta: { position: { x: 1250, y: 200 } }, data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'loop' },
      { sourceNodeID: 'loop', targetNodeID: 'end' },
    ],
    globalVariable: { type: 'object', properties: {} },
  }),
});

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 950 } })).newPage();
  await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const r = await fetch('http://localhost:3001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'futureFlow@' }),
    });
    const j = await r.json();
    localStorage.setItem('futureflow_token', j.accessToken);
  });
  const wfId = await page.evaluate(async ({ gateway, body }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await r.json()).id;
  }, { gateway: GATEWAY, body: workflow() });
  await page.goto(`${FRONT}/canvas/${wfId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // 1) 面板添加代码节点（面板点击会加在画布上，之后拖进循环体）
  const addBtn = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="添加节点"]');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(addBtn.x, addBtn.y);
  await page.waitForTimeout(1000);
  const pick = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const b = Array.from(dialog.querySelectorAll('button')).find((x) => (x.innerText || '').includes('变量赋值'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pick) { console.log('[SKIP] 面板无可用代码节点（可能专业版受限）'); }
  let newNodeId = null;
  if (pick) {
    await page.mouse.click(pick.x, pick.y);
    await page.waitForTimeout(1500);
    // 新节点 id
    newNodeId = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('.gedit-flow-render-layer .gedit-flow-activity-node')).map((n) => n.getAttribute('data-node-id'));
      return ids.find((id) => !['start', 'loop', 'end', 'loop_start', 'loop_end'].includes(id)) || null;
    });
  }
  console.log('new node:', newNodeId);

  // 2) 把新节点拖进循环体
  if (newNodeId) {
    // 关闭节点面板弹层，避免干扰后续拖拽
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const diag1 = await page.evaluate((id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      const body = document.querySelector('.node-type-loop .ff-loop-body');
      const r = el ? el.getBoundingClientRect() : null;
      const b = body ? body.getBoundingClientRect() : null;
      const dlg = !!document.querySelector('[role="dialog"]');
      return {
        nodeRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        bodyRect: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null,
        dialogOpen: dlg,
      };
    }, newNodeId);
    console.log('diag1:', JSON.stringify(diag1));
    // 先点一下新节点（聚焦/选中，清掉面板按钮的焦点残留），再拖动
    const clickPos = await page.evaluate((id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.x + 140, y: r.y + 8 };
    }, newNodeId);
    await page.mouse.click(clickPos.x, clickPos.y);
    await page.waitForTimeout(800);
    const pos = await page.evaluate((id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.x + 140, y: r.y + 8 };
    }, newNodeId);
    const bodyCenter = await page.evaluate(() => {
      const b = document.querySelector('.node-type-loop .ff-loop-body').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.down();
    await page.mouse.move(bodyCenter.x, bodyCenter.y, { steps: 18 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const diag2 = await page.evaluate((id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      const body = document.querySelector('.node-type-loop .ff-loop-body');
      const r = el.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      return {
        nodeRect: { x: Math.round(r.x), y: Math.round(r.y) },
        bodyRect: { x: Math.round(b.x), y: Math.round(b.y) },
        inside: r.x >= b.x - 2 && r.right <= b.right + 2 && r.y >= b.y - 2 && r.bottom <= b.bottom + 2,
      };
    }, newNodeId);
    console.log('diag2:', JSON.stringify(diag2));
    // 内存态验证：拖循环体空白，节点应随之移动（证明确实挂在循环体下）
    const bodyPt = await page.evaluate(() => {
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
    if (bodyPt) {
      const before = await page.evaluate((id) => {
        const r = document.querySelector(`[data-node-id="${id}"]`).getBoundingClientRect();
        return { x: r.x, y: r.y };
      }, newNodeId);
      await page.mouse.move(bodyPt.x, bodyPt.y);
      await page.mouse.down();
      await page.mouse.move(bodyPt.x - 60, bodyPt.y - 30, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
      const after = await page.evaluate((id) => {
        const r = document.querySelector(`[data-node-id="${id}"]`).getBoundingClientRect();
        return { x: r.x, y: r.y };
      }, newNodeId);
      console.log(
        'child-move check:',
        JSON.stringify({ dx: +(after.x - before.x).toFixed(1), dy: +(after.y - before.y).toFixed(1) })
      );
    }
  }

  // 3) 自由连线：左圆点 → 节点输入；节点输出 → 右圆点
  // 端口坐标优先取端口渲染 DOM（.workflow-port-render），没有则退回节点盒中心
  const draw = async (fromSel, toSel, prefer) => {
    const pts = await page.evaluate(({ fromSel: f, toSel: t, prefer: p }) => {
      const resolve = (sel, side) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const ports = Array.from(node.querySelectorAll('.workflow-port-render'));
        if (ports.length > 0) {
          // 按横向位置取最左/最右端口
          ports.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
          const el = side === 'right' ? ports[ports.length - 1] : ports[0];
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        const r = node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const from = resolve(f, 'right');
      const to = resolve(t, p === 'right' ? 'right' : 'left');
      if (!from || !to) return null;
      return { from, to };
    }, { fromSel, toSel, prefer });
    if (!pts) return false;
    await page.mouse.move(pts.from.x, pts.from.y);
    await page.mouse.down();
    await page.mouse.move(pts.to.x, pts.to.y, { steps: 20 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(800);
    return true;
  };

  if (newNodeId) {
    await draw('[data-node-id="loop_start"]', `[data-node-id="${newNodeId}"]`, 'left');
    // 节点输出（右边端口）→ 右圆点：目标是圆点节点，取它的中心
    const outPort = await page.evaluate((id) => {
      const node = document.querySelector(`[data-node-id="${id}"]`);
      const ports = Array.from(node.querySelectorAll('.workflow-port-render'));
      if (ports.length > 0) {
        ports.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
        const r = ports[ports.length - 1].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      const r = node.getBoundingClientRect();
      return { x: r.right, y: r.y + r.height / 2 };
    }, newNodeId);
    const endDot = await page.evaluate(() => {
      const dot = document.querySelector('[data-node-id="loop_end"]');
      const r = dot.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    await page.mouse.move(outPort.x, outPort.y);
    await page.mouse.down();
    await page.mouse.move(endDot.x, endDot.y, { steps: 20 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  // 等待画布自动保存完成（保存状态回到「已保存」）
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const status = await page.evaluate(() => {
      const el = document.querySelector('.canvas-save-status');
      return el ? el.textContent.trim() : '';
    });
    if (status.includes('已保存')) break;
  }

  // 4) 读取保存的模型，验证内部连线
  const model = await page.evaluate(async ({ gateway, wfId }) => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch(`${gateway}/workflows/${wfId}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    const loop = (j.flowgramJson.nodes || []).find((n) => n.id === 'loop');
    return { blocks: (loop.blocks || []).map((b) => ({ id: b.id, type: b.type })), edges: loop.edges || [] };
  }, { gateway: GATEWAY, wfId });
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/free-connect.png' });
  await browser.close();

  console.log('model blocks:', JSON.stringify(model.blocks));
  console.log('inner edges:', JSON.stringify(model.edges));
  const hasIntoNode = newNodeId && model.edges.some((e) => e.sourceNodeID === 'loop_start' && e.targetNodeID === newNodeId);
  const hasOutOfNode = newNodeId && model.edges.some((e) => e.sourceNodeID === newNodeId && e.targetNodeID === 'loop_end');
  const inBody = newNodeId && model.blocks.some((b) => b.id === newNodeId);
  console.log(
    inBody && hasIntoNode && hasOutOfNode
      ? '[PASS] 节点拖入循环体并自由连线成功'
      : `[CHECK] inBody=${inBody} intoNode=${hasIntoNode} outOfNode=${hasOutOfNode}`
  );
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
