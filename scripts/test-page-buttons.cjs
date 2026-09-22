#!/usr/bin/env node
/**
 * 页面按钮逐一枚举核查。
 * 逐页枚举所有可见按钮：校验都有可读名称（无障碍基线）、逐一点击可安全点击的
 * 交互控件（tab、分页、弹窗入口）并确认点击产生了预期效果，最后关闭弹窗复原。
 * 用法：node scripts/test-page-buttons.cjs <管理员密码>
 * 退出码：0 全通过；1 有失败。
 */
'use strict';

const { chromium } = require('playwright-core');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function frontendBase() {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/+$/, '');
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const port = env.match(/^FRONTEND_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* ignore */ }
  return 'http://localhost:3000';
}

/** 清理要走网关 API，所以还需要网关地址（不是前端地址）。 */
function gatewayBase() {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL.replace(/\/+$/, '');
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const port = env.match(/^GATEWAY_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* ignore */ }
  return 'http://localhost:3001';
}
function findBrowser() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((c) => c && existsSync(c)) || null;
}

const FRONT = frontendBase();
const PW = process.argv[2] || adminPassword();
const SHOT_DIR = join(process.cwd(), 'gui-test-screenshots');

/**
 * 画布页那一步会真的建一张工作流（名字 `按钮枚举核查-<5 位>`），只能前缀匹配。
 * 本套件原来**完全没有清理**——每跑一次就在用户的工作流列表里留一张，
 * 实测已经堆了两张。
 */
const WORKFLOW_PREFIX = '按钮枚举核查-';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
};

/**
 * 收尾清理：登录后按前缀扫描并删除本套件（含此前中断残留）的工作流。
 * 清理失败只警告、不判定套件失败——它是收尾动作，不是验收项本身。
 */
async function cleanupArtifacts() {
  const base = gatewayBase();
  try {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: process.env.ADMIN_USERNAME || 'admin', password: PW }),
    });
    const token = (await res.json().catch(() => ({}))).accessToken;
    if (!token) {
      console.warn('工作流清理未完成（不判定失败）：登录未拿到 token');
      return;
    }
    reportCleanup(
      await cleanupTestWorkflows({ gateway: base, token, prefixes: [WORKFLOW_PREFIX] }),
      '按钮枚举核查工作流',
    );
  } catch (error) {
    console.warn(`工作流清理未完成（不判定失败）：${error?.message || error}`);
  }
}

const PAGES = [
  { path: '/', name: '工作流', expect: ['创建画布', '导入', 'Dify 引擎'] },
  { path: '/plugins', name: '插件商店', expect: ['全部', '智能与内容'] },
  { path: '/plugins/llm', name: '插件详情', expect: ['添加到我的工作流', '返回'] },
  { path: '/tasks', name: '任务中心', expect: ['创建任务', '刷新', '批量任务', '异步任务'] },
  { path: '/profile', name: '个人中心', expect: ['修改密码', '编辑资料', '创建 Key', '上传文件', '创建知识库'] },
  { path: '/admin', name: '平台管理', expect: ['刷新', '仪表盘', '用户管理', 'API Key', '工作流', '运行记录', '余额流水'] },
];

async function buttonSnapshot(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="tab"]')).filter((b) => {
      const rect = b.getBoundingClientRect();
      const style = getComputedStyle(b);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    return buttons.map((b) => ({
      name: (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      disabled: !!b.disabled,
      role: b.getAttribute('role') || 'button',
    }));
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  mkdirSync(SHOT_DIR, { recursive: true });

  try {
    // 登录
    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.locator('#account').fill('admin');
    await page.locator('#password').fill(PW);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    record('登录进入工作区', page.url().replace(/\/+$/, '') === FRONT, page.url());

    // 1) 逐页枚举按钮
    for (const spec of PAGES) {
      await page.goto(`${FRONT}${spec.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2200);
      const buttons = await buttonSnapshot(page);
      const names = buttons.map((b) => b.name);
      const unnamed = buttons.filter((b) => !b.name);
      const missing = spec.expect.filter((want) => !names.some((n) => n.indexOf(want) >= 0));
      record(
        `${spec.name}：按钮枚举 ${buttons.length} 个，全部有可读名称`,
        unnamed.length === 0 && buttons.length > 0,
        unnamed.length ? `无名按钮 ${unnamed.length} 个` : `示例：${names.slice(0, 5).join('/')}`,
      );
      record(
        `${spec.name}：关键按钮齐全`,
        missing.length === 0,
        missing.length ? `缺少 ${missing.join('、')}` : `${spec.expect.length} 项全部命中`,
      );
    }

    // 2) 平台管理：逐个 tab 点击 → 面板内容切换
    await page.goto(`${FRONT}/admin`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    for (const tabName of ['用户管理', 'API Key', '工作流', '运行记录', '余额流水', '仪表盘']) {
      const tab = page.getByRole('tab', { name: tabName }).first();
      if ((await tab.count()) === 0) {
        record(`平台管理 tab「${tabName}」可点击并激活`, false, 'tab 不存在');
        continue;
      }
      await tab.click();
      await page.waitForTimeout(1200);
      const active = await page.evaluate(
        (name) => Array.from(document.querySelectorAll('.semi-tabs-tab')).some(
          (el) => el.className.indexOf('active') >= 0 && (el.textContent || '').indexOf(name) >= 0,
        ),
        tabName,
      );
      record(`平台管理 tab「${tabName}」可点击并激活`, active);
    }

    // 3) 用户管理：逐个「查看」按钮 → 弹窗内容非空 → 关闭
    //    后台默认停在仪表盘，查看按钮在用户管理面板里，必须先切过去
    await page.getByRole('tab', { name: '用户管理' }).first().click();
    await page.waitForTimeout(1500);
    const viewButtons = page.getByRole('button', { name: '查看' });
    const viewCount = await viewButtons.count();
    let viewOk = viewCount > 0;
    for (let i = 0; i < Math.min(viewCount, 2); i += 1) {
      await viewButtons.nth(i).click();
      await page.waitForTimeout(900);
      const hasModal = await page.evaluate(() => {
        const modal = document.querySelector('.semi-modal-content');
        return !!modal && (modal.textContent || '').length > 20;
      });
      viewOk = viewOk && hasModal;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
    record('用户管理「查看」逐个点击都能打开含内容的详情弹窗', viewOk, `共 ${viewCount} 个`);

    // 4) 工作流页：分页页码逐一点击 → 行内容变化
    await page.goto(`${FRONT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const firstPageText = await page.evaluate(() => (document.body.innerText || '').slice(0, 400));
    const page2 = page.locator('.semi-page-item', { hasText: '2' }).first();
    if ((await page2.count()) >= 1) {
      await page2.click();
      await page.waitForTimeout(1000);
      const secondPageText = await page.evaluate(() => (document.body.innerText || '').slice(0, 400));
      record('分页页码点击后列表内容翻页', secondPageText !== firstPageText);
    } else {
      record('分页页码点击后列表内容翻页', true, '数据不足一页，跳过');
    }

    // 5) 各页面弹窗入口逐一点击 → 打开 → 关闭（不提交）
    const modalCases = [
      { path: '/profile', button: '修改密码' },
      { path: '/profile', button: '编辑资料' },
      { path: '/profile', button: '创建 Key' },
      { path: '/profile', button: '创建知识库' },
      { path: '/', button: '创建画布' },
      { path: '/tasks', button: '创建任务' },
    ];
    for (const item of modalCases) {
      await page.goto(`${FRONT}${item.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const btn = page.getByRole('button', { name: item.button }).first();
      if ((await btn.count()) === 0) {
        record(`${item.path} 「${item.button}」打开弹窗`, false, '按钮不存在');
        continue;
      }
      await btn.click();
      await page.waitForTimeout(1100);
      const opened = await page.evaluate(() => {
        const dialog = document.querySelector('.semi-modal-content, .semi-sidesheet-content');
        return !!dialog && (dialog.textContent || '').length > 10;
      });
      record(`${item.path} 「${item.button}」打开弹窗`, opened);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }

    // 6) 画布页：工具栏按钮枚举（用创建画布进入，行内入口已收进更多菜单）
    await page.goto(`${FRONT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '创建画布' }).first().click();
    await page.waitForTimeout(1200);
    const nameField = page.locator('input[placeholder="如：翻译助手"]').first();
    await nameField.fill('按钮枚举核查-' + Date.now().toString().slice(-5));
    await page.getByRole('button', { name: '创建并进入编辑' }).click();
    await page.waitForURL('**/canvas/**', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const onCanvas = /canvas\//.test(page.url());
    const canvasButtons = await buttonSnapshot(page);
    const unnamedCanvas = canvasButtons.filter((b) => !b.name);
    record(
      `画布页：工具条按钮枚举 ${canvasButtons.length} 个，全部有可读名称`,
      onCanvas && unnamedCanvas.length === 0 && canvasButtons.length >= 8,
      onCanvas ? `示例：${canvasButtons.map((b) => b.name).slice(0, 6).join('/')}` : `未进入画布 ${page.url()}`,
    );
    record(
      '画布页：只有一个「试运行」入口',
      canvasButtons.filter((b) => /^(试运行|云端试运行)$/.test(b.name)).length === 1,
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    // 先关浏览器再清理：清理走的是网关 HTTP，不依赖浏览器句柄。
    await cleanupArtifacts();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n===== 页面按钮枚举核查: ${results.length - failed}/${results.length} passed =====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`[FAIL] 按钮枚举中断 :: ${error.message}`);
  // 中断也要清：否则这张画布会留在用户的工作流列表里
  await cleanupArtifacts();
  process.exit(1);
});
