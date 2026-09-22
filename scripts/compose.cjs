#!/usr/bin/env node
/**
 * Docker Compose 转发器：把参数原样交给本机可用的 compose 形式。
 *
 * package.json 里的 `db:up` / `compose:up` 等脚本用它而不是直接写
 * `docker compose`，这样在「有插件」和「只有独立二进制」两种机器上都能跑。
 * 探测逻辑见 scripts/lib/docker-compose.cjs。
 *
 * 用法：
 *   node scripts/compose.cjs up -d postgres
 *   node scripts/compose.cjs logs -f postgres
 *   node scripts/compose.cjs down
 *
 * 退出码与 compose 本身一致；透传 stdio，所以 `logs -f` 这类交互式命令可用。
 */
'use strict';

const { spawn } = require('node:child_process');
const { composeInvocation, describeCompose } = require('./lib/docker-compose.cjs');

const passthrough = process.argv.slice(2);

if (passthrough.length === 0) {
  console.error('用法: node scripts/compose.cjs <compose 参数...>');
  console.error('例如: node scripts/compose.cjs up -d postgres');
  console.error(`本机可用形式: ${describeCompose()}`);
  process.exit(2);
}

const { command, args } = composeInvocation(passthrough);

// 只有真正需要看是哪一份在跑时才输出，避免污染 `logs` 这类本就该干净的输出
if (process.env.FUTUREFLOW_COMPOSE_VERBOSE === '1') {
  console.error(`[compose] 使用 ${describeCompose()}`);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
  // Windows 上 docker-compose 可能是 .cmd/.exe 包装，交给 shell 解析更稳；
  // 参数已全部来自 argv，不存在拼接注入。
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`无法执行 ${command}: ${error.message}`);
  console.error(describeCompose());
  process.exit(127);
});

// 透传退出码：CI 与 `&&` 串联都依赖它
child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
