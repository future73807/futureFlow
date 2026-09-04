import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface FailureWindow {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

interface AttemptWindow {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const BLOCK_MS = 15 * 60_000;

const REGISTER_WINDOW_MS = 60 * 60_000;
const MAX_REGISTER_ATTEMPTS = 20;
const REGISTER_BLOCK_MS = 60 * 60_000;

/**
 * 登录暴力破解防护：按「来源 IP + 账号」组合限流。
 * 15 分钟窗口内累计 8 次失败后锁定 15 分钟；成功登录立即清零。
 * 单实例内存实现，与本平台的单机部署模型一致。
 */
@Injectable()
export class LoginRateLimitService {
  private readonly failures = new Map<string, FailureWindow>();
  private readonly registerAttempts = new Map<string, AttemptWindow>();
  private lastSweepAt = 0;

  /** 注册防刷：同一来源 1 小时窗口内每次注册尝试都计数，上限 20 次。 */
  assertRegisterAllowed(key: string): void {
    this.sweepIfDue();
    const window = this.registerAttempts.get(key);
    if (!window) return;
    if (window.blockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.blockedUntil - Date.now()) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `注册尝试过于频繁，请约 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`,
          error: 'Too Many Requests',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordRegisterAttempt(key: string): void {
    this.sweepIfDue();
    const now = Date.now();
    const window = this.registerAttempts.get(key);
    if (!window || now - window.firstAt > REGISTER_WINDOW_MS) {
      this.registerAttempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
      return;
    }
    window.count += 1;
    if (window.count >= MAX_REGISTER_ATTEMPTS) {
      window.blockedUntil = now + REGISTER_BLOCK_MS;
    }
  }

  assertAllowed(key: string): void {
    this.sweepIfDue();
    const window = this.failures.get(key);
    if (!window) return;
    if (window.blockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.blockedUntil - Date.now()) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `登录失败次数过多，请约 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`,
          error: 'Too Many Requests',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(key: string): void {
    this.sweepIfDue();
    const now = Date.now();
    const window = this.failures.get(key);
    if (!window || now - window.firstAt > WINDOW_MS) {
      this.failures.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
      return;
    }
    window.count += 1;
    if (window.count >= MAX_FAILURES) {
      window.blockedUntil = now + BLOCK_MS;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, window] of this.failures) {
      if (now - window.firstAt > WINDOW_MS && window.blockedUntil <= now) {
        this.failures.delete(key);
      }
    }
    for (const [key, window] of this.registerAttempts) {
      if (now - window.firstAt > REGISTER_WINDOW_MS && window.blockedUntil <= now) {
        this.registerAttempts.delete(key);
      }
    }
  }
}
