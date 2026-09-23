#!/usr/bin/env node
/**
 * 轮换 futureFlow 管理员密码。
 *
 * 为什么要单独一个脚本：`SeedService` 只在「库里还没有管理员」时创建账号，
 * 所以只改 `.env` 对已经跑过的库**完全无效**——管理员账号仍用旧密码。
 * 而旧密码是写进过 README / .env.example / 20 多个脚本的公开值，只要把
 * `GATEWAY_HOST` 改成 0.0.0.0 就等于把管理员账号交给任何人。
 *
 * 本脚本一次做完两件事：
 *   1. 在 .env 里写入一个新的随机 `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD`；
 *   2. 直接更新数据库里现有管理员账号的 `passwordHash`，并把 `tokenVersion`
 *      自增，让此前签发的 JWT 立即失效。
 *
 * **只作用于 `.env` 里 `GATEWAY_BOOTSTRAP_ADMIN_USERNAME` 指名的那个账号**。
 * 库里可能不止一个管理员（例如后来解封并被提权的账号），所以这里按用户名
 * 精确匹配；找不到就报错，绝不自动挑一个 —— 挑错了会把 .env 的密码写成
 * 另一个账号的密码，两边对不上直接锁死。
 * 要轮换**其他**账号用 `pnpm run user:reactivate`（它不碰 .env）。
 *
 * 用法：
 *   node scripts/rotate-admin-password.cjs                 # 随机生成并应用
 *   node scripts/rotate-admin-password.cjs --dry-run       # 只打印将要做什么
 *   node scripts/rotate-admin-password.cjs --password <值>  # 使用指定密码
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

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

function makePassword() {
  return `ff-${randomBytes(12).toString('base64url')}`;
}

/**
 * 从库里所有 `role='admin'` 的行里，挑出「`.env` 所描述的那个引导管理员」。
 *
 * **必须按用户名精确匹配**，不能用「最早的 admin」代替：库里可能不止一个
 * 管理员（例如后来解封并被提权的账号），挑错就会把 `.env` 里的
 * `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD` 写成**另一个账号**的密码 ——
 * 两边对不上，登录直接锁死，而报错现场离真因很远。
 *
 * 找不到时返回 `{ account: null }`，由调用方决定是报错还是「库里还没有管理员」。
 */
function selectBootstrapAdmin(admins, configuredUsername) {
  const wanted = String(configuredUsername || '').trim();
  if (!wanted) return { account: null };
  return { account: admins.find((row) => row.username === wanted) || null };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const explicitIndex = process.argv.indexOf('--password');
  const explicit = explicitIndex >= 0 ? process.argv[explicitIndex + 1] : '';
  if (explicit && explicit.length < 12) {
    throw new Error('--password 至少 12 个字符');
  }

  const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
  const newPassword = explicit || makePassword();

  const host = env.POSTGRES_HOST || 'localhost';
  const port = Number.parseInt(env.POSTGRES_PORT || '5432', 10);
  const database = env.POSTGRES_DB || 'futureflow';
  const user = env.POSTGRES_USER || 'futureflow';
  const adminUsername = env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const adminEmail = env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL || 'admin@futureflow.local';

  console.log(`目标数据库: ${user}@${host}:${port}/${database}`);
  console.log(`管理员账号: ${adminUsername} <${adminEmail}>`);
  if (dryRun) {
    console.log('--dry-run：不写入 .env，不改数据库。');
    return;
  }

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
    const admins = (
      await client.query(
        `SELECT id, username, email, role, "createdAt" FROM "users" WHERE role = 'admin' ORDER BY "createdAt"`,
      )
    ).rows;

    const picked = selectBootstrapAdmin(admins, adminUsername);

    if (!picked.account && admins.length > 0) {
      throw new Error(
        `.env 里的引导管理员用户名 \`${adminUsername}\` 在库里不存在，` +
          `但库里有这些管理员：${admins.map((row) => row.username).join('、')}。\n` +
          '请先把 GATEWAY_BOOTSTRAP_ADMIN_USERNAME 改成你要轮换的那个用户名' +
          '（或改回正确的名字），再重跑本脚本。\n' +
          '这里**故意不自动挑一个**：挑错了会把 .env 的密码写成另一个账号的密码。',
      );
    }

    if (!picked.account) {
      // 还没有管理员：只需保证 .env 里的值就是接下来 seed 会用的值
      console.log('库里没有管理员账号，本次只更新 .env（下次启动由 seed 创建）。');
    } else {
      const hash = await bcrypt.hash(newPassword, 10);
      await client.query(
        `UPDATE "users" SET "passwordHash" = $1, "tokenVersion" = "tokenVersion" + 1 WHERE id = $2`,
        [hash, picked.account.id],
      );
      console.log(
        `已更新管理员 ${picked.account.username} 的密码，并让旧 JWT 失效（tokenVersion +1）。`,
      );
    }
  } finally {
    await client.end();
  }

  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const pattern = /^(GATEWAY_BOOTSTRAP_ADMIN_PASSWORD=)([^\r\n]*)$/m;
  const next = pattern.test(raw)
    ? raw.replace(pattern, `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD=${newPassword}`)
    : `${raw.replace(/\s*$/, '')}\nGATEWAY_BOOTSTRAP_ADMIN_PASSWORD=${newPassword}\n`;
  fs.writeFileSync(ENV_PATH, next, { mode: 0o600 });

  console.log('');
  console.log(`新的管理员密码已写入 .env：${newPassword}`);
  console.log('请妥善保存；这是唯一一次显示。所有测试脚本都会从 .env 读取它。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FATAL:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { selectBootstrapAdmin };
