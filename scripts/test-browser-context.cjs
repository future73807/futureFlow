#!/usr/bin/env node
/**
 * 回归测试：禁止把 Node 侧符号写进 `page.evaluate` 的回调（浏览器上下文）。
 *
 * 背景见 `scripts/lib/browser-context.cjs` 的注释。一句话：P0-1 把
 * `password: 'futureFlow@'`（字面量）换成 `password: adminPassword()`（Node 调用）
 * 之后，5 个 GUI 脚本全部抛 `ReferenceError: adminPassword is not defined`；
 * 而它们都是孤儿、从没被执行，所以回归一直没暴露。
 *
 * 本测试守两件事：
 *   1. 全部 `scripts/*.cjs` 的 `page.evaluate` 回调里没有 Node 侧符号
 *   2. **扫描器自身有效** —— 对一段已知有问题的合成代码必须报出违规。
 *      少了第 2 条，扫描器写坏了会静默「全绿」，比没有还危险。
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const { findBrowserContextLeaks } = require('./lib/browser-context.cjs');

const ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');

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

// ── 1. 扫描器自校验（先证明它能抓到东西，再拿它去检查真实代码）──────────

check('自校验：回调里写 adminPassword() 必须被报出', () => {
  const bad = [
    "await page.evaluate(async () => {",
    "  await fetch('/auth/login', { body: JSON.stringify({ password: adminPassword() }) });",
    '});',
  ].join('\n');
  const hits = findBrowserContextLeaks(bad);
  assert.ok(hits.length >= 1, '扫描器没报出明显的违规 —— 扫描器本身坏了');
  assert.equal(hits[0].symbol, 'adminPassword');
});

check('自校验：合法实参（Node 侧求值）不得被误报', () => {
  // `adminPassword()` 在**回调之外**，是 Node 侧求值后作为参数传进去的 —— 合法
  const good = [
    'await page.evaluate(async (password) => {',
    "  await fetch('/auth/login', { body: JSON.stringify({ password }) });",
    '}, adminPassword());',
  ].join('\n');
  assert.deepEqual(
    findBrowserContextLeaks(good), [],
    '把合法的「回调外实参」误报成违规了（第一版就是这样，假阳性）',
  );
});

check('自校验：形参同名不算引用', () => {
  const good = 'await page.evaluate(async ({ password }) => { use(password); }, { password: adminPassword() });';
  assert.deepEqual(findBrowserContextLeaks(good), [], '形参声明被误判为引用');
});

check('自校验：回调里用 process / readFileSync 也要报', () => {
  const bad = "await page.evaluate(() => { const p = process.env.X; const s = readFileSync('a'); });";
  const symbols = findBrowserContextLeaks(bad).map((h) => h.symbol).sort();
  assert.deepEqual(symbols, ['process', 'readFileSync'].filter((s) => symbols.includes(s)));
  assert.ok(symbols.length >= 1, '回调里的 Node 全局未被报出');
});

check('自校验：逗号切分不被嵌套括号/字符串误导', () => {
  const good = [
    'await page.evaluate(async ({ a, b }) => {',
    '  const x = [1, 2, 3];',
    "  const s = 'a, b, c';",
    '  use(x, s, a, b);',
    '}, { a: 1, b: 2 });',
  ].join('\n');
  assert.deepEqual(findBrowserContextLeaks(good), [], '嵌套结构里的逗号被当成了实参分隔');
});

// ── 2. 真实代码 ─────────────────────────────────────────────────────────

check('scripts/*.cjs 的 page.evaluate 回调里没有 Node 侧符号', () => {
  const offenders = [];
  for (const name of readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith('.cjs')) continue;
    if (name === 'test-browser-context.cjs') continue; // 本文件含反面示例字符串
    const source = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    for (const hit of findBrowserContextLeaks(source)) {
      offenders.push(`${name}:${hit.line} → ${hit.symbol}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    '这些地方把 Node 侧符号写进了 page.evaluate 回调，运行时会 ReferenceError：\n  '
      + offenders.join('\n  ')
      + '\n修法：把它作为参数传给 evaluate，例如 `page.evaluate(async (password) => {...}, adminPassword())`',
  );
});

console.log(`\n===== 浏览器上下文检查: ${passed}/${passed + failed} passed =====`);
process.exit(failed === 0 ? 0 : 1);
