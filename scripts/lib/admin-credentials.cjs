#!/usr/bin/env node
/**
 * 测试/运维脚本共用的管理员凭据解析。
 *
 * 为什么需要它：此前各脚本各自硬编码同一个管理员默认密码，而这个默认值同时
 * 写在 README 和 .env.example 里（公开值）。要让默认密码可轮换，就必须让所有
 * 脚本从同一处取密码——否则改一处、挂一片。
 *
 * 取值优先级：
 *   1. 环境变量 ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD（CI 与非本机部署）
 *   2. 仓库根目录 .env 的 GATEWAY_BOOTSTRAP_ADMIN_*（本机一键启动生成的真实值）
 *   3. 用户名/邮箱回退到众所周知的非机密默认值；**密码没有回退值**——
 *      取不到就直接报错，绝不退回任何固定密码。
 *
 * 用法：
 *   const { adminPassword } = require('./lib/admin-credentials.cjs');
 *   const PW = process.argv[2] || adminPassword();
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** 解析 KEY=VALUE 文本；带引号的值会去掉外层引号，# 开头整行忽略。 */
function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return result;
}

let cachedEnv = null;
function envFile() {
  if (cachedEnv) return cachedEnv;
  const candidates = [
    process.env.FUTUREFLOW_ENV_FILE,
    path.join(ROOT, '.env'),
    path.join(ROOT, '.futureflow.runtime.env'),
  ].filter(Boolean);
  cachedEnv = {};
  for (const file of candidates) {
    try {
      Object.assign(cachedEnv, parseEnv(fs.readFileSync(file, 'utf8')));
    } catch {
      // 文件不存在或不可读：按「没有配置」处理，交给下面的显式报错
    }
  }
  return cachedEnv;
}

/** 登录用户名（登录接口同时接受用户名与邮箱）。 */
function adminUsername() {
  return (
    process.env.ADMIN_USERNAME ||
    envFile().GATEWAY_BOOTSTRAP_ADMIN_USERNAME ||
    'admin'
  );
}

/** 管理员邮箱。 */
function adminEmail() {
  return (
    process.env.ADMIN_EMAIL ||
    envFile().GATEWAY_BOOTSTRAP_ADMIN_EMAIL ||
    'admin@futureflow.local'
  );
}

/**
 * 管理员密码。取不到就抛错——历史上正是因为「取不到就用固定默认值」，
 * 才让一个公开字符串变成了真实的线上管理员密码。
 */
function adminPassword() {
  const value = process.env.ADMIN_PASSWORD || envFile().GATEWAY_BOOTSTRAP_ADMIN_PASSWORD;
  if (!value) {
    throw new Error(
      '未找到管理员密码：请先执行 `pnpm run env:init` 生成 .env，或设置环境变量 ADMIN_PASSWORD。',
    );
  }
  return value;
}

/** 一次性拿到三项，避免每个脚本重复调用。 */
function adminCredentials() {
  return { username: adminUsername(), email: adminEmail(), password: adminPassword() };
}

module.exports = { adminUsername, adminEmail, adminPassword, adminCredentials };
