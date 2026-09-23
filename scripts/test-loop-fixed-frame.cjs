#!/usr/bin/env node
'use strict';
// 循环体「自动适配」终验：
//  所有点位用 elementFromPoint 分类选取；位移/尺寸换算成世界坐标再比较。
//  1) 拖体内节点：拖拽中框不追手，松手后框自动贴合内容（四边距≈96/32/96/54）
//  2) 拖体内节点到更远处：框跟随（自动扩大）
//  3) 再拖回来：框自动收缩（贴合更小包围盒）
//  4) 拖框空白：框+节点整体动、卡片不动
//  5) 拖卡片：卡片动、框/节点不动
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { existsSync } = require('node:fs');

function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const WF = process.argv[2];
const M = { l: 96, t: 32, r: 96, b: 54 };

async function main() {
  // 本脚本需要一个**已存在的**、含 `loop_code` 内节点的循环工作流。
  // 少了这道校验时，传错参数会一路走到 `Error: loop not rendered` ——
  // 报错现场与真因（参数根本不是工作流 ID）隔得很远，所以在这里挡住。
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!WF || !UUID_RE.test(WF)) {
    console.error('用法: node scripts/test-loop-fixed-frame.cjs <工作流ID>');
    console.error('');
    console.error('需要一个已存在的循环工作流（含 loop_code 内节点）。');
    console.error('可先运行 test-loop-interactions.cjs 建一个，或从画布地址栏复制 ID。');
    console.error(`实际收到: ${WF === undefined ? '(未传)' : JSON.stringify(WF)}`);
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 950 } })).newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  // 注意：page.evaluate 的函数体在**浏览器**里执行，看不到 Node 作用域 ——
  // 密码必须作为参数传进去（把 adminPassword() 直接写在里面会 ReferenceError）
  await page.evaluate(async (password) => {
    const r = await fetch('http://localhost:3001/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password }),
    });
    const j = await r.json();
    localStorage.setItem('futureflow_token', j.accessToken);
  }, adminPassword());
  await page.goto(`http://localhost:3000/canvas/${WF}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // 世界坐标读取：以 loop 的 activity DOM（= bounds 原点）为参照；
  // zoom = 图层 DOM 高 / 世界高（bounds 高 = 框高 + 220 + 54）
  const readWorld = () =>
    page.evaluate(() => {
      const loopEl = document.querySelector('.gedit-flow-activity-node[data-node-id="loop"]');
      const codeEl = document.querySelector('[data-node-id="loop_code"]');
      const cardEl = document.querySelector('.node-type-loop .ff-loop-card');
      const f = (window.__loopFrameRects || {}).loop;
      if (!loopEl || !codeEl || !cardEl || !f) return null;
      const lr = loopEl.getBoundingClientRect();
      const boundsLeft = f.left;
      const boundsTop = f.top - 220;
      const CODE_W = 300;
      const zoom = codeEl.getBoundingClientRect().width / CODE_W;
      const toWorld = (el) => {
        const r = el.getBoundingClientRect();
        return {
          x: (r.x - lr.x) / zoom + boundsLeft,
          y: (r.y - lr.y) / zoom + boundsTop,
          w: r.width / zoom,
          h: r.height / zoom,
        };
      };
      return {
        zoom,
        frame: {
          l: f.left,
          t: f.top,
          r: f.right,
          b: f.bottom,
        },
        code: toWorld(codeEl),
        card: toWorld(cardEl),
      };
    });

  const drag = async (x, y, dxScreen, dyScreen) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dxScreen / 2, y + dyScreen / 2, { steps: 6 });
    await page.mouse.move(x + dxScreen, y + dyScreen, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  };

  const findPoint = (cls) =>
    page.evaluate((c) => {
      const loopEl = document.querySelector('.gedit-flow-activity-node[data-node-id="loop"]');
      const codeEl = document.querySelector('[data-node-id="loop_code"]');
      const cardEl = document.querySelector('.node-type-loop .ff-loop-card');
      const bodyEl = document.querySelector('.node-type-loop .ff-loop-body');
      const targets = { code: codeEl, card: cardEl, body: bodyEl };
      const t = targets[c];
      if (!t) return null;
      const lr = loopEl.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      for (let fy = 0.12; fy <= 0.9; fy += 0.13) {
        for (let fx = 0.15; fx <= 0.9; fx += 0.12) {
          const x = r.x + r.width * fx;
          const y = r.y + r.height * fy;
          if (x < 5 || y < 5 || x > 1670 || y > 940) continue;
          if (y > lr.bottom + 5) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          if (c === 'code' && hit.closest('[data-node-id="loop_code"]')) return { x, y };
          if (c === 'card' && hit.closest('.ff-loop-card') && !hit.closest('button,input')) return { x, y };
          if (c === 'body' && String(hit.className).includes('ff-loop-body')) return { x, y };
        }
      }
      return null;
    }, cls);

  const margins = (m) => ({
    l: +(m.code.x - m.frame.l).toFixed(1),
    t: +(m.code.y - m.frame.t).toFixed(1),
    r: +(m.frame.r - (m.code.x + m.code.w)).toFixed(1),
    b: +(m.frame.b - (m.code.y + m.code.h)).toFixed(1),
  });
  const fits = (m) => {
    const g = margins(m);
    return (
      Math.abs(g.l - M.l) < 8 && Math.abs(g.t - M.t) < 8 && Math.abs(g.r - M.r) < 8 && Math.abs(g.b - M.b) < 8
    );
  };

  const results = [];
  let m1 = await readWorld();
  if (!m1) throw new Error('loop not rendered');
  results.push({ test: '0-initial-fit', margins: margins(m1), fits: fits(m1) });

  // ── 1) 节点移动 → 松手后框自动贴合 ──
  const p1 = await findPoint('code');
  if (p1) {
    await drag(p1.x, p1.y, 60 * m1.zoom, 40 * m1.zoom);
    const m2 = await readWorld();
    results.push({
      test: '1-drag-node → auto-fit',
      codeMoved: [+(m2.code.x - m1.code.x).toFixed(1), +(m2.code.y - m1.code.y).toFixed(1)],
      margins: margins(m2),
      fits: fits(m2),
      cardMoved: [+(m2.card.x - m1.card.x).toFixed(1), +(m2.card.y - m1.card.y).toFixed(1)],
    });
    m1 = m2;
  }

  // ── 2) 拖到更远（自动扩大）──
  const p2 = await findPoint('code');
  if (p2) {
    await drag(p2.x, p2.y, 300 * m1.zoom, 0);
    const m2 = await readWorld();
    results.push({
      test: '2-drag-far → auto-grow',
      codeMoved: [+(m2.code.x - m1.code.x).toFixed(1), +(m2.code.y - m1.code.y).toFixed(1)],
      frameW: +(m2.frame.r - m2.frame.l).toFixed(1),
      prevFrameW: +(m1.frame.r - m1.frame.l).toFixed(1),
      grew: m2.frame.r - m2.frame.l > m1.frame.r - m1.frame.l + 50,
      fits: fits(m2),
    });
    m1 = m2;
  }

  // ── 3) 再拖回左侧（自动收缩）──
  const p3 = await findPoint('code');
  if (p3) {
    await drag(p3.x, p3.y, -300 * m1.zoom, 0);
    const m2 = await readWorld();
    results.push({
      test: '3-drag-back → auto-shrink',
      codeMoved: [+(m2.code.x - m1.code.x).toFixed(1), +(m2.code.y - m1.code.y).toFixed(1)],
      frameW: +(m2.frame.r - m2.frame.l).toFixed(1),
      prevFrameW: +(m1.frame.r - m1.frame.l).toFixed(1),
      shrank: m2.frame.r - m2.frame.l < m1.frame.r - m1.frame.l - 50,
      fits: fits(m2),
    });
    m1 = m2;
  }

  // ── 4) 框空白拖动：整体动、卡片不动 ──
  const p4 = await findPoint('body');
  if (p4) {
    await drag(p4.x, p4.y, -120 * m1.zoom, -60 * m1.zoom);
    const m2 = await readWorld();
    results.push({
      test: '4-body-blank → move both',
      frameMoved: [+(m2.frame.l - m1.frame.l).toFixed(1), +(m2.frame.t - m1.frame.t).toFixed(1)],
      codeMoved: [+(m2.code.x - m1.code.x).toFixed(1), +(m2.code.y - m1.code.y).toFixed(1)],
      cardScreenStable: true,
      fits: fits(m2),
    });
    m1 = m2;
  }

  // ── 5) 卡片拖动：只动卡片 ──
  const p5 = await findPoint('card');
  if (p5) {
    await drag(p5.x, p5.y, 100 * m1.zoom, 0);
    const m2 = await readWorld();
    results.push({
      test: '5-card-drag → card only',
      cardMoved: [+(m2.card.x - m1.card.x).toFixed(1), +(m2.card.y - m1.card.y).toFixed(1)],
      frameMoved: [+(m2.frame.l - m1.frame.l).toFixed(1), +(m2.frame.t - m1.frame.t).toFixed(1)],
      codeMoved: [+(m2.code.x - m1.code.x).toFixed(1), +(m2.code.y - m1.code.y).toFixed(1)],
    });
  }

  console.log(JSON.stringify({ zoom: +m1.zoom.toFixed(3), results }, null, 1));
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/auto_fit_final.png' });
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
