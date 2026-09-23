#!/usr/bin/env node
/**
 * `rotate-admin-password.cjs` 选号逻辑的回归测试。
 *
 * 背景：该脚本原先用
 *   `SELECT ... FROM "users" WHERE role = 'admin' ORDER BY "createdAt" LIMIT 1`
 * 来挑要轮换的账号 —— 也就是「最早的 admin」。在只有一个管理员时它是对的，
 * 但库里**可以有多个管理员**（本项目就有一个后来解封并被提权的 `demo`）。
 * 一旦 `admin` 被改名或删除，脚本会**静默轮换另一个管理员的密码，却把新密码
 * 写进 `.env`** —— 而 `.env` 描述的是 `admin`。两边对不上，登录直接锁死，
 * 且报错现场（登录失败）离真因（脚本挑错了账号）很远。
 *
 * 所以现在改成按 `.env` 的 `GATEWAY_BOOTSTRAP_ADMIN_USERNAME` **精确匹配**，
 * 找不到就报错、绝不自动挑一个。这个测试守两件事：
 *   1. `selectBootstrapAdmin` 的选择行为（纯函数，不需要数据库）
 *   2. **源码里不再出现「只按 role 过滤 + LIMIT 1」的写法** —— 纯静态可查，
 *      不需要数据库也能跑
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(ROOT, 'scripts', 'rotate-admin-password.cjs');

const { selectBootstrapAdmin } = require('./rotate-admin-password.cjs');

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

/** 造一行用户记录；只填选择逻辑关心的字段。 */
const row = (username, createdAt) => ({
  id: `id-${username}`,
  username,
  email: `${username}@futureflow.local`,
  role: 'admin',
  createdAt,
});

// 真实场景：admin 先建（9-13），demo 后建（9-14）。按 createdAt 排序时
// admin 在前 —— 所以「最早的」恰好等于「正确的那一个」，bug 会被掩盖。
const ADMIN = row('admin', '2026-09-13T00:00:00Z');
const DEMO = row('demo', '2026-09-14T00:00:00Z');

console.log('— 选择行为 —');

check('只有一个管理员且用户名匹配 → 选中它', () => {
  const { account } = selectBootstrapAdmin([ADMIN], 'admin');
  assert.equal(account?.username, 'admin');
});

check('多个管理员时按用户名精确匹配，而不是「最早的那个」', () => {
  // 故意把 demo 放在前面（模拟 createdAt 顺序反转 / admin 被改名后重建）
  const { account } = selectBootstrapAdmin([DEMO, ADMIN], 'admin');
  assert.equal(account?.username, 'admin', '必须按用户名匹配，不能取数组第一项');
});

check('配置名指向第二个管理员时也能选中（反向用例）', () => {
  const { account } = selectBootstrapAdmin([ADMIN, DEMO], 'demo');
  assert.equal(account?.username, 'demo');
});

check('配置名在库里不存在 → 返回 null（由调用方报错，不自动挑）', () => {
  const { account } = selectBootstrapAdmin([ADMIN, DEMO], 'someone-else');
  assert.equal(account, null);
});

check('库里有管理员但配置名不匹配时，仍返回 null 而不是兜底挑一个', () => {
  const { account } = selectBootstrapAdmin([DEMO], 'admin');
  assert.equal(account, null, 'admin 不在库里，绝不能拿 demo 顶替');
});

check('库里没有任何管理员 → 返回 null', () => {
  assert.equal(selectBootstrapAdmin([], 'admin').account, null);
});

check('配置名为空 / 纯空白 → 返回 null（不误选第一个）', () => {
  assert.equal(selectBootstrapAdmin([ADMIN], '').account, null);
  assert.equal(selectBootstrapAdmin([ADMIN], '   ').account, null);
  assert.equal(selectBootstrapAdmin([ADMIN], undefined).account, null);
});

check('用户名大小写不同不算匹配（保持精确语义）', () => {
  assert.equal(selectBootstrapAdmin([ADMIN], 'Admin').account, null);
});

check('同名前缀的账号不能被误选（admin 不能匹配 admin-backup）', () => {
  const ADMIN_BACKUP = row('admin-backup', '2026-09-15T00:00:00Z');
  // 精确匹配：admin 存在时选中 admin
  assert.equal(
    selectBootstrapAdmin([ADMIN, ADMIN_BACKUP], 'admin').account?.username,
    'admin',
  );
  // admin 不存在、只有 admin-backup 时，必须返回 null，不能前缀兜底
  assert.equal(
    selectBootstrapAdmin([ADMIN_BACKUP], 'admin').account,
    null,
    'admin 不在库里，绝不能拿 admin-backup 顶替',
  );
});

console.log('— 源码级防回归 —');

check('不再使用「只按 role 过滤 + LIMIT 1」的查询', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  // 去掉整行注释，避免注释里提到旧写法时误判
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !/WHERE\s+role\s*=\s*'admin'[\s\S]{0,200}?LIMIT\s+1/i.test(code),
    'rotate-admin-password.cjs 又出现了「按 role 过滤 + LIMIT 1」的写法：' +
      '这会在多管理员时挑错账号，把 .env 的密码写成别人的',
  );
});

check('查询确实按 .env 配置的用户名匹配（selectBootstrapAdmin 被真正调用）', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(
    /selectBootstrapAdmin\s*\(/.test(source.replace(/function\s+selectBootstrapAdmin/, '')),
    '脚本没有调用 selectBootstrapAdmin —— 选号逻辑必须走这个可测函数',
  );
  assert.ok(
    /admins\.length\s*>\s*0/.test(source),
    '脚本缺少「库里有管理员但配置名不匹配 → 报错」的分支',
  );
});

check('调用点传的是配置变量，不是写死的用户名', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  // 必须先剔除**函数定义**那一行 —— 它的形参也是 (admins, ...)，否则永远命中定义
  const withoutDef = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*function\s+selectBootstrapAdmin\b/.test(line))
    .join('\n');
  const call = withoutDef.match(/selectBootstrapAdmin\s*\(\s*([^,)]+),\s*([^)]+)\)/);
  assert.ok(call, '找不到 selectBootstrapAdmin 的调用点');
  assert.ok(
    /adminUsername/.test(call[2]),
    `调用点第二个参数是 \`${call[2].trim()}\`，应当传 .env 解析出的 adminUsername` +
      '（写死用户名会让 GATEWAY_BOOTSTRAP_ADMIN_USERNAME 形同虚设）',
  );
});

check('报错分支不会退化成「静默挑一个」', () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  // 有管理员但配置名不匹配时，必须 throw，不能只 console.log 后继续
  const branch = code.match(/if\s*\(\s*!picked\.account\s*&&\s*admins\.length\s*>\s*0\s*\)\s*\{([\s\S]{0,600}?)\n\s*\}/);
  assert.ok(branch, '找不到「有管理员但配置名不匹配」的分支');
  assert.ok(
    /throw\s+new\s+Error/.test(branch[1]),
    '该分支必须 throw —— 只打印警告然后继续，就等于静默挑了别的账号',
  );
});

console.log('');
console.log(`rotate-admin-password smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
