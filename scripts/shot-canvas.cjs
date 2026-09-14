#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright-core');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const FRONT = process.env.FRONTEND_URL || 'http://localhost:3000';
const PW = process.argv[2] || 'futureFlow@';
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
  await page.screenshot({ path: join(OUT, 'r_list.png') });

  const createBtn = page.getByRole('button', { name: '创建画布' }).first();
  await createBtn.click();
  await page.waitForTimeout(800);
  await page.locator('input[placeholder="如：翻译助手"]').first().fill('画布视觉核对');
  await page.getByRole('button', { name: '创建并进入编辑' }).click();
  await page.waitForURL('**/canvas/**', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(OUT, 'r_canvas.png') });

  // open node panel
  await page.locator('[data-testid="demo.free-layout.add-node"]').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'r_node_panel.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // select llm node -> side panel
  const llm = page.locator('.node-type-llm').first();
  if (await llm.count()) {
    await llm.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'r_llm_side.png') });
    const close = page.getByRole('button', { name: '关闭节点配置' }).first();
    if (await close.count()) { await close.click(); await page.waitForTimeout(500); }
  }

  // expand llm node (small triangle)
  const expand = page.getByRole('button', { name: '展开节点' }).first();
  if (await expand.count()) {
    await expand.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, 'r_node_expanded.png') });
  }

  await browser.close();
  console.log('screenshots written to', OUT);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
