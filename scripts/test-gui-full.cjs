#!/usr/bin/env node
/**
 * futureFlow 全流程 GUI 模拟点击验收（Playwright 直驱本机 Chrome/Edge）
 *
 * 覆盖: 登录 → 工作流列表 → 创建画布 → 画布编辑(改名/自动保存/添加节点/
 * 工具条/节点配置) → 试运行(真实调用 glm-5.3-flash) → 保存 → 返回列表 →
 * 个人中心 → 管理员后台 → 退出登录，逐步截图存证。
 *
 * 用法: node scripts/test-gui-full.cjs <admin-password> [--headless=false]
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
  : join(process.cwd(), 'gui-full-screenshots');

function findBrowserExecutable() {
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

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + String(detail).slice(0, 200) : ''}`);
}

async function shot(page, file) {
  await page.screenshot({ path: join(SHOT_DIR, file), fullPage: false });
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function main() {
  if (!PW) {
    console.error('用法: node scripts/test-gui-full.cjs <admin-password>');
    process.exit(2);
  }
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    console.error('未找到 Chrome/Edge；可用 PLAYWRIGHT_EXECUTABLE_PATH 指定。');
    process.exit(2);
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS, executablePath });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const realErrors = [];
  page.on('pageerror', (e) => realErrors.push('PAGEERROR: ' + String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/findDOMNode is deprecated|deprecated/i.test(text)) return;
    if (/net::ERR_ABORTED.*\/healthz/i.test(text)) return;
    realErrors.push(text);
  });

  const workflowName = '全流程验收-' + Date.now().toString().slice(-6);

  try {
    // ===== T1 登录页 =====
    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await shot(page, 't01_login.png');
    const hasForm = (await page.locator('#account').count()) === 1
      && (await page.locator('#password').count()) === 1
      && (await page.locator('button[type="submit"]').count()) >= 1;
    record('T1 登录页渲染(账号/密码/登录按钮)', hasForm);

    // ===== T2 登录 =====
    await page.locator('#account').fill(ADMIN);
    await page.locator('#password').fill(PW);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await shot(page, 't02_after_login.png');
    record('T2 登录成功进入工作流列表', !page.url().includes('/login'), page.url());

    // ===== T3 工作流列表 =====
    const listText = await bodyText(page);
    await shot(page, 't03_list.png');
    record('T3 工作流列表渲染', /工作流|创建画布|模板/.test(listText));

    // ===== T4 创建画布 =====
    await page.getByRole('button', { name: '创建画布' }).first().click();
    await page.waitForTimeout(900);
    await shot(page, 't04a_create_modal.png');
    await page.locator('input[placeholder="如：翻译助手"]').first().fill(workflowName);
    await page.locator('textarea[placeholder*="简要描述"]').first().fill('GUI 全流程模拟点击验收').catch(() => {});
    await page.getByRole('button', { name: '创建并进入编辑' }).click();
    await page.waitForURL('**/canvas/**', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3500);
    await shot(page, 't04b_canvas_loaded.png');
    const canvasText = await bodyText(page);
    record('T4 创建画布并进入画布编辑器', /canvas\//.test(page.url()) && /开始/.test(canvasText) && /大语言模型/.test(canvasText), page.url());

    // ===== T5 画布头部: 重命名 + 自动保存 =====
    const nameInput = page.locator('.canvas-name-input input');
    record('T5a 画布头部名称输入框存在', (await nameInput.count()) === 1);
    await nameInput.fill(workflowName + '-改');
    await page.waitForTimeout(2600); // 等待 1.5s 防抖 + 保存请求
    await shot(page, 't05_autosave.png');
    const statusText = await page.locator('.canvas-save-status').innerText().catch(() => '');
    record('T5b 修改名称后自动保存', /已保存|正在自动保存/.test(statusText), statusText);

    // ===== T6 添加节点面板 =====
    const addBtn = page.locator('[data-testid="demo.free-layout.add-node"]');
    await addBtn.click();
    await page.waitForTimeout(800);
    let visiblePanel = page.locator('.canvas-node-panel:visible');
    if ((await visiblePanel.count()) === 0) {
      await addBtn.click();
      await page.waitForTimeout(800);
      visiblePanel = page.locator('.canvas-node-panel:visible');
    }
    await shot(page, 't06a_node_panel.png');
    const panelVisible = (await visiblePanel.count()) >= 1;
    await page.locator('.canvas-node-panel:visible input').first().fill('条件');
    await page.waitForTimeout(500);
    const option = visiblePanel.locator('.canvas-node-option', { hasText: '条件' }).first();
    const optionFound = (await option.count()) >= 1;
    if (optionFound) {
      await option.click();
      await page.waitForTimeout(1200);
    }
    await shot(page, 't06b_node_added.png');
    record('T6 添加节点面板搜索并新增「条件」节点', panelVisible && optionFound);
    // 撤销恢复原状
    await page.getByRole('button', { name: '撤销', exact: true }).click().catch(() => {});
    await page.waitForTimeout(600);

    // ===== T7 工具条 =====
    for (const [label, name] of [
      ['t07a_switch_line', '切换连线样式'],
      ['t07b_fit_view', '适应视图'],
      ['t07c_minimap', '隐藏鸟瞰图'],
      ['t07d_minimap', '显示鸟瞰图'],
      ['t07e_auto_layout', '自动布局'],
      ['t07f_redo', '重做'],
      ['t07g_undo', '撤销'],
    ]) {
      const btn = page.getByRole('button', { name, exact: true }).first();
      const exists = (await btn.count()) >= 1;
      if (exists) {
        await btn.click().catch((e) => console.log(`  click ${name} error: ${e.message}`));
        await page.waitForTimeout(500);
      }
      record(`T7 工具条「${name}」可点击`, exists);
    }
    await shot(page, 't07_tools_done.png');

    // ===== T8 选中 LLM 节点配置 =====
    const llmNode = page.locator('.node-type-llm').first();
    const llmExists = (await llmNode.count()) >= 1;
    if (llmExists) {
      await llmNode.click();
      await page.waitForTimeout(1500);
    }
    await shot(page, 't08_llm_selected.png');
    const sideText = await bodyText(page);
    record('T8 点击 LLM 节点打开配置表单', llmExists && /模型名称|生成温度|提示词/.test(sideText));
    // 关闭侧边面板(若有)
    const closeBtn = page.getByRole('button', { name: '关闭节点配置' }).first();
    if ((await closeBtn.count()) >= 1) {
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(600);
    }

    // ===== T9 试运行(真实调用 glm-5.3-flash) =====
    await page.getByRole('button', { name: '试运行', exact: true }).first().click();
    await page.waitForTimeout(1200);
    await shot(page, 't09a_testrun_panel.png');
    const runBtn = page.getByRole('button', { name: '开始试运行' }).first();
    record('T9a 试运行面板打开并有开始按钮', (await runBtn.count()) >= 1);
    await runBtn.click();
    await page.waitForTimeout(3000);
    await shot(page, 't09b_running.png');
    // 等待运行结束(输出结果出现 / 按钮从「取消」变回「试运行」)
    let runOk = false;
    let runDetail = '';
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(3000);
      const bodyNow = await bodyText(page);
      const idx = bodyNow.indexOf('输入表单');
      const panelText = idx >= 0 ? bodyNow.slice(idx, idx + 900) : bodyNow.slice(-900);
      const stillRunning = /运行中/.test(panelText) && (await page.getByRole('button', { name: '取消试运行' }).count()) >= 1;
      if (!stillRunning) {
        const resultMatch = panelText.match(/输出结果:\s*[\s\S]{0,400}/);
        runDetail = resultMatch ? resultMatch[0].replace(/\s+/g, ' ').slice(0, 280) : panelText.replace(/\s+/g, ' ').slice(0, 280);
        runOk = /输出结果/.test(panelText) && !/执行失败|错误/.test(panelText) && panelText.replace(/[\s"]/g, '').length > 60;
        break;
      }
    }
    await shot(page, 't09c_run_result.png');
    record('T9b 试运行真实调用模型并产生输出', runOk, runDetail);

    // ===== T10 手动保存 =====
    await page.getByRole('button', { name: '保存工作流' }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 't10_saved.png');
    const toastText = await bodyText(page);
    record('T10 点击保存成功', /已保存/.test(toastText));

    // ===== T11 返回列表 =====
    await page.getByRole('button', { name: '返回工作流列表' }).first().click();
    await page.waitForTimeout(1800);
    await shot(page, 't11_back_to_list.png');
    const listText2 = await bodyText(page);
    record('T11 返回列表且工作流存在', !/canvas\//.test(page.url()) && listText2.includes(workflowName + '-改'), workflowName + '-改');

    // ===== T12 个人中心 =====
    await page.getByRole('button', { name: '个人中心' }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 't12_profile.png');
    record('T12 个人中心渲染', /个人|邮箱|API Key|用户名/.test(await bodyText(page)));

    // ===== T13 管理员后台 tabs =====
    await page.getByRole('button', { name: '平台管理' }).first().click();
    await page.waitForTimeout(1800);
    await shot(page, 't13a_admin.png');
    record('T13a 管理员后台渲染', /管理员后台|注册用户/.test(await bodyText(page)));
    for (const tabName of ['用户管理', 'API Key', '工作流', '运行记录', '余额流水']) {
      const tab = page.getByRole('tab', { name: tabName }).first();
      const exists = (await tab.count()) >= 1;
      if (exists) {
        await tab.click();
        await page.waitForTimeout(900);
      }
      await shot(page, `t13_${tabName}.png`);
      record(`T13 切换「${tabName}」`, exists);
    }

    // ===== T14 退出登录 =====
    await page.getByRole('button', { name: '个人中心' }).first().click().catch(() => {});
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '退出登录' }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 't14_logout.png');
    record('T14 退出登录回到登录页', page.url().includes('/login'));

    // ===== T15 控制台异常 =====
    if (realErrors.length > 0) {
      console.log('\nPAGE_ERRORS:\n' + realErrors.slice(0, 10).join('\n'));
    }
    record('T15 浏览器控制台无 error 级异常', realErrors.length === 0, `${realErrors.length} 条`);
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n===== GUI 全流程验收: ${passed}/${results.length} passed（截图见 ${SHOT_DIR}）=====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});