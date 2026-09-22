#!/usr/bin/env node
'use strict';
// 重新打开已保存的循环工作流，验证加载后渲染一致（持久化往返）
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { existsSync } = require('node:fs');
const OUT = process.env.SHOT_DIR || 'D:/Desktop/futureFlow/gui-test-screenshots';
function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findBrowser() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('#account').fill('admin');
  await page.locator('#password').fill(adminPassword());
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(2000);
  const list = await page.evaluate(async () => {
    const token = localStorage.getItem('futureflow_token');
    const r = await fetch('http://localhost:3001/workflows?page=1&pageSize=5', { headers: { Authorization: `Bearer ${token}` } });
    return r.json();
  });
  const items = list.items || list.data || list;
  const wf = (Array.isArray(items) ? items : [])[0];
  if (!wf) throw new Error('no workflow');
  console.log('opening', wf.id, wf.name);
  await page.goto(`http://localhost:3000/canvas/${wf.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/reload_1.png` });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/reload_2.png` });
  const frame = await page.locator('.node-type-loop .ff-loop-body').count();
  const card = await page.locator('.node-type-loop .ff-loop-card').count();
  const dots = await page.locator('.node-type-block-start, .node-type-block_end').count();
  console.log('after reload: card =', card, 'frame =', frame, 'dots =', dots);
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
