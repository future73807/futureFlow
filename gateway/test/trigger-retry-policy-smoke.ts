import assert from 'node:assert/strict';

import {
  MAX_ALLOWED_ATTEMPTS,
  MAX_DELAY_MS,
  describeConsecutiveFailure,
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetry,
} from '../src/triggers/trigger-retry.policy';

/**
 * 定时触发重试策略回归。
 *
 * 背景：调度器原先在失败后只写 `failureCount` 就结束，而这个字段在整个代码库里
 * 没有任何读取方——偶发失败会让这次调度直接丢失，持续失败也不会被发现。这里守住
 * 新引入的策略：默认值、边界钳制、退避上限、以及「不可重试/正在停止」时不再重试。
 */
function main() {
  // ── 默认值 ──────────────────────────────────────────────────────
  const defaults = resolveRetryPolicy({});
  assert.equal(defaults.maxAttempts, 2, '默认应为首次 + 1 次重试');
  assert.equal(defaults.baseDelayMs, 2000);
  assert.equal(defaults.alertThreshold, 3);

  // ── 显式配置生效 ────────────────────────────────────────────────
  const custom = resolveRetryPolicy({
    WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '4',
    WORKFLOW_TRIGGER_RETRY_BASE_MS: '500',
    WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD: '5',
  });
  assert.deepEqual(custom, { maxAttempts: 4, baseDelayMs: 500, alertThreshold: 5 });

  // ── 非法值回落默认，而不是抛错或变成 0（0 会让任何失败都不重试）──
  const invalid = resolveRetryPolicy({
    WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '0',
    WORKFLOW_TRIGGER_RETRY_BASE_MS: '-5',
    WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD: 'abc',
  });
  assert.equal(invalid.maxAttempts, 2, '0/负数/非数字应回落默认值');
  assert.equal(invalid.baseDelayMs, 2000);
  assert.equal(invalid.alertThreshold, 3);

  // ── 尝试次数上限钳制 ────────────────────────────────────────────
  assert.equal(
    resolveRetryPolicy({ WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '999' }).maxAttempts,
    MAX_ALLOWED_ATTEMPTS,
    '超大配置应被钳制，避免调度槽位被长期占住',
  );

  // ── 指数退避与封顶 ──────────────────────────────────────────────
  assert.equal(retryDelayMs(1, 2000), 2000);
  assert.equal(retryDelayMs(2, 2000), 4000);
  assert.equal(retryDelayMs(3, 2000), 8000);
  assert.equal(retryDelayMs(99, 2000), MAX_DELAY_MS, '退避必须封顶，否则会挂住调度器');
  assert.equal(retryDelayMs(0, 2000), 2000, 'attempt 小于 1 时按 1 处理');
  assert.equal(retryDelayMs(1, 0), 1, 'baseDelayMs 为 0 时至少等 1ms');

  // ── 是否继续重试 ────────────────────────────────────────────────
  const policy = { maxAttempts: 3, baseDelayMs: 2000, alertThreshold: 3 };
  assert.equal(shouldRetry({ attempt: 1, policy, retryable: true, stopping: false }), true);
  assert.equal(shouldRetry({ attempt: 2, policy, retryable: true, stopping: false }), true);
  assert.equal(
    shouldRetry({ attempt: 3, policy, retryable: true, stopping: false }),
    false,
    '已达最大尝试次数',
  );
  assert.equal(
    shouldRetry({ attempt: 1, policy, retryable: false, stopping: false }),
    false,
    '触发器已删除/暂停等不可重试情况',
  );
  assert.equal(
    shouldRetry({ attempt: 1, policy, retryable: true, stopping: true }),
    false,
    '服务正在停止时不应再等待重试',
  );

  // ── 连续失败升级告警 ────────────────────────────────────────────
  assert.equal(describeConsecutiveFailure(2, '日报任务', policy), null, '未达阈值不告警');
  assert.match(
    describeConsecutiveFailure(3, '日报任务', policy) ?? '',
    /连续失败 3 次.*日报任务/,
    '达到阈值应给出含触发器名的告警文案',
  );
  assert.match(
    describeConsecutiveFailure(17, '日报任务', policy) ?? '',
    /连续失败 17 次/,
  );
  assert.equal(
    describeConsecutiveFailure(Number.NaN, '日报任务', policy),
    null,
    '非法计数不应误报',
  );

  console.log('trigger retry policy tests passed: 默认值 / 非法回落 / 上限钳制 / 指数退避封顶 / 重试判定 / 失败升级');
}

main();
