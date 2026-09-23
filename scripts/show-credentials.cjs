#!/usr/bin/env node
/**
 * 显示本机当前的登录凭据与账号状态。
 *
 * 为什么需要它：管理员密码由 `pnpm run env:init` 随机生成、只在终端打印一次，
 * 忘了就得去 `.env` 里翻。而 `.env` 有几十行、名字又长，不便于日常查。
 *
 * **本脚本只读、不写任何文件**，输出仅打印到当前终端。
 * 仓库是公开的，所以这些值**绝不能**写进 README 之类的入库文件 ——
 * 需要留存请写进已 gitignore 的 `CREDENTIALS.local.md`（见 README「测试账号」一节）。
 *
 * 用法：
 *   pnpm run credentials:show              # 打印引导管理员凭据 + 数据库里的账号列表
 *   pnpm run credentials:show -- --no-db   # 不连数据库，只打印 .env 里的凭据
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const LOCAL_CREDENTIALS = path.join(ROOT, 'CREDENTIALS.local.md');

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

function requireFromGateway(name) {
  for (const candidate of [
    path.join(ROOT, 'gateway', 'node_modules', name),
    path.join(ROOT, 'node_modules', name),
    name,
  ]) {
    try {
      return require(candidate);
    } catch {
      // 继续尝试下一个位置
    }
  }
  throw new Error(`找不到依赖 ${name}：请先执行 pnpm install`);
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error('未找到 .env —— 请先执行 `pnpm run env:init`。');
  }
  const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));

  const username = env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const email = env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL || 'admin@futureflow.local';
  const password = env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD || '';
  const enabled = (env.GATEWAY_BOOTSTRAP_ADMIN_ENABLED || 'true').toLowerCase() === 'true';

  console.log('');
  console.log('  引导管理员（登录 http://localhost:3000/login）');
  console.log('  ─────────────────────────────────────────');
  console.log(`    用户名 : ${username}`);
  console.log(`    邮箱   : ${email}   （登录接口两者都接受）`);
  console.log(`    密码   : ${password || '⚠️ .env 里没有 GATEWAY_BOOTSTRAP_ADMIN_PASSWORD'}`);
  console.log(`    自动初始化: ${enabled ? '启用' : '已关闭（GATEWAY_BOOTSTRAP_ADMIN_ENABLED=false）'}`);
  console.log('');

  if (!process.argv.includes('--no-db')) {
    const pg = requireFromGateway('pg');
    const client = new pg.Client({
      host: env.POSTGRES_HOST || 'localhost',
      port: Number.parseInt(env.POSTGRES_PORT || '5432', 10),
      database: env.POSTGRES_DB || 'futureflow',
      user: env.POSTGRES_USER || 'futureflow',
      password: env.POSTGRES_PASSWORD,
    });
    try {
      await client.connect();
      const rows = (
        await client.query(
          `SELECT username, email, role, status FROM "users" ORDER BY "createdAt"`,
        )
      ).rows;
      console.log('  数据库里的账号');
      console.log('  ─────────────────────────────────────────');
      for (const r of rows) {
        const flag = r.status === 'active' ? '✓' : '✗';
        console.log(`    ${flag} ${r.username.padEnd(16)} ${r.role.padEnd(6)} ${r.status.padEnd(10)} ${r.email}`);
      }
      console.log('');
      console.log('  注：上面只有「引导管理员」的密码能从 .env 读到。');
      console.log('      其他账号的密码是 bcrypt 哈希、无法反推 —— 忘记了就重置：');
      console.log('        pnpm run user:reactivate --username <名> --role admin');
      console.log('');
    } catch (error) {
      console.log(`  ⚠️ 连不上数据库，跳过账号列表：${error.message}`);
      console.log('     （数据库没起时可加 --no-db 跳过）');
      console.log('');
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (fs.existsSync(LOCAL_CREDENTIALS)) {
    console.log(`  本机凭据备份：${path.relative(ROOT, LOCAL_CREDENTIALS)}（已 gitignore，不会入库）`);
  } else {
    console.log('  提示：想把凭据留存到本机，可写进 CREDENTIALS.local.md（该文件已 gitignore）。');
  }
  console.log('');
  console.log('  ⚠️ 这些值不要写进 README / 文档等会入库的文件 —— 仓库是公开的。');
  console.log('');
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exitCode = 1;
});
