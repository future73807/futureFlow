#!/usr/bin/env node
'use strict';
// 验证：拖循环体空白区 = 整体拖动；点/拖体内节点 = 只动节点
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { existsSync } = require('node:fs');
function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}
async function main() {
  const wf = process.argv[2];
  // 本脚本需要一个**已存在的**、含 `loop_code` 内节点的循环工作流。
  // 少了这道校验时，传错参数会一路走到 `Cannot read properties of null (reading 'x')`
  // —— 报错现场与真因（参数根本不是工作流 ID）隔得很远，所以在这里挡住。
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!wf || !UUID_RE.test(wf)) {
    console.error('用法: node scripts/test-loop-body-drag.cjs <工作流ID>');
    console.error('');
    console.error('需要一个已存在的循环工作流（含 loop_code 内节点）。');
    console.error('可先运行 test-loop-interactions.cjs 建一个，或从画布地址栏复制 ID。');
    console.error(`实际收到: ${wf === undefined ? '(未传)' : JSON.stringify(wf)}`);
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(adminPassword());
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2000);
  await page.goto(`http://localhost:3000/canvas/${wf}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const grab = () =>
    page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      return { card: r('.node-type-loop .ff-loop-card'), frame: r('.node-type-loop .ff-loop-body'), code: r('[data-node-id="loop_code"]') || r('.node-type-code') };
    });

  const before = await grab();
  console.log('BEFORE:', JSON.stringify(before));

  // 1. 拖循环体空白区（框内左上角空白，避开代码节点和连线）
  const f = before.frame;
  const emptyX = f ? f.x + 40 : 0;
  const emptyY = f ? f.y + 30 : 0;
  console.log('drag empty area at', emptyX, emptyY);
  await page.mouse.move(emptyX, emptyY);
  await page.waitForTimeout(150);
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.className && el.className.toString ? el.className.toString().slice(0, 60) : el.tagName) : 'none';
  }, { x: emptyX, y: emptyY });
  console.log('elementFromPoint:', hit);
  await page.mouse.down();
  await page.mouse.move(emptyX + 100, emptyY + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterEmpty = await grab();
  const d = (a, b) => ({ dx: (a && b) ? a.x - b.x : null, dy: (a && b) ? a.y - b.y : null });
  console.log('AFTER EMPTY-DRAG: card', JSON.stringify(d(afterEmpty.card, before.card)), 'frame', JSON.stringify(d(afterEmpty.frame, before.frame)), 'code', JSON.stringify(d(afterEmpty.code, before.code)));

  // 2. 拖体内代码节点（标题栏）
  const c = afterEmpty.code;
  await page.mouse.move(c.x + 100, c.y + 8);
  await page.waitForTimeout(150);
  const hit2 = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.className && el.className.toString ? el.className.toString().slice(0, 60) : el.tagName) : 'none';
  }, { x: c.x + 100, y: c.y + 8 });
  console.log('elementFromPoint(code):', hit2);
  await page.mouse.down();
  await page.mouse.move(c.x + 100 + 120, c.y + 8 + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterCode = await grab();
  console.log('AFTER CODE-DRAG: card', JSON.stringify(d(afterCode.card, afterEmpty.card)), 'frame', JSON.stringify(d(afterCode.frame, afterEmpty.frame)), 'code', JSON.stringify(d(afterCode.code, afterEmpty.code)));

  // 3. 点击代码节点 → 选中它（侧栏出现逐项处理）
  await page.mouse.click(afterCode.code.x + 100, afterCode.code.y + 8);
  await page.waitForTimeout(1200);
  const selected = await page.evaluate(() => ({
    codeSelected: (document.querySelector('.node-type-code') || { className: '' }).className.includes('selected'),
    loopSelected: (document.querySelector('.node-type-loop') || { className: '' }).className.includes('selected'),
    panelTitle: (document.querySelector('.ff-form-panel-title, [class*=sidebar] input, .semi-input') || {}).value || '',
  }));
  console.log('SELECTION:', JSON.stringify(selected));
  await page.screenshot({ path: 'D:/Desktop/futureFlow/gui-test-screenshots/frame_drag_final.png' });
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
