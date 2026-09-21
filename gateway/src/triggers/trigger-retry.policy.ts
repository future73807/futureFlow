/**
 * 定时触发器的重试与失败升级策略（纯函数，便于单测）。
 *
 * 背景：调度器原先在单次执行失败后只记录 `failureCount` 就结束——而 `failureCount`
 * 在整个代码库里没有任何读取方。于是一次偶发失败（模型 5xx、Dify 容器重启、网络抖动）
 * 会让这次调度**直接丢失**，直到下一个周期；持续失败也不会被任何人注意到，触发器会
 * 按周期静默失败到永远。这里把「重试几次、隔多久重试、连续失败到多少次要升级告警」
 * 抽成可测的纯逻辑，调度器只负责调用。
 */

/** 触发一次执行允许的最大尝试次数（含首次），上限用于挡住明显不合理的配置。 */
export const MAX_ALLOWED_ATTEMPTS = 10;

/** 单次退避延迟的上限，避免配置失误导致调度器长时间挂住。 */
export const MAX_DELAY_MS = 60_000;

/** 自动暂停阈值的默认值；配置成 0 表示「永不自动暂停」。 */
export const DEFAULT_AUTO_PAUSE_FAILURES = 20;

/**
 * 解析「连续失败多少次后自动暂停」（纯函数）。
 *
 * 0 表示关闭（有的部署就是要一直重试到修好为止）。非法值回落默认：这是保护性
 * 配置，写错了按默认值继续跑，比让调度器起不来更合适。
 */
export function resolveAutoPauseFailures(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_AUTO_PAUSE_FAILURES;
  return parsed;
}

export interface RetryPolicy {
  /** 含首次在内的总尝试次数（>= 1）。 */
  maxAttempts: number;
  /** 首次重试的等待时长，后续按指数增长。 */
  baseDelayMs: number;
  /** 连续失败达到该次数时升级为 error 级日志，提示需要人工介入。 */
  alertThreshold: number;
}

export interface RetryPolicySource {
  WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS?: string | number | null;
  WORKFLOW_TRIGGER_RETRY_BASE_MS?: string | number | null;
  WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD?: string | number | null;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 从配置解析重试策略。
 *
 * 默认 maxAttempts=2（首次 + 1 次重试）：绝大多数偶发失败是短时抖动，重试一次即可
 * 覆盖；把默认值压得较低是为了不让「注定失败」的触发器把调度槽位长期占住
 * （调度器有单飞保护，一次 tick 内串行等待重试会推迟后续周期）。
 */
export function resolveRetryPolicy(source: RetryPolicySource): RetryPolicy {
  return {
    maxAttempts: Math.min(
      positiveInt(source.WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS, 2),
      MAX_ALLOWED_ATTEMPTS,
    ),
    baseDelayMs: positiveInt(source.WORKFLOW_TRIGGER_RETRY_BASE_MS, 2_000),
    alertThreshold: positiveInt(source.WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD, 3),
  };
}

/**
 * 第 `attempt` 次失败后应等待的毫秒数（attempt 从 1 开始）。
 * 指数退避：base * 2^(attempt-1)，并封顶在 {@link MAX_DELAY_MS}。
 */
export function retryDelayMs(attempt: number, baseDelayMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBase = Math.max(1, Math.floor(baseDelayMs));
  const raw = safeBase * 2 ** (safeAttempt - 1);
  return Math.min(raw, MAX_DELAY_MS);
}

export interface RetryDecisionInput {
  /** 已完成的尝试次数。 */
  attempt: number;
  policy: RetryPolicy;
  /** 该失败是否值得重试（例如触发器已被删除/暂停就不值得）。 */
  retryable: boolean;
  /** 服务是否已进入销毁流程（销毁后不再重试，避免悬挂定时器）。 */
  stopping: boolean;
}

/** 是否还应该再试一次。 */
export function shouldRetry(input: RetryDecisionInput): boolean {
  return input.retryable
    && !input.stopping
    && input.attempt < input.policy.maxAttempts;
}

/**
 * 连续失败达到阈值时给出升级告警文案；未达阈值返回 null。
 *
 * 之所以要单独一条 error 级日志：`failureCount` 虽已入库并在接口返回，但没有任何
 * 主动推送，运维不看日志就不会知道某个定时任务已经连续失败了几十次。
 */
export function describeConsecutiveFailure(
  failureCount: number,
  triggerName: string,
  policy: RetryPolicy,
): string | null {
  if (!Number.isFinite(failureCount) || failureCount < policy.alertThreshold) return null;
  return `定时触发连续失败 ${failureCount} 次，需要人工检查: trigger=${triggerName}`;
}
