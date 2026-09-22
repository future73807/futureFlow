#!/usr/bin/env node
/**
 * 从 backup.cjs 产出的目录恢复数据。
 *
 * ⚠️ 这是**破坏性操作**：两个库会被 `--clean --if-exists` 清掉后重建，
 * 媒体目录会被覆盖。默认要求交互确认；非交互场景加 `--yes`。
 *
 * 用法：
 *   node scripts/restore.cjs .futureflow-backups/20260922-120000
 *   node scripts/restore.cjs <dir> --yes            # 跳过确认
 *   node scripts/restore.cjs <dir> --db-only        # 只恢复数据库
 *   node scripts/restore.cjs <dir> --media-only     # 只恢复媒体资产
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

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

const env = Object.assign(
  parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')),
  process.env,
);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const backupDir = args[0] ? path.resolve(args[0]) : '';

if (!backupDir || !fs.existsSync(backupDir)) {
  console.error('用法: node scripts/restore.cjs <备份目录> [--yes] [--db-only] [--media-only]');
  process.exit(1);
}

const manifestPath = path.join(backupDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`不是有效的备份目录（缺少 manifest.json）：${backupDir}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const dbTargets = manifest.items.filter((i) => i.kind === 'postgres' && !flags.has('--media-only'));
const mediaTarget = manifest.items.find((i) => i.kind === 'media' && !flags.has('--db-only'));

function docker(args_, options = {}) {
  return execFileSync('docker', args_, { maxBuffer: 1024 * 1024 * 1024, ...options });
}

function ensureRunning(container) {
  const running = docker(['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).trim();
  if (running === 'true') return;
  docker(['start', container]);
  for (let i = 0; i < 30; i += 1) {
    const r = docker(['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).trim();
    if (r === 'true') return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(`容器 ${container} 启动失败`);
}

function verify(file, expectedSha) {
  if (!expectedSha) return;
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== expectedSha) {
    throw new Error(`校验失败：${path.basename(file)} 的 sha256 与清单不一致，拒绝恢复`);
  }
  console.log(`  校验通过：${path.basename(file)}`);
}

async function confirm(question) {
  if (flags.has('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return String(answer).trim().toLowerCase() === 'y';
}

async function main() {
  console.log('⚠️ 此操作非常危险，可能导致不可逆的数据丢失！');
  console.log(`备份目录：${backupDir}（生成于 ${manifest.createdAt}）`);
  for (const item of dbTargets) {
    console.log(`  - 将清空并重建数据库 ${item.database}（容器 ${item.container}）`);
  }
  if (mediaTarget) {
    console.log(`  - 将覆盖媒体目录：${mediaTarget.source}`);
  }
  console.log('');

  if (!(await confirm('确认继续？'))) {
    console.log('已取消。');
    return;
  }

  for (const item of dbTargets) {
    const file = path.join(backupDir, item.file);
    if (!fs.existsSync(file)) throw new Error(`备份文件缺失：${file}`);
    console.log(`恢复 ${item.database} 库…`);
    verify(file, item.sha256);

    const password = item.name === 'dify' ? env.DIFY_DB_PASSWORD : env.POSTGRES_PASSWORD;
    const user = item.name === 'dify' ? 'dify' : env.POSTGRES_USER || 'futureflow';
    if (!password) throw new Error(`缺少 ${item.database} 库的密码`);
    ensureRunning(item.container);

    const dump = fs.readFileSync(file);
    execFileSync(
      'docker',
      [
        'exec', '-i', '-e', `PGPASSWORD=${password}`, item.container,
        'pg_restore', '-U', user, '-d', item.database,
        '--clean', '--if-exists', '--no-owner', '--no-privileges',
      ],
      { input: dump, maxBuffer: 1024 * 1024 * 1024 },
    );
    console.log(`  ${item.database} 库恢复完成。`);
  }

  if (mediaTarget) {
    const source = path.join(backupDir, mediaTarget.file);
    if (!fs.existsSync(source)) throw new Error(`备份文件缺失：${source}`);
    console.log('恢复媒体目录…');
    const target = path.resolve(env.FUTUREFLOW_MEDIA_DIR || mediaTarget.source);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (mediaTarget.mode === 'dir') {
      fs.cpSync(source, target, { recursive: true });
    } else {
      verify(source, mediaTarget.sha256);
      // 同样只用相对路径：Windows 的 tar 见到 `D:\...` 会当成远程主机
      const relArchive = path.relative(path.dirname(target), source).split(path.sep).join('/');
      execFileSync('tar', ['-xzf', relArchive], { cwd: path.dirname(target), stdio: 'pipe' });
    }
    console.log(`  媒体目录恢复完成：${target}`);
  }

  console.log('');
  console.log('恢复完成。建议重启网关：pnpm run start:gateway:prod');
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exitCode = 1;
});
