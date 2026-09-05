import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const WINDOW_MS = 60_000;
const MAX_INVOCATIONS_PER_WINDOW = 60;

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Webhook 触发限流：每个触发器每分钟最多 60 次调用。
 * webhook 是无需认证的公网入口，地址持有者即为授权；限流兜底
 * 防止泄漏地址被脚本无限刷调用消耗计费额度。
 * 单实例内存实现，与平台单机部署模型一致。
 */
@Injectable()
export class WebhookRateLimitService {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt = 0;

  assertAllowed(triggerId: string): void {
    this.sweepIfDue();
    const now = Date.now();
    const bucket = this.buckets.get(triggerId);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      this.buckets.set(triggerId, { count: 1, windowStart: now });
      return;
    }
    bucket.count += 1;
    if (bucket.count > MAX_INVOCATIONS_PER_WINDOW) {
      const retryAfterSeconds = Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Webhook 触发过于频繁（每分钟上限 ${MAX_INVOCATIONS_PER_WINDOW} 次），请约 ${retryAfterSeconds} 秒后重试`,
          error: 'Too Many Requests',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= WINDOW_MS * 2) this.buckets.delete(key);
    }
  }
}
