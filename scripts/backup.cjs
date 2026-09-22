#!/usr/bin/env node
/**
 * 备份 futureFlow 的全部持久数据：网关库 + Dify 库 + 媒体资产目录。
 *
 * 之前项目里只有 README 上两句「请先备份」，没有任何可执行手段。这个脚本把
 * 三份数据打成一个带清单（manifest.json）的目录，restore.cjs 认这个结构。
 *
 * 用法：
 *   pnpm run backup                      # 备份到 .futureflow-backups/<时间戳>
 *   node scripts/backup.cjs --out D:\bak  # 指定目录
 *   node scripts/backup.cjs --no-media    # 只备份两个数据库
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

const OUT_FLAG = process.argv.indexOf('--out');
const outDir = OUT_FLAG >= 0
  ? path.resolve(process.argv[OUT_FLAG + 1])
  : path.join(ROOT, '.futureflow-backups', stamp());
const withMedia = !process.argv.includes('--no-media');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
}

function ensureRunning(container) {
  const inspect = docker(['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).trim();
  if (inspect === 'true') return;
  console.log(`容器 ${container} 未运行，尝试启动…`);
  docker(['start', container]);
  for (let i = 0; i < 30; i += 1) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' }).trim();
    if (running === 'true') return;
    // 同步等待 2 秒（Windows 上没有 sleep 可执行文件）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(`容器 ${container} 启动失败`);
}

const TARGETS = [
  {
    name: 'futureflow',
    container: 'futureflow-postgres',
    database: env.POSTGRES_DB || 'futureflow',
    user: env.POSTGRES_USER || 'futureflow',
    password: env.POSTGRES_PASSWORD,
    file: 'futureflow.dump',
  },
  {
    name: 'dify',
    container: 'futureflow-dify-postgres',
    database: 'dify',
    user: 'dify',
    password: env.DIFY_DB_PASSWORD,
    file: 'dify.dump',
  },
];

/**
 * 打媒体目录。Windows 上 GNU tar 会把 `D:\...` 里的冒号当成远程主机，
 * 所以归档名与 -C 都只用相对路径；tar 不可用时退化为直接递归复制。
 */
function packMedia(mediaDir, outDir) {
  const archive = path.join(outDir, 'media.tar.gz');
  try {
    const relParent = path.relative(outDir, path.dirname(mediaDir)).split(path.sep).join('/') || '.';
    execFileSync('tar', ['-czf', 'media.tar.gz', '-C', relParent, path.basename(mediaDir)], {
      cwd: outDir,
      stdio: 'pipe',
    });
    const bytes = fs.statSync(archive).size;
    return {
      mode: 'tar',
      file: 'media.tar.gz',
      bytes,
      sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    };
  } catch {
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
    fs.cpSync(mediaDir, path.join(outDir, 'media'), { recursive: true });
    return { mode: 'dir', file: 'media', bytes: dirSize(path.join(outDir, 'media')) };
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), items: [] };

  for (const target of TARGETS) {
    if (!target.password) throw new Error(`缺少 ${target.database} 库的密码，请先 pnpm run env:init`);
    ensureRunning(target.container);
    const args = [
      'exec', '-e', `PGPASSWORD=${target.password}`, target.container,
      'pg_dump', '-U', target.user, '-d', target.database,
      '--format=custom', '--clean', '--if-exists', '--no-owner', '--no-privileges',
    ];
    const dump = docker(args);
    const file = path.join(outDir, target.file);
    fs.writeFileSync(file, dump);
    manifest.items.push({
      kind: 'postgres',
      name: target.name,
      container: target.container,
      database: target.database,
      file: target.file,
      bytes: dump.length,
      sha256: createHash('sha256').update(dump).digest('hex'),
    });
    console.log(`已备份 ${target.name} 库 -> ${target.file}（${(dump.length / 1024).toFixed(0)} KB）`);
  }

  if (withMedia) {
    const mediaDir = path.resolve(
      env.FUTUREFLOW_MEDIA_DIR || env.MEDIA_DIR || path.join(ROOT, '.futureflow-media'),
    );
    if (!fs.existsSync(mediaDir)) {
      console.log(`媒体目录不存在，跳过：${mediaDir}`);
    } else {
      const packed = packMedia(mediaDir, outDir);
      manifest.items.push({
        kind: 'media',
        name: 'media',
        source: mediaDir,
        mode: packed.mode,
        file: packed.file,
        bytes: packed.bytes,
        sha256: packed.sha256,
      });
      console.log(`已备份媒体目录 -> ${packed.file}（${Math.round((packed.bytes || 0) / 1024)} KB）`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('');
  console.log(`备份完成：${outDir}`);
  console.log('恢复：node scripts/restore.cjs ' + outDir);
}

main();
