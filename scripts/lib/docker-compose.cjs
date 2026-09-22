#!/usr/bin/env node
/**
 * 解析本机可用的 Docker Compose 调用方式。
 *
 * 两种形式的**参数完全一致**，只是调用前缀不同：
 *   - `docker compose ...`    v2 插件（Docker Desktop 默认自带，现代标准）
 *   - `docker-compose ...`    独立二进制（插件未安装时仍有）
 *
 * 为什么必须探测而不是写死：写死 `docker compose` 时，插件缺失的机器上整条启动
 * 链路直接失败，而报错是 `docker: unknown command: docker compose` —— 看起来像
 * 「命令敲错了」，实际是环境缺插件，排查方向会被彻底带偏（本机实测就是这个坑：
 * `docker info` 的插件列表里只有 dhi，没有 compose）。
 *
 * 反过来写死 `docker-compose` 也不对：新版 Docker Desktop 不再往 PATH 放独立
 * 二进制，只提供插件形式。
 *
 * 用法：
 *   const { composeInvocation } = require('./lib/docker-compose.cjs');
 *   const { command, args } = composeInvocation(['up', '-d']);
 *   spawn(command, args);
 */
'use strict';

const { spawnSync } = require('node:child_process');

/** 候选调用形式，按优先级排列。 */
const CANDIDATES = [
  { command: 'docker', baseArgs: ['compose'], label: 'docker compose' },
  { command: 'docker-compose', baseArgs: [], label: 'docker-compose' },
];

let cached = null;

function probe(candidate) {
  const result = spawnSync(candidate.command, [...candidate.baseArgs, 'version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error || result.status !== 0) return null;
  // 取第一行非空输出作为版本描述，便于日志里说明实际用的是哪一个
  const version = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '(版本未知)';
  return { ...candidate, version };
}

/**
 * 探测并缓存本机可用的 compose 形式。
 * @returns {{available: boolean, command: string, baseArgs: string[], label: string, version?: string}}
 */
function detectCompose() {
  if (cached) return cached;
  for (const candidate of CANDIDATES) {
    const found = probe(candidate);
    if (found) {
      cached = { available: true, ...found };
      return cached;
    }
  }
  // 两种都没有：仍返回第一个候选，让调用方在真正执行时抛出可读的错误
  cached = {
    available: false,
    ...CANDIDATES[0],
    version: undefined,
    hint: '本机既没有 `docker compose` 插件，也没有 `docker-compose` 独立二进制。'
      + '请安装 Docker Desktop（自带 compose 插件）或单独安装 docker-compose。',
  };
  return cached;
}

/**
 * 拼出可直接交给 spawn 的命令与参数。
 * @param {string[]} args 传给 compose 的参数，如 ['up', '-d']
 * @returns {{command: string, args: string[]}}
 */
function composeInvocation(args = []) {
  const detected = detectCompose();
  return { command: detected.command, args: [...detected.baseArgs, ...args] };
}

/** 单行描述，便于写进日志或报错信息。 */
function describeCompose() {
  const detected = detectCompose();
  return detected.available
    ? `${detected.label}（${detected.version}）`
    : detected.hint;
}

module.exports = { detectCompose, composeInvocation, describeCompose };
