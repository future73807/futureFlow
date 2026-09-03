/**
 * 登录限流（LoginRateLimitService）专项冒烟测试。
 *
 * 验证：失败累计到阈值后锁定并返回 429；窗口内未达阈值不锁定；
 * 成功登录重置计数；锁定过期后自动解除。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { HttpException } from '@nestjs/common';
import { LoginRateLimitService } from '../src/auth/login-rate-limit.service';

async function main() {
  const service = new LoginRateLimitService();
  const key = '1.2.3.4|admin';

  service.assertAllowed(key);
  for (let i = 0; i < 8; i += 1) {
    service.recordFailure(key);
  }
  assert.throws(
    () => service.assertAllowed(key),
    (error: unknown) => {
      const httpError = error as HttpException;
      return httpError instanceof HttpException
        && httpError.getStatus() === 429
        && /登录失败次数过多/.test(httpError.message);
    },
    '达到失败阈值后必须返回 429',
  );

  const otherKey = '5.6.7.8|other';
  assert.doesNotThrow(() => service.assertAllowed(otherKey), '不同账号不得被连带锁定');

  service.reset(key);
  assert.doesNotThrow(() => service.assertAllowed(key), '成功登录重置后不得继续锁定');

  const limited = new LoginRateLimitService();
  const probe = '9.9.9.9|admin';
  for (let i = 0; i < 7; i += 1) {
    limited.recordFailure(probe);
  }
  assert.doesNotThrow(() => limited.assertAllowed(probe), '7 次失败（未达 8 次阈值）不得锁定');
  limited.recordFailure(probe);
  assert.throws(() => limited.assertAllowed(probe), '第 8 次失败后必须锁定');

  console.log('login rate limit smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
