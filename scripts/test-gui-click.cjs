#!/usr/bin/env node
/**
 * futureFlow GUI 模拟点击验收（Playwright 直驱本机 Chrome/Edge/Chromium）
 *
 * 用途：对一键启动后的实时前端做真实点击验收，覆盖登录 → 工作流列表 →
 * 创建画布 → 管理员后台各 tab → 个人中心 → 退出登录，并按步骤截图存证。
 * 它不依赖 LLM_API_KEY，只走无模型节点路径，是对 test:e2e 的轻量 GUI 互补。
 *
 * 前置：
 *   1. `pnpm start` 已起，前端在 FRONTEND_URL（默认 http://localhost:3000）、
 *      网关在 http://localhost:3001；
 *   2. 已默认创建管理员 admin（密码见 .env 的 GATEWAY_BOOTSTRAP_ADMIN_PASSWORD）。
 *
 * 用法：
 *   node scripts/test-gui-click.cjs <admin-password>
 *   node scripts/test-gui-click.cjs <admin-password> --headless=false   # 有头模式调试
 *   ADMIN_USERNAME=admin FRONTEND_URL=http://localhost:3000 \
 *     PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome node scripts/test-gui-click.cjs <pwd>
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const { chromium } = require('playwright-core');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const FRONT = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const HEADLESS = !process.argv.includes('--headless=false');
const PW = process.argv.find((a) => !a.startsWith('-') && !a.endsWith('.cjs') && a !== process.argv[0] && a !== process.argv[1]);
const SHOT_DIR = process.env.GUI_SHOT_DIR
  ? join(process.cwd(), process.env.GUI_SHOT_DIR)
  : join(process.cwd(), 'gui-test-screenshots');

function findBrowserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  try {
    const playwright = require('playwright-core');
    const bundled = playwright.chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {}
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find((c) => c && existsSync(c)) || null;
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function shot(page, file) {
  await page.screenshot({ path: join(SHOT_DIR, file), fullPage: true });
}

function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function main() {
  if (!PW) {
    console.error('用法: node scripts/test-gui-click.cjs <admin-password>');
    console.error('密码默认见 .env 的 GATEWAY_BOOTSTRAP_ADMIN_PASSWORD（默认 futureFlow@）');
    process.exit(2);
  }
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    console.error('未找到 Chrome/Edge/Chromium；可用 PLAYWRIGHT_EXECUTABLE_PATH 指定浏览器。');
    process.exit(2);
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS, executablePath });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const realErrors = [];
  page.on('pageerror', (e) => realErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // React dev 模式把第三方库（Semi UI 等）的弃用提示记到 error 通道；
    // 这些不是项目功能缺陷，过滤后单独汇总，避免误报。
    if (/findDOMNode is deprecated|deprecated/i.test(text)) return;
    realErrors.push(text);
  });

  try {
    // T1 登录页
    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await shot(page, 't1_login.png');
    const accountInput = page.locator('#account');
    const passwordInput = page.locator('#password');
    const loginBtn = page.locator('button[type="submit"]');
    const hasForm = (await accountInput.count()) === 1
      && (await passwordInput.count()) === 1
      && (await loginBtn.count()) === 1;
    record('T1 登录页渲染(用户名/密码/登录按钮)', hasForm);

    // T2 填写并点击登录
    await accountInput.fill(ADMIN);
    await passwordInput.fill(PW);
    await shot(page, 't2_login_filled.png');
    await loginBtn.click();
    await page.waitForURL('**/', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await shot(page, 't3_after_login.png');
    const onList = page.url().replace(/\/+$/, '') === FRONT;
    record('T2 点击登录后跳转工作流列表', onList, page.url());

    // T3 工作流列表渲染
    const listText = await bodyText(page);
    record('T3 工作流列表页内容渲染', /工作流|创建画布|模板/.test(listText));

    // T4 创建画布（按钮 → 填模态框 → 提交 → 进入画布编辑器）
    const createBtn = page.getByRole('button', { name: '创建画布' });
    if ((await createBtn.count()) >= 1) {
      await createBtn.first().click();
      await page.waitForTimeout(900);
      await shot(page, 't4a_create_modal.png');
      const nameField = page.locator('input[placeholder="如：翻译助手"]').first();
      await nameField.fill('GUI 点击验收工作流');
      await page.locator('textarea[placeholder*="简要描述"]').first().fill('Playwright 模拟点击创建').catch(() => {});
      await shot(page, 't4b_create_filled.png');
      await page.getByRole('button', { name: '创建并进入编辑' }).click();
      await page.waitForURL('**/canvas/**', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await shot(page, 't4c_canvas.png');
      const onCanvas = /canvas\//.test(page.url());
      const canvasRenders = /开始|节点|画布|大语言模型|文本/.test(await bodyText(page));
      record('T4 创建画布(填名称+提交)进入画布编辑器', onCanvas && canvasRenders, page.url());
      await page.goto(`${FRONT}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
    } else {
      record('T4 创建画布(填名称+提交)进入画布编辑器', false, '未找到创建画布按钮');
    }

    // T5 管理员后台-仪表盘
    const adminNav = page.getByRole('button', { name: '平台管理' });
    if ((await adminNav.count()) >= 1) {
      await adminNav.first().click();
      await page.waitForTimeout(1500);
    } else {
      await page.goto(`${FRONT}/admin`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    }
    await shot(page, 't5_admin_dashboard.png');
    const adminText = await bodyText(page);
    record(
      'T5 管理员后台-仪表盘渲染(注册用户/工作流统计)',
      /管理员后台/.test(adminText) && /注册用户/.test(adminText) && /工作流/.test(adminText),
    );

    // T6 逐个切换管理后台 tab
    for (const tabName of ['用户管理', 'API Key', '工作流', '运行记录', '余额流水']) {
      const tab = page.getByRole('tab', { name: tabName }).first();
      if ((await tab.count()) === 0) {
        record(`T6 切换到「${tabName}」`, false, 'tab 不存在');
        continue;
      }
      await tab.click();
      await page.waitForTimeout(1000);
      await shot(page, `t6_tab_${tabName}.png`);
      record(`T6 切换到「${tabName}」`, (await bodyText(page)).includes(tabName));
    }

    // T7 个人中心
    const profileNav = page.getByRole('button', { name: '个人中心' });
    if ((await profileNav.count()) >= 1) {
      await profileNav.first().click();
      await page.waitForTimeout(1500);
      await shot(page, 't7_profile.png');
      record('T7 点击「个人中心」渲染', /个人|邮箱|API Key|用户名/.test(await bodyText(page)), page.url());
    } else {
      record('T7 点击「个人中心」渲染', false, '未找到入口');
    }

    // T8 退出登录
    const logoutBtn = page.getByRole('button', { name: '退出登录' });
    if ((await logoutBtn.count()) >= 1) {
      await logoutBtn.first().click();
      await page.waitForTimeout(1500);
      await shot(page, 't8_after_logout.png');
      record('T8 点击「退出登录」回到登录页', page.url().includes('/login'), page.url());
    } else {
      record('T8 点击「退出登录」回到登录页', false, '未找到退出按钮');
    }

    // T9 控制台异常（已过滤第三方库弃用警告）
    if (realErrors.length > 0) {
      console.log('\nPAGE_ERRORS:\n' + realErrors.slice(0, 10).join('\n'));
    }
    record('T9 浏览器控制台无 error 级异常（项目自身）', realErrors.length === 0, `${realErrors.length} 条`);
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const total = results.length;
  console.log(`\n===== GUI 模拟点击验收: ${passed}/${total} passed（截图见 ${SHOT_DIR}）=====`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
