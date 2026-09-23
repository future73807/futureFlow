#!/usr/bin/env node
/**
 * 为**已经存在的数据卷**创建/刷新应用数据库账号（权限收窄）。
 *
 * 背景：官方 postgres 镜像把 POSTGRES_USER 建成了超级用户，而应用一直直接用
 * 它连库。这个脚本建一个只拥有 futureflow 库的业务账号，超级用户只留给迁移。
 * 全新数据卷由 infra/postgres/initdb/10-app-user.sh 在 initdb 阶段完成，
 * 存量卷必须手动跑一次本脚本——initdb.d 不会在已有卷上执行。
 *
 * SQL 只有一份（infra/postgres/app-user.sql），这里做 psql 变量渲染后执行，
 * 因此不会出现「两份 SQL 慢慢分叉」的问题。
 *
 * 用法：
 *   node scripts/db-grant-app-user.cjs               # 缺密码时随机生成并写入 .env
 *   node scripts/db-grant-app-user.cjs --ddl=false   # 生产：不给建表权限
 *   node scripts/db-grant-app-user.cjs --dry-run     # 只打印将要执行的动作
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const SQL_PATH = path.join(ROOT, 'infra', 'postgres', 'app-user.sql');

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

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** 把 psql 变量（:'x' / :"x"）渲染成字面量，供 node-postgres 执行。 */
function renderPsqlVars(sql, vars) {
  let out = sql;
  for (const [name, value] of Object.entries(vars)) {
    out = out
      .split(`:'${name}'`).join(quoteLiteral(value))
      .split(`:"${name}"`).join(quoteIdent(value));
  }
  // 校验只看正文：注释里出现 "migration:run" 之类的冒号不算漏渲染
  const body = out
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/::/g, '');
  const leftover = body.match(/:[a-z_]+/g);
  if (leftover) {
    throw new Error(`SQL 里还有未渲染的 psql 变量：${leftover.join(', ')}`);
  }
  return out;
}

function upsertEnv(raw, key, value) {
  const pattern = new RegExp(`^(${key}=)([^\\r\\n]*)$`, 'm');
  if (pattern.test(raw)) return raw.replace(pattern, `${key}=${value}`);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  return `${raw.replace(/\s*$/, '')}${newline}${key}=${value}${newline}`;
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
      // 下一个位置
    }
  }
  throw new Error(`找不到依赖 ${name}：请先执行 pnpm install`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ddlArg = process.argv.find((a) => a.startsWith('--ddl='));
  let raw = fs.readFileSync(ENV_PATH, 'utf8');
  let env = parseEnv(raw);

  const allowDdl = ddlArg ? ddlArg.slice('--ddl='.length) : env.POSTGRES_APP_ALLOW_DDL || 'true';
  const appUser = env.POSTGRES_APP_USER || 'futureflow_app';
  let appPassword = env.POSTGRES_APP_PASSWORD;
  let generated = false;
  if (!appPassword || /^(replace-with-|change-me)/i.test(appPassword)) {
    appPassword = randomBytes(32).toString('hex');
    generated = true;
  }

  const vars = {
    app_user: appUser,
    app_password: appPassword,
    db_name: env.POSTGRES_DB || 'futureflow',
    allow_ddl: allowDdl === 'true' ? 'true' : 'false',
  };
  const sql = renderPsqlVars(fs.readFileSync(SQL_PATH, 'utf8'), vars);

  console.log(`应用账号: ${appUser}（allow_ddl=${vars.allow_ddl}）`);
  console.log(`目标库:   ${vars.db_name} on ${env.POSTGRES_HOST || 'localhost'}:${env.POSTGRES_PORT || 5432}`);
  if (dryRun) {
    console.log('--dry-run：不写入 .env，不执行 SQL。');
    return;
  }

  const pg = requireFromGateway('pg');
  const admin = new pg.Client({
    host: env.POSTGRES_HOST || 'localhost',
    port: Number.parseInt(env.POSTGRES_PORT || '5432', 10),
    database: env.POSTGRES_DB || 'futureflow',
    user: env.POSTGRES_USER || 'futureflow',
    password: env.POSTGRES_PASSWORD,
  });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `连不上 PostgreSQL：${error.message}\n请先 pnpm run db:up 并等待健康检查通过。`,
    );
  }

  try {
    await admin.query(sql);
    const check = await admin.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [appUser],
    );
    console.log('账号权限:', JSON.stringify(check.rows[0]));
  } finally {
    await admin.end();
  }

  // 用新账号真的连一次，确认能登录且只能连自己的库
  const appClient = new pg.Client({
    host: env.POSTGRES_HOST || 'localhost',
    port: Number.parseInt(env.POSTGRES_PORT || '5432', 10),
    database: env.POSTGRES_DB || 'futureflow',
    user: appUser,
    password: appPassword,
  });
  await appClient.connect();
  try {
    const count = await appClient.query('SELECT count(*)::int AS n FROM "users"');
    console.log(`以应用账号登录成功，可读 users 表（${count.rows[0].n} 行）。`);
  } finally {
    await appClient.end();
  }

  // 回写 .env
  raw = fs.readFileSync(ENV_PATH, 'utf8');
  raw = upsertEnv(raw, 'POSTGRES_APP_USER', appUser);
  raw = upsertEnv(raw, 'POSTGRES_APP_PASSWORD', appPassword);
  raw = upsertEnv(raw, 'POSTGRES_APP_ALLOW_DDL', vars.allow_ddl);
  fs.writeFileSync(ENV_PATH, raw, { mode: 0o600 });
  console.log(
    generated
      ? '.env 已写入新生成的 POSTGRES_APP_PASSWORD（随机 64 位十六进制）。'
      : '.env 中的 POSTGRES_APP_* 已同步。',
  );
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exitCode = 1;
});
