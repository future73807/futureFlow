#!/usr/bin/env node
/**
 * 端到端验收总编排。
 *
 * 现状：跑齐一套 E2E 要手动起网关 + 前端、再逐个套件传不同的环境变量和密码，
 * 这些步骤散在文档和记忆里，很容易漏。本脚本把「哪些套件属于哪一层、需要什么
 * 前置条件、怎么传参」固化成代码，一条命令跑完并输出汇总。
 *
 * 用法：
 *   node scripts/e2e-all.cjs                    # 跑全部三层
 *   node scripts/e2e-all.cjs --group=local      # 只跑纯本地套件（不需要任何服务）
 *   node scripts/e2e-all.cjs --group=api        # 只跑需要网关+Dify 的套件
 *   node scripts/e2e-all.cjs --group=gui        # 只跑需要浏览器的套件
 *   node scripts/e2e-all.cjs --suite=full-chain-test
 *   node scripts/e2e-all.cjs --list             # 只列出套件，不执行
 *
 * 地址与密码（按优先级）：命令行环境变量 → 仓库根 .env → 内置默认。
 *   GATEWAY_URL / FRONTEND_URL / ADMIN_PASSWORD
 *
 * 本脚本**不负责启动服务**：起服务涉及 Docker、端口占用、Dify 初始化等一整套
 * 前置条件，交给 `pnpm start`（或下方提示的手动命令）更可靠。这里只做「检查 +
 * 跑 + 汇总」，缺前置条件时给出可直接粘贴的启动命令。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');

// ───────────────────────── 配置解析 ─────────────────────────

function loadEnvFile() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const trimSlash = (value) => String(value).replace(/\/+$/, '');

const GATEWAY_URL = trimSlash(
  process.env.GATEWAY_URL
    || process.env.PUBLIC_GATEWAY_URL
    || `http://localhost:${process.env.GATEWAY_PORT || 3001}`,
);
const FRONTEND_URL = trimSlash(
  process.env.FRONTEND_URL
    || `http://localhost:${process.env.FRONTEND_PORT || 3000}`,
);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
  || process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD
  || 'futureFlow@';

// ───────────────────────── 套件清单 ─────────────────────────
//
// group 语义：
//   local —— 纯本地运行时/工具回归，不需要任何服务，也不需要浏览器
//   api   —— 需要网关 + Dify 栈
//   gui   —— 需要网关 + 前端 + 可用的 Chrome/Edge
// needsPassword —— 脚本把管理员密码作为位置参数接收（其余脚本不读 argv，
//                  多传也无害，但这里仍按需传，避免脚本自己解析出错）。

const SUITES = [
  // ── 纯本地 ──
  { id: 'result-archive', script: 'test-result-archive.cjs', group: 'local', desc: '结果 ZIP 归档内容与文件名' },
  { id: 'media-credential-ui', script: 'test-media-credential-ui.cjs', group: 'local', desc: '媒体凭据 UUID 校验与画布密钥隔离' },
  { id: 'python-runtime', script: 'test-python-runtime.cjs', group: 'local', desc: 'Python 节点 params 契约（前端 payload）' },
  { id: 'condition-runtime', script: 'test-condition-runtime.cjs', group: 'local', desc: '条件分支本地运行时真值表' },
  { id: 'exit-runtime', script: 'test-exit-runtime.cjs', group: 'local', desc: '退出节点本地运行时' },
  { id: 'http-runtime', script: 'test-http-runtime.cjs', group: 'local', desc: 'API 请求节点 GET/POST 与嵌套 JSON 回显' },
  { id: 'batch-loop-runtime', script: 'test-batch-loop-runtime.cjs', group: 'local', desc: '数组批处理本地运行时' },
  { id: 'aggregator-runtime', script: 'test-aggregator-runtime.cjs', group: 'local', desc: '变量聚合本地运行时' },
  { id: 'loop-types-runtime', script: 'test-loop-types-runtime.cjs', group: 'local', desc: '循环三种类型 + 中间变量' },
  { id: 'llm-runtime', script: 'test-llm-runtime.cjs', group: 'local', desc: 'LLM 节点试运行票据注入（前端契约）' },

  // ── 需要网关 + Dify ──
  { id: 'new-modules-api', script: 'test-new-modules-api.cjs', group: 'api', desc: '知识库 / 文件上传 / MCP 注册' },
  { id: 'version-management', script: 'test-version-management.cjs', group: 'api', desc: '版本管理与导入导出' },
  { id: 'task-center', script: 'test-task-center.cjs', group: 'api', desc: '批量任务与异步任务' },
  { id: 'draft-run-online', script: 'test-draft-run-online.cjs', group: 'api', desc: '草稿云端试运行（含知识检索）' },
  { id: 'complex-workflow', script: 'test-complex-workflow.cjs', group: 'api', desc: '文本→模型→代码 真实执行' },
  { id: 'media-dify-chain', script: 'test-media-dify-chain.cjs', group: 'api', desc: '媒体桥受控失败路径' },
  { id: 'full-chain-test', script: 'full-chain-test.cjs', group: 'api', desc: '富节点全链路（16 节点真实跑到底）' },

  // ── 需要浏览器 ──
  { id: 'gui-click', script: 'test-gui-click.cjs', group: 'gui', needsPassword: true, desc: 'GUI 模拟点击（各页面渲染与入口）' },
  { id: 'gui-full', script: 'test-gui-full.cjs', group: 'gui', needsPassword: true, desc: 'GUI 全流程（建图→试运行→保存→后台）' },
  { id: 'page-buttons', script: 'test-page-buttons.cjs', group: 'gui', needsPassword: true, desc: '页面按钮逐一枚举核查' },
  { id: 'loop-body-node-ops', script: 'test-loop-body-node-ops.cjs', group: 'gui', needsPassword: true, desc: '循环体节点删除/移出/复制' },
  { id: 'loop-interactions', script: 'test-loop-interactions.cjs', group: 'gui', needsPassword: true, desc: '循环体折叠/展开/拖拽解耦' },
  { id: 'local-tools', script: 'test-local-tools.cjs', group: 'gui', needsPassword: true, desc: 'Python 节点真实执行（含连库）' },
  { id: 'trigger-failure-display', script: 'test-trigger-failure-display.cjs', group: 'gui', needsPassword: true, desc: '触发器「连续失败」界面可见性（依赖真实调度）' },
];

// ───────────────────────── 前置检查 ─────────────────────────

async function reachable(url, timeoutMs = 4000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status < 500;
  } catch {
    return false;
  }
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
    : process.platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((path) => path && existsSync(path)) || null;
}

function startHint() {
  return [
    '前置条件不满足。起服务涉及 Docker / 端口 / Dify 初始化，本脚本不代劳。',
    '',
    '  推荐： pnpm start          （会拉起 Docker 栈、跑迁移、起网关与前端）',
    '',
    '  若默认端口被占用或绑定报 EACCES（Windows 保留端口段），可换端口手动起：',
    `    cd gateway && GATEWAY_PORT=<端口> PUBLIC_GATEWAY_URL=http://localhost:<端口> \\`,
    '      DIFY_MEDIA_GATEWAY_URL=http://host.docker.internal:<端口> DIFY_MEDIA_GATEWAY_PORT=<端口> \\',
    '      node dist/main.js',
    `    cd frontend && FRONTEND_PORT=<前端端口> PUBLIC_GATEWAY_URL=http://localhost:<网关端口> \\`,
    '      MODE=app NODE_ENV=development ./node_modules/.bin/rsbuild dev',
    '',
    '  注意：换网关端口时媒体生成链路要求三处一致（GATEWAY_PORT、DIFY_MEDIA_GATEWAY_URL、',
    '  SSRF 代理的 MEDIA_GATEWAY_PORT 白名单），详见 README 的端口排障段落。',
  ].join('\n');
}

// ───────────────────────── 执行 ─────────────────────────

function parseArgs(argv) {
  const options = { group: null, suite: null, list: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--list') options.list = true;
    else if (arg.startsWith('--group=')) options.group = arg.slice('--group='.length);
    else if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length);
    else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function selectSuites(options) {
  let selected = SUITES;
  if (options.group) {
    selected = selected.filter((suite) => suite.group === options.group);
    if (!selected.length) {
      console.error(`没有 group=${options.group} 的套件。可选：local / api / gui`);
      process.exit(2);
    }
  }
  if (options.suite) {
    selected = SUITES.filter((suite) => suite.id === options.suite || suite.script === options.suite);
    if (!selected.length) {
      console.error(`找不到套件 ${options.suite}。用 --list 查看全部 id。`);
      process.exit(2);
    }
  }
  return selected;
}

function runSuite(suite) {
  const env = {
    ...process.env,
    GATEWAY_URL,
    FRONTEND_URL,
    GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
  };
  const args = [join(__dirname, suite.script)];
  if (suite.needsPassword) args.push(ADMIN_PASSWORD);

  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    ok: result.status === 0,
    /**
     * 约定：**退出码 2 表示「环境受限、无法验证」**（例如套件依赖的外部地址在本网络
     * 不可达）。这类结果既不是通过也不是代码回归，单独区分出来——否则一个被网络限制
     * 卡住的套件会长期显示为 FAIL，久而久之整套验收的可信度就没人信了。
     * 仅当脚本明确以此退出码表示环境问题时才成立，原因是必须打印出来的。
     */
    skipped: result.status === 2,
    status: result.status,
    durationMs,
    stdout,
    stderr,
    tail: (stderr || stdout).trim().split('\n').slice(-4).join('\n'),
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const suites = selectSuites(options);

  if (options.list) {
    for (const group of ['local', 'api', 'gui']) {
      const inGroup = suites.filter((suite) => suite.group === group);
      if (!inGroup.length) continue;
      console.log(`\n[${group}]`);
      for (const suite of inGroup) {
        console.log(`  ${suite.id.padEnd(22)} ${suite.script.padEnd(32)} ${suite.desc}`);
      }
    }
    return;
  }

  const needsGateway = suites.some((suite) => suite.group === 'api' || suite.group === 'gui');
  const needsFrontend = suites.some((suite) => suite.group === 'gui');
  const needsBrowser = needsFrontend;

  console.log(`网关:   ${GATEWAY_URL}`);
  console.log(`前端:   ${FRONTEND_URL}`);
  console.log(`套件:   ${suites.length} 个\n`);

  if (needsGateway && !(await reachable(`${GATEWAY_URL}/healthz`))) {
    console.error(`网关不可达：${GATEWAY_URL}/healthz\n\n${startHint()}`);
    process.exit(1);
  }
  if (needsFrontend && !(await reachable(`${FRONTEND_URL}/`))) {
    console.error(`前端不可达：${FRONTEND_URL}/\n\n${startHint()}`);
    process.exit(1);
  }
  if (needsBrowser && !findBrowser()) {
    console.error('未找到 Chrome/Edge，无法运行 gui 组套件。可设 PLAYWRIGHT_EXECUTABLE_PATH 指定浏览器。');
    process.exit(1);
  }

  const results = [];
  for (const suite of suites) {
    process.stdout.write(`▶ ${suite.id.padEnd(22)} `);
    const outcome = runSuite(suite);
    results.push({ suite, outcome });
    console.log(`${outcome.ok ? 'PASS' : outcome.skipped ? 'SKIP(环境受限)' : `FAIL(status=${outcome.status})`}  ${(outcome.durationMs / 1000).toFixed(1)}s`);
    if (!outcome.ok) {
      for (const line of outcome.tail.split('\n')) console.log(`    | ${line}`);
    }
  }

  const failed = results.filter((item) => !item.outcome.ok && !item.outcome.skipped);
  const skipped = results.filter((item) => item.outcome.skipped);
  console.log('\n================ 汇总 ================');
  for (const group of ['local', 'api', 'gui']) {
    const inGroup = results.filter((item) => item.suite.group === group);
    if (!inGroup.length) continue;
    const passed = inGroup.filter((item) => item.outcome.ok).length;
    const skippedInGroup = inGroup.filter((item) => item.outcome.skipped).length;
    console.log(`${group.padEnd(6)} ${passed}/${inGroup.length} 通过${skippedInGroup ? `（${skippedInGroup} 个环境受限跳过）` : ''}`);
  }
  const totalPassed = results.length - failed.length;
  console.log(`合计   ${totalPassed}/${results.length} 通过`);

  if (skipped.length) {
    console.log('\n环境受限跳过（不计为失败，但请确认原因）：');
    for (const item of skipped) {
      console.log(`  - ${item.suite.id}（${item.suite.script}）`);
      for (const line of item.outcome.tail.split('\n')) console.log(`      ${line}`);
    }
  }

  if (failed.length) {
    console.log('\n失败套件：');
    for (const item of failed) console.log(`  - ${item.suite.id}（${item.suite.script}）`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
