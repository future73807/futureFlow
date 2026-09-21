import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 固定窗口限流（共享实现）。
 *
 * 仓库里此前已有两份各自写的固定窗口限流（webhook 调用、登录/注册失败），逻辑
 * 重复且细节不一。这里抽出公共件给新调用点用，避免第三次复制：
 *   - /llm/chat/completions —— 每次调用都真实消耗平台的 LLM 额度
 *   - /python/exec         —— 每次调用都在网关宿主起一个 Python 进程
 *
 * 单实例内存实现，与平台当前的单机部署模型一致（见 WebhookRateLimitService）。
 * 多实例部署时它是「每实例」限流，不构成全局配额——这一点在消息里不假装是全局的。
 */

export interface FixedWindowBucket {
  count: number;
  windowStart: number;
}

export interface FixedWindowDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
  /** 更新后的桶状态，调用方负责存回。 */
  bucket: FixedWindowBucket;
}

/**
 * 判断一次调用是否放行（纯函数：不读时钟、不碰外部状态）。
 *
 * 窗口到期后整桶重置，而不是滑动窗口——与既有两份实现保持一致，语义也更好解释
 * 给用户（「每分钟 N 次」）。
 */
export function evaluateFixedWindow(
  bucket: FixedWindowBucket | undefined,
  nowMs: number,
  limit: number,
  windowMs: number,
): FixedWindowDecision {
  const expired = !bucket || nowMs - bucket.windowStart >= windowMs;
  const next: FixedWindowBucket = expired
    ? { count: 1, windowStart: nowMs }
    : { count: bucket.count + 1, windowStart: bucket.windowStart };

  const allowed = next.count <= limit;
  const remainingMs = Math.max(0, next.windowStart + windowMs - nowMs);
  return {
    allowed,
    count: next.count,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(remainingMs / 1000)),
    bucket: next,
  };
}

/**
 * 解析「每分钟上限」这类配置（纯函数）。
 *
 * 非法值回落默认而不是抛错：限流是保护性配置，写错了应当按保守默认值继续跑，
 * 而不是让整个功能起不来。
 */
export function resolveRateLimit(raw: string | null | undefined, fallback: number): number {
  const parsed = Number((raw ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 10_000);
}

export interface FixedWindowLimiterOptions {
  limit: number;
  windowMs?: number;
  /** 清理过期桶的间隔，默认与窗口等长。 */
  sweepIntervalMs?: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private readonly windowMs: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;

  constructor(private readonly options: FixedWindowLimiterOptions) {
    this.windowMs = options.windowMs ?? 60_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? this.windowMs;
  }

  get limit(): number {
    return this.options.limit;
  }

  /** 记录一次调用并返回判定结果（不抛错，是否拒绝由调用方决定）。 */
  consume(key: string, nowMs: number = Date.now()): FixedWindowDecision {
    this.sweepIfDue(nowMs);
    const decision = evaluateFixedWindow(
      this.buckets.get(key),
      nowMs,
      this.options.limit,
      this.windowMs,
    );
    this.buckets.set(key, decision.bucket);
    return decision;
  }

  /** 超限直接抛 429。消息里带上「约 N 秒后重试」，否则用户只能干等。 */
  assertAllowed(key: string, describe: string, nowMs: number = Date.now()): void {
    const decision = this.consume(key, nowMs);
    if (decision.allowed) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message:
          `${describe}过于频繁（每分钟上限 ${this.options.limit} 次），`
          + `请约 ${decision.retryAfterSeconds} 秒后重试`,
        error: 'Too Many Requests',
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** 测试用：当前跟踪的键数量（验证过期桶被回收）。 */
  get trackedKeys(): number {
    return this.buckets.size;
  }

  private sweepIfDue(nowMs: number): void {
    if (nowMs - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = nowMs;
    // 多留一个窗口的宽限：正在窗口内被拒绝的请求还要读 retryAfter
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.windowStart >= this.windowMs * 2) this.buckets.delete(key);
    }
  }
}
