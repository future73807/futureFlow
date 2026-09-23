#!/usr/bin/env node
/**
 * 重新启用一个被安全机制封禁的账号。
 *
 * 为什么需要它：`SeedService.disableUnsafeLegacyDemoAdmin()` 会把仍在用历史公开
 * 密码的账号「暂停 + 降权」，这是设计如此（公开密码等于任何人可登录）。但账号
 * 本人想拿回来时，手工做有三步、且容易漏：
 *
 *   1. 换密码（必须换 —— 不换的话下次启动 seed 会再封一次）；
 *   2. 把 status 改回 active、按需把 role 改回 admin；
 *   3. **把 tokenVersion 自增**，让封禁前签发的 JWT 立即失效。
 *      （封禁只是让鉴权层拒绝旧 token，旧 token 本身没过期；不 +1 就等于
 *       留了一把还能开的钥匙。）
 *
 * 本脚本把三步一次做完，并且**先校验再写入**（不 dry-run 也会先打印将要做的
 * 变更）。密码只显示一次，不落任何文件 —— 与 bootstrap 管理员不同，它不是
 * `.env` 里的那个共享密码，写进 .env 反而会让所有测试脚本拿到错误的凭据。
 *
 * 用法：
 *   node scripts/reactivate-user.cjs --username demo                  # 随机新密码
 *   node scripts/reactivate-user.cjs --username demo --role admin     # 并恢复管理员角色
 *   node scripts/reactivate-user.cjs --username demo --password <值>   # 指定密码（≥12 位）
 *   node scripts/reactivate-user.cjs --username demo --dry-run        # 只看现状与将做的变更
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const VALID_ROLES = ['admin', 'user'];

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

/** 从 gateway 的依赖里取 pg / bcryptjs，避免为运维脚本再装一份依赖。 */
function requireFromGateway(name) {
  const candidates = [
    path.join(ROOT, 'gateway', 'node_modules', name),
    path.join(ROOT, 'node_modules', name),
    name,
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // 继续尝试下一个位置
    }
  }
  throw new Error(
    `找不到依赖 ${name}：请先执行 pnpm install（网关的依赖里已包含它）`,
  );
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function makePassword() {
  return `ff-${randomBytes(12).toString('base64url')}`;
}

async function main() {
  const username = argValue('--username');
  const role = argValue('--role');
  const explicit = argValue('--password');
  const dryRun = process.argv.includes('--dry-run');

  if (!username) {
    throw new Error('必须指定 --username（例如 --username demo）');
  }
  if (role && !VALID_ROLES.includes(role)) {
    throw new Error(`--role 只能是 ${VALID_ROLES.join(' 或 ')}`);
  }
  if (explicit && explicit.length < 12) {
    throw new Error('--password 至少 12 个字符');
  }

  const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
  const host = env.POSTGRES_HOST || 'localhost';
  const port = Number.parseInt(env.POSTGRES_PORT || '5432', 10);
  const database = env.POSTGRES_DB || 'futureflow';
  const user = env.POSTGRES_USER || 'futureflow';

  const pg = requireFromGateway('pg');
  const bcrypt = requireFromGateway('bcryptjs');
  const client = new pg.Client({
    host,
    port,
    database,
    user,
    password: env.POSTGRES_PASSWORD,
  });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `连不上 PostgreSQL（${host}:${port}）：${error.message}\n` +
        '请先 `pnpm run db:up` 并等待健康检查通过。',
    );
  }

  try {
    const found = await client.query(
      `SELECT id, username, email, role, status, "tokenVersion" FROM "users" WHERE username = $1`,
      [username],
    );
    if (found.rows.length === 0) {
      throw new Error(`账号不存在：${username}`);
    }
    const account = found.rows[0];
    const nextRole = role || account.role;
    const nextPassword = explicit || makePassword();

    console.log(`目标数据库: ${user}@${host}:${port}/${database}`);
    console.log(`账号: ${account.username} <${account.email}>`);
    console.log('');
    console.log('变更前:', {
      role: account.role,
      status: account.status,
      tokenVersion: account.tokenVersion,
    });
    console.log('变更后:', {
      role: nextRole,
      status: 'active',
      tokenVersion: account.tokenVersion + 1,
      password: '（已替换为新值）',
    });

    if (dryRun) {
      console.log('');
      console.log('--dry-run：不写入数据库。');
      return;
    }

    const hash = await bcrypt.hash(nextPassword, 10);
    const updated = await client.query(
      `UPDATE "users"
          SET "passwordHash" = $1,
              "role" = $2,
              "status" = 'active',
              "tokenVersion" = "tokenVersion" + 1
        WHERE id = $3
        RETURNING role, status, "tokenVersion"`,
      [hash, nextRole, account.id],
    );

    console.log('');
    console.log('已写入:', updated.rows[0]);
    console.log('');
    console.log(`新的登录密码：${nextPassword}`);
    console.log('');
    console.log('这是唯一一次显示，脚本不落盘。请立刻保存到你的密码管理器。');
    console.log('忘了就再跑一次本脚本（会再换一个新密码）。');
    console.log('');
    console.log('注意：封禁前签发的 JWT 已因 tokenVersion +1 而失效，需要重新登录。');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exitCode = 1;
});
