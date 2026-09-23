#!/usr/bin/env node
'use strict';
// 参考图需求核验：循环节点（侧栏/类型/中间变量/输出/循环体圆点）、
// 变量聚合（策略/分组）、类型系统（8 种类型 + Array/File 子菜单）、
// 卡片视觉（无多余文字、连线、圆点大小）
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
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
  name: `需求核验-${Date.now()}`,
  flowgram: JSON.stringify({
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 300 } },
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, score: { type: 'number' } } } },
              prefix: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'aggregator',
        type: 'variable-aggregator',
        meta: { position: { x: 0, y: 0 } },
        data: { title: '变量聚合' },
      },
      {
        id: 'loop',
        type: 'loop',
        meta: { position: { x: 520, y: 300 } },
        data: {
          title: '循环',
          loopType: 'array',
          loopFor: { type: 'ref', content: ['start', 'items'] },
          loopMiddleValues: {},
          loopOutputs: { result: { type: 'ref', content: ['loop_code', 'result'] } },
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
        },
        blocks: [
          { id: 'loop_start', type: 'block-start', meta: { position: { x: 96, y: 313 } }, data: {} },
          {
            id: 'loop_code',
            type: 'code',
            meta: { position: { x: 230, y: 252 } },
            data: {
              title: '逐项处理',
              inputsValues: {
                item: { type: 'ref', content: ['loop_locals', 'item'] },
                index: { type: 'ref', content: ['loop_locals', 'index'] },
              },
              inputs: { type: 'object', properties: { item: { type: 'object' }, index: { type: 'number' } } },
              script: { language: 'javascript', content: 'function main({ params }) { return { result: params.item.score }; }' },
              outputs: { type: 'object', properties: { result: { type: 'number' } } },
            },
          },
          { id: 'loop_end', type: 'block-end', meta: { position: { x: 616, y: 313 } }, data: {} },
        ],
        edges: [
          { sourceNodeID: 'loop_start', targetNodeID: 'loop_code' },
          { sourceNodeID: 'loop_code', targetNodeID: 'loop_end' },
        ],
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 1200, y: 300 } },
        data: { title: '结束' },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'loop' },
      { sourceNodeID: 'loop', targetNodeID: 'end' },
    ],
    globalVariable: { type: 'object', properties: {} },
  }),
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ 项目: name, 结果: ok ? '✅' : '❌', 说明: detail || '' });
};

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 950 } })).newPage();
  await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
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
  await page.waitForTimeout(5500);

  // ============ A. 循环卡片视觉（去掉多余文字 / 连线 / 圆点大小） ============
  const visual = await page.evaluate(() => {
    const card = document.querySelector('.node-type-loop .ff-loop-card');
    const body = document.querySelector('.node-type-loop .ff-loop-body');
    const connector = document.querySelector('.node-type-loop .ff-loop-connector');
    const cardText = card ? card.innerText : '';
    const dotPort = document.querySelector('.gedit-flow-activity-node[data-node-id="loop_start"] .workflow-port-render .bg');
    const dotRect = dotPort ? dotPort.getBoundingClientRect() : null;
    const cardRect = card ? card.getBoundingClientRect() : null;
    const bodyRect = body ? body.getBoundingClientRect() : null;
    const connRect = connector ? connector.getBoundingClientRect() : null;
    const path = connector ? connector.querySelector('path') : null;
    return {
      hasInputOutputLabel: /输入 input|输出 output/.test(cardText),
      connectorExists: !!path,
      // 连线覆盖卡片底 → 框顶
      connectorSpans: path && cardRect && bodyRect
        ? (() => {
            const d = path.getAttribute('d') || '';
            return d.includes('M ') && d.includes(' C ');
          })()
        : false,
      dotSize: dotRect ? { w: +dotRect.width.toFixed(1), h: +dotRect.height.toFixed(1) } : null,
      hasBody: !!body,
    };
  });
  check('卡片去掉「输入 input / 输出 output」多余文字', !visual.hasInputOutputLabel);
  check('卡片与循环体之间有 S 曲线连接', visual.connectorExists && visual.connectorSpans, '靛蓝曲线 + 两端圆点');
  check('框边缘连接圆点缩小（<12px）', visual.dotSize && visual.dotSize.w <= 12, `实测 ${visual.dotSize ? visual.dotSize.w : '?'}px`);

  // ============ B. 循环节点侧栏（循环设置/循环类型/中间变量/输出） ============
  const cardPt = await page.evaluate(() => {
    const r = document.querySelector('.node-type-loop .ff-loop-card').getBoundingClientRect();
    return { x: r.x + 60, y: r.y + 12 };
  });
  await page.mouse.click(cardPt.x, cardPt.y);
  await page.waitForTimeout(1200);
  const sidebar = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasLoopSettings: text.includes('循环设置'),
      hasLoopType: text.includes('循环类型'),
      hasMiddle: text.includes('中间变量'),
      hasOutput: text.includes('输出'),
    };
  });
  check('侧栏「循环设置」分区', sidebar.hasLoopSettings);
  check('侧栏「循环类型」可设置', sidebar.hasLoopType);
  check('侧栏「中间变量」分区', sidebar.hasMiddle);

  // 打开循环类型下拉，读取三个选项
  const loopTypeOptions = await page.evaluate(async () => {
    const labels = Array.from(document.querySelectorAll('label,div,span')).filter((el) => el.textContent && el.textContent.trim() === '循环类型');
    void labels;
    // Semi Select：找到侧栏里第一个 select 触发器
    const triggers = Array.from(document.querySelectorAll('.semi-select'));
    const last = triggers[triggers.length - 1];
    if (!last) return [];
    last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    last.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    return Array.from(document.querySelectorAll('.semi-select-option')).map((o) => o.textContent.trim());
  });
  check(
    '循环类型选项：使用数组循环 / 指定循环次数 / 无限循环',
    ['使用数组循环', '指定循环次数', '无限循环'].every((t) => loopTypeOptions.some((o) => o.includes(t))),
    JSON.stringify(loopTypeOptions)
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/verify_loop_sidebar.png' });

  // ============ C. 变量聚合（聚合策略 / 分组 / 新增分组 / 输出） ============
  const aggPt = await page.evaluate(() => {
    const el = document.querySelector('[data-node-id="aggregator"]');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 12 };
  });
  await page.mouse.click(aggPt.x, aggPt.y);
  await page.waitForTimeout(1200);
  const agg = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasStrategy: text.includes('聚合策略'),
      hasFirstNonEmpty: text.includes('返回每个分组中第一个非空的值'),
      hasAddGroup: text.includes('新增分组'),
      hasOutput: text.includes('输出'),
    };
  });
  check('变量聚合：「聚合策略」下拉', agg.hasStrategy);
  check('变量聚合：策略「返回每个分组中第一个非空的值」', agg.hasFirstNonEmpty);
  check('变量聚合：「新增分组」按钮', agg.hasAddGroup);
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/verify_aggregator.png' });

  // ============ D. 类型系统（String/Integer/Number/Boolean/Time/Object/Array/File） ============
  const startPt = await page.evaluate(() => {
    const el = document.querySelector('[data-node-id="start"]');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 12 };
  });
  await page.mouse.click(startPt.x, startPt.y);
  await page.waitForTimeout(1200);
  const typeOptions = await page.evaluate(async () => {
    // 触发第一行变量的类型选择器（aria-label=变量类型），菜单项为 role="menuitem"
    const trigger = document.querySelector('[aria-label="变量类型"]');
    if (!trigger) return { top: [], arraySub: [] };
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const menuitems = () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((o) => o.textContent.trim());
    const top = menuitems();
    // 点击 数组 打开子菜单（子菜单项与顶层同名，按菜单项数量变化判断）
    const arrayOpt = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (o) => o.textContent.trim().replace('›', '').trim() === '数组'
    );
    let submenuOpened = false;
    let submenuSample = [];
    if (arrayOpt) {
      const beforeCount = menuitems().length;
      arrayOpt.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      arrayOpt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const after = menuitems();
      submenuOpened = after.length > beforeCount;
      submenuSample = after;
    }
    return {
      top: Array.from(new Set(top.map((t) => t.replace('›', '').trim()))),
      submenuOpened,
      submenuSample: submenuSample.slice(0, 12),
    };
  });
  const expectedTypes = ['字符串', '整数', '数字', '布尔值', '时间', '对象', '数组', '文件'];
  check(
    '类型下拉包含 8 种类型（String/Integer/Number/Boolean/Time/Object/Array/File）',
    expectedTypes.every((t) => typeOptions.top.includes(t)),
    JSON.stringify(typeOptions.top)
  );
  check('数组（Array）有子菜单，可迭代类型可选', typeOptions.submenuOpened, `子菜单项 ${JSON.stringify(typeOptions.submenuSample.slice(0, 10))}`);
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/verify_types.png' });
  await page.keyboard.press('Escape');

  // ============ E. 循环体：无开始/结束节点、左右圆点、可自动改变大小 ============
  const bodyInfo = await page.evaluate(() => {
    const body = document.querySelector('.node-type-loop .ff-loop-body');
    const bodyRect = body.getBoundingClientRect();
    const inside = Array.from(document.querySelectorAll('.gedit-flow-render-layer .gedit-flow-activity-node'))
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.x >= bodyRect.x - 2 && r.right <= bodyRect.right + 2 && r.y >= bodyRect.y - 2 && r.bottom <= bodyRect.bottom + 2;
      })
      .map((n) => n.getAttribute('data-node-id'));
    const d1 = document.querySelector('[data-node-id="loop_start"]');
    const d2 = document.querySelector('[data-node-id="loop_end"]');
    const d1r = d1.getBoundingClientRect();
    const d2r = d2.getBoundingClientRect();
    return {
      inside,
      noStartEndCards: !inside.some((id) => /^(start|end)/.test(id)),
      dotLeftOnEdge: Math.abs(d1r.x - bodyRect.x) < 3,
      dotRightOnEdge: Math.abs(d2r.x - (bodyRect.x + bodyRect.width)) < 3,
    };
  });
  check('循环体里没有开始/结束节点（只有左右圆点）', bodyInfo.noStartEndCards, `体内节点: ${JSON.stringify(bodyInfo.inside)}`);
  check('左右圆点压在循环体框线上', bodyInfo.dotLeftOnEdge && bodyInfo.dotRightOnEdge);

  // 自动改变大小：拖动体内节点，框应整体跟随（宽度 = 内容宽 + 边距，位置随节点平移）
  const before = await page.evaluate(() => {
    const f = (window.__loopFrameRects || {}).loop;
    const code = document.querySelector('[data-node-id="loop_code"]').getBoundingClientRect();
    return { frameL: f ? Math.round(f.left) : null, codeX: Math.round(code.x) };
  });
  const codePt = await page.evaluate(() => {
    const r = document.querySelector('[data-node-id="loop_code"]').getBoundingClientRect();
    return { x: r.x + 60, y: r.y + 8 };
  });
  await page.mouse.move(codePt.x, codePt.y);
  await page.mouse.down();
  await page.mouse.move(codePt.x + 40, codePt.y + 10, { steps: 6 });
  await page.mouse.move(codePt.x + 300, codePt.y + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => {
    const f = (window.__loopFrameRects || {}).loop;
    const body = document.querySelector('.node-type-loop .ff-loop-body').getBoundingClientRect();
    const code = document.querySelector('[data-node-id="loop_code"]').getBoundingClientRect();
    const worldW = f ? f.right - f.left : null;
    return {
      frameL: f ? Math.round(f.left) : null,
      frameWWorld: f ? Math.round(f.right - f.left) : null,
      zoom: worldW ? body.width / worldW : 1,
      codeX: Math.round(code.x),
      margins: {
        left: Math.round(code.x - body.x),
        right: Math.round(body.right - code.right),
      },
    };
  });
  const nodeMovedScreen = after.codeX - before.codeX;
  // 世界坐标下的跟随位移：屏幕位移 ÷ 缩放比
  const nodeMovedWorld = nodeMovedScreen / (after.zoom || 1);
  const frameFollowed = Math.abs(after.frameL - before.frameL - nodeMovedWorld) < 60;
  const marginsBalanced = after.margins.left > 20 && after.margins.right > 20;
  check(
    '循环体随体内节点自动调整（跟随平移 + 贴边距）',
    nodeMovedScreen > 50 && frameFollowed && marginsBalanced,
    `节点位移 ${nodeMovedScreen}px（世界 ${Math.round(nodeMovedWorld)}），框左缘 ${before.frameL} → ${after.frameL}，松手后左右边距 ${JSON.stringify(after.margins)}`
  );

  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/verify_loop_body.png' });
  await browser.close();

  console.log('\n===== 参考图需求核验结果 =====');
  for (const r of results) {
    console.log(`${r.结果} ${r.项目}${r.说明 ? '  —— ' + r.说明 : ''}`);
  }
  const failed = results.filter((r) => r.结果 === '❌').length;
  console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
