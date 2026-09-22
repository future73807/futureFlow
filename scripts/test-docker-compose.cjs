#!/usr/bin/env node
/**
 * Docker Compose 调用形式探测的回归测试。
 *
 * 背景：项目原先在 start-full-stack.cjs / fresh-volume-e2e.cjs / package.json 里
 * **写死 `docker compose`**（v2 插件形式）。插件缺失的机器上整条启动链路直接失败，
 * 而报错是 `docker: unknown command: docker compose` —— 看起来像命令敲错、实际是
 * 环境缺插件，排查方向会被彻底带偏（本机就是这样，`docker info` 的插件列表里只有 dhi）。
 *
 * 这个测试守两件事：
 *   1. 探测逻辑本身正确（有插件用插件、只有独立二进制就用它、两者都没有时给出可读提示）
 *   2. **代码里不再出现写死的 compose 调用** —— 这是防回归的关键，纯静态可查，
 *      不需要 Docker 也能跑
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');

const { detectCompose, composeInvocation, describeCompose } = require('./lib/docker-compose.cjs');
const { composeContainerIds, containerState, resolveDockerArgs } = require('./start-full-stack.cjs');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${label} :: ${error.message}`);
  }
}

// ── 1. 探测结果自洽 ────────────────────────────────────────────────────
check('detectCompose 返回结构完整', () => {
  const d = detectCompose();
  assert.equal(typeof d.available, 'boolean', 'available 应为布尔');
  assert.equal(typeof d.command, 'string', 'command 应为字符串');
  assert.ok(Array.isArray(d.baseArgs), 'baseArgs 应为数组');
  assert.ok(d.command.length > 0, 'command 不能为空');
});

check('detectCompose 结果被缓存（同一对象）', () => {
  assert.equal(detectCompose(), detectCompose(), '多次调用应返回同一对象');
});

check('两种形式都没有时给出可读提示而不是静默失败', () => {
  const d = detectCompose();
  if (d.available) {
    // 本机有可用的形式：确认它没有误带 hint
    assert.equal(d.hint, undefined, '可用时不应有 hint');
  } else {
    assert.ok(typeof d.hint === 'string' && d.hint.length > 0, '不可用时应给出 hint');
    assert.match(d.hint, /compose/i, 'hint 应说明缺的是什么');
  }
});

check('composeInvocation 把参数接在 baseArgs 之后', () => {
  const d = detectCompose();
  const { command, args } = composeInvocation(['up', '-d', 'postgres']);
  assert.equal(command, d.command, 'command 应与探测结果一致');
  assert.deepEqual(
    args,
    [...d.baseArgs, 'up', '-d', 'postgres'],
    'compose 参数应原样接在 baseArgs 之后',
  );
});

check('composeInvocation 默认参数为空数组', () => {
  const d = detectCompose();
  assert.deepEqual(composeInvocation().args, [...d.baseArgs], '不传参数时只应有 baseArgs');
});

check('describeCompose 返回非空描述', () => {
  const text = describeCompose();
  assert.equal(typeof text, 'string');
  assert.ok(text.trim().length > 0, '描述不能为空');
});

// ── 2. 探测到的形式真的能跑 ────────────────────────────────────────────
check('探测到的 compose 形式可实际执行', () => {
  const d = detectCompose();
  if (!d.available) {
    console.log('       跳过：本机没有可用的 compose（静态检查仍已执行）');
    return;
  }
  const probe = spawnSync(d.command, [...d.baseArgs, 'version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(probe.status, 0, `${d.label} version 应退出 0，实际 ${probe.status}`);
  assert.ok(
    /compose/i.test(probe.stdout || ''),
    `${d.label} version 的输出应提到 compose，实际 ${JSON.stringify((probe.stdout || '').slice(0, 80))}`,
  );
});

// ── 3. start-full-stack 的前缀解析 ─────────────────────────────────────
check('resolveDockerArgs 给 compose 加上本机可用的前缀', () => {
  const d = detectCompose();
  const resolved = resolveDockerArgs(['compose', 'up', '-d']);
  assert.equal(resolved.command, d.command, 'compose 调用应走探测结果');
  assert.deepEqual(resolved.args, [...d.baseArgs, 'up', '-d'], 'compose 子命令应原样透传');
});

check('resolveDockerArgs 不动非 compose 的 docker 调用', () => {
  const resolved = resolveDockerArgs(['exec', 'futureflow-postgres', 'psql', '-V']);
  assert.equal(resolved.command, 'docker', '非 compose 调用应保持 docker 直调');
  assert.deepEqual(
    resolved.args,
    ['exec', 'futureflow-postgres', 'psql', '-V'],
    '非 compose 调用的参数不应被改写',
  );
});

// ── 3b. 健康检查的读取链路（真实探测）──────────────────────────────────
check('containerState 能真实读到容器的 State（含 Health）', () => {
  const d = detectCompose();
  if (!d.available) {
    console.log('       跳过：本机没有可用的 compose');
    return;
  }
  // 找一个正在跑的 futureflow 容器；没有就跳过（本测试不负责起容器）
  const services = ['postgres', 'dify-api', 'dify-postgres', 'dify-redis'];
  let ids = [];
  for (const service of services) {
    try {
      ids = composeContainerIds(service, process.env);
    } catch {
      continue;
    }
    if (ids.length > 0) break;
  }
  if (ids.length === 0) {
    console.log('       跳过：当前没有在跑的 futureflow 容器（起栈后再跑可覆盖此路径）');
    return;
  }

  const state = containerState(ids[0], process.env);
  assert.ok(state, `containerState 应返回解析后的 State，实际 ${JSON.stringify(state)}`);
  assert.equal(typeof state.Status, 'string', 'State 应含 Status 字段');
  assert.ok(state.Status.length > 0, 'Status 不能为空');
  // 这条是关键：`--format '{{json .State}}'` 一旦被 shell 拆开会解析失败，
  // 表现为 state 为 null —— 而健康检查会因此一路等到超时，报「未在预期时间内健康」
  // 这种与真实原因毫不相干的错。实测踩过，所以在这里挡住。
  assert.ok(
    'Health' in state || state.Status === 'running',
    `State 应能被完整解析（含 Health），实际 keys=${Object.keys(state).join(',')}`,
  );
});

// ── 4. 防回归：代码里不得再出现写死的 compose 调用 ─────────────────────
check('package.json 的脚本不再写死 `docker compose`', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const offenders = Object.entries(pkg.scripts)
    .filter(([, value]) => /(^|\s)docker\s+compose(\s|$)/.test(value))
    .map(([name, value]) => `${name}: ${value}`);
  assert.deepEqual(
    offenders, [],
    `这些脚本写死了 \`docker compose\`，应改用 node scripts/compose.cjs：\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * 去掉整行注释后再做静态匹配。
 *
 * 必要：本测试与 start-full-stack.cjs 的说明注释里都会引用
 * `run('docker', ['compose', ...])` 这个**反面写法**作为例子，不过滤的话
 * 检查会把解释文字当成违规代码，逼得人不敢写注释。
 * 只剔除「整行就是注释」的行（`//`、`*`、`/*` 开头），不动行尾注释与字符串，
 * 避免误伤 `https://` 之类。
 */
function stripCommentLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

check('scripts/*.cjs 不再以 `\'docker\', [\'compose\'` 形式写死调用', () => {
  const offenders = [];
  for (const name of readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith('.cjs')) continue;
    if (name === 'test-docker-compose.cjs') continue; // 本文件自身的匹配模式
    const source = stripCommentLines(readFileSync(join(SCRIPTS_DIR, name), 'utf8'));
    // 匹配「'docker' 紧跟一个以 'compose' 开头的数组」这种写死的调用形式
    if (/'docker'\s*,\s*\[\s*'compose'/.test(source)) offenders.push(name);
  }
  assert.deepEqual(
    offenders, [],
    `这些脚本写死了 compose 调用，应改用 lib/docker-compose.cjs 的 composeInvocation：\n  ${offenders.join('\n  ')}`,
  );
});

check('package.json 的 compose 脚本确实走 compose.cjs 转发器', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const expected = ['db:up', 'compose:up', 'db:down', 'db:logs'];
  for (const name of expected) {
    assert.ok(pkg.scripts[name], `应存在脚本 ${name}`);
    assert.match(
      pkg.scripts[name], /node scripts\/compose\.cjs/,
      `${name} 应通过 compose.cjs 转发，实际 ${pkg.scripts[name]}`,
    );
  }
});

// ── 5. compose.cjs 转发器的行为 ────────────────────────────────────────
check('compose.cjs 无参数时给出用法并退出 2', () => {
  const probe = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'compose.cjs')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(probe.status, 2, `无参数应退出 2，实际 ${probe.status}`);
  assert.match(probe.stderr || '', /用法/, '应打印用法说明');
  assert.match(probe.stderr || '', /compose/i, '应说明本机可用的形式');
});

check('compose.cjs 透传 compose 的退出码', () => {
  if (!detectCompose().available) {
    console.log('       跳过：本机没有可用的 compose');
    return;
  }
  const probe = spawnSync(
    process.execPath,
    [join(SCRIPTS_DIR, 'compose.cjs'), 'this-subcommand-does-not-exist'],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  assert.notEqual(probe.status, 0, '错误的子命令应返回非 0 退出码');
  assert.notEqual(probe.status, 2, '不应退化成「用法错误」的退出码 2');
});

console.log(`\n===== Docker Compose 探测测试: ${passed}/${passed + failed} passed =====`);
process.exit(failed === 0 ? 0 : 1);
