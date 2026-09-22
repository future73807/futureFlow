#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const FRONT = process.env.FRONTEND_URL || 'http://localhost:3000';
const PW = process.argv[2] || adminPassword();
// 收尾清理要调网关 API（本脚本原为纯浏览器驱动，没有网关地址）
const GATEWAY = (() => {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL.replace(/\/+$/, '');
  try {
    const env = require('node:fs').readFileSync(join(__dirname, '..', '.env'), 'utf8');
    const port = env.match(/^GATEWAY_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* fall through */ }
  return 'http://localhost:3001';
})();
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

  // 清理本套件创建的工作流（'画布视觉核对'）。它与其它截图脚本一样是纯浏览器
  // 驱动，此前完全不清理，库里堆了 3 个同名 active 工作流。
  reportCleanup(
    await cleanupTestWorkflows({ gateway: GATEWAY, token: await apiLogin(), names: ['画布视觉核对'] }),
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
