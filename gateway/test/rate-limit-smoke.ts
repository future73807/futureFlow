import assert from 'node:assert/strict';

import { JwtService } from '@nestjs/jwt';

import {
  FixedWindowRateLimiter,
  evaluateFixedWindow,
  resolveRateLimit,
} from '../src/common/fixed-window-rate-limit';
import { LlmProxyController } from '../src/llm/llm-proxy.controller';
import { PythonExecController } from '../src/localtools/python-exec.controller';

/**
 * 共享限流器 + 两个新调用点的回归。
 *
 * 为什么补这个：/llm/chat/completions 每次调用都真实消耗平台级 LLM_API_KEY 的
 * 额度，/python/exec 每次调用都在网关宿主起一个 Python 进程。给 /llm 加票据只
 * 解决了「谁在花」，没解决「花多少」——登录用户依然可以无上限地刷。
 *
 * 限流失效是典型的静默退化：表现是账单变高或宿主机变慢，没有任何报错。
 */

const WINDOW = 60_000;
const TEST_SECRET = 'rate-limit-smoke-secret-0123456789';

function statusOf(error: unknown): number {
  const anyError = error as { getStatus?: () => number; status?: number };
  return typeof anyError.getStatus === 'function' ? anyError.getStatus() : Number(anyError.status);
}

/** 断言抛出 429，且消息里带可操作的重试提示。 */
function expectTooManyRequests(run: () => unknown): number {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '应抛出 429');
  assert.equal(statusOf(thrown), 429, `应为 429，实际 ${statusOf(thrown)}`);
  const message = String((thrown as Error).message);
  assert.match(message, /秒后重试/, '提示里应给出还要等多久，否则用户只能干等');
  assert.match(message, /每分钟上限 \d+ 次/, '提示里应说明上限');
  return message.match(/约 (\d+) 秒/)?.[1] ? Number(message.match(/约 (\d+) 秒/)?.[1]) : 0;
}

/** 异步版：控制器方法是 async，同步 try/catch 抓不到它的拒绝。 */
async function expectTooManyRequestsAsync(run: () => Promise<unknown>): Promise<number> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '应抛出 429');
  assert.equal(statusOf(thrown), 429, `应为 429，实际 ${statusOf(thrown)}`);
  const message = String((thrown as Error).message);
  assert.match(message, /秒后重试/, '提示里应给出还要等多久，否则用户只能干等');
  assert.match(message, /每分钟上限 \d+ 次/, '提示里应说明上限');
  return Number(message.match(/约 (\d+) 秒/)?.[1] ?? 0);
}

async function main() {
  // ── 1. 纯函数：窗口内计数与放行 ──────────────────────────────────
  {
    const first = evaluateFixedWindow(undefined, 1000, 3, WINDOW);
    assert.equal(first.allowed, true, '首次应放行');
    assert.equal(first.count, 1);

    const second = evaluateFixedWindow(first.bucket, 2000, 3, WINDOW);
    assert.equal(second.allowed, true, '第 2 次应放行');
    assert.equal(second.count, 2);
    // 未跨窗口时 windowStart 必须保持不变，否则窗口会被无限续期
    assert.equal(second.bucket.windowStart, first.bucket.windowStart, '窗口起点不应被刷新');

    const third = evaluateFixedWindow(second.bucket, 3000, 3, WINDOW);
    assert.equal(third.allowed, true, '达到上限那一次仍应放行');

    const fourth = evaluateFixedWindow(third.bucket, 4000, 3, WINDOW);
    assert.equal(fourth.allowed, false, '超过上限应拒绝');
    assert.equal(fourth.count, 4, '超限请求也应计数，防止retry风暴');
  }

  // ── 2. 纯函数：retryAfter 随时间递减 ─────────────────────────────
  {
    const start = evaluateFixedWindow(undefined, 0, 1, WINDOW);
    const denied = evaluateFixedWindow(start.bucket, 10_000, 1, WINDOW);
    assert.equal(denied.allowed, false);
    const later = evaluateFixedWindow(start.bucket, 50_000, 1, WINDOW);
    assert.ok(
      later.retryAfterSeconds < denied.retryAfterSeconds,
      `等待提示应随时间递减：${denied.retryAfterSeconds} → ${later.retryAfterSeconds}`,
    );
    assert.ok(later.retryAfterSeconds >= 1, '至少提示 1 秒，不要给 0');
  }

  // ── 3. 纯函数：窗口过期后整桶重置 ────────────────────────────────
  {
    const start = evaluateFixedWindow(undefined, 0, 2, WINDOW);
    const second = evaluateFixedWindow(start.bucket, 1000, 2, WINDOW);
    assert.equal(second.bucket.count, 2);

    const afterWindow = evaluateFixedWindow(second.bucket, WINDOW + 1, 2, WINDOW);
    assert.equal(afterWindow.allowed, true, '跨窗口后应重新计数');
    assert.equal(afterWindow.count, 1);
    assert.equal(afterWindow.bucket.windowStart, WINDOW + 1, '新窗口应重新计时');
  }

  // ── 4. 配置解析：非法值回落默认 ──────────────────────────────────
  {
    assert.equal(resolveRateLimit(null, 30), 30, '未配置应回落默认');
    for (const raw of ['', '  ', 'abc', '0', '-1']) {
      assert.equal(resolveRateLimit(raw, 30), 30, `${JSON.stringify(raw)} 应回落默认`);
    }
    assert.equal(resolveRateLimit('5', 30), 5, '合法值应生效');
    assert.equal(resolveRateLimit('7.9', 30), 7, '小数应向下取整');
    assert.equal(resolveRateLimit('99999999', 30), 10_000, '过大值应压到上限');
  }

  // ── 5. 限流器：按 key 隔离 ───────────────────────────────────────
  {
    const limiter = new FixedWindowRateLimiter({ limit: 1 });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('b').allowed, true, '不同 key 互不影响');
    assert.equal(limiter.consume('a').allowed, false, '同一 key 第二次应被拒');
  }

  // ── 6. 限流器：assertAllowed 抛 429 且带重试提示 ──────────────────
  {
    const limiter = new FixedWindowRateLimiter({ limit: 1 });
    limiter.assertAllowed('u1', 'Python 执行');
    const seconds = expectTooManyRequests(() => limiter.assertAllowed('u1', 'Python 执行'));
    assert.ok(seconds > 0 && seconds <= 60, `重试提示应在 1~60 秒内，实际 ${seconds}`);
  }

  // ── 7. 限流器：过期桶会被回收，Map 不无限增长 ─────────────────────
  {
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 1000 });
    limiter.consume('old', 0);
    assert.equal(limiter.trackedKeys, 1);
    // 推进两个窗口以上，触发 sweep
    limiter.consume('new', 5000);
    assert.equal(limiter.trackedKeys, 1, '过期桶应被清理，否则长时间运行会内存泄漏');
  }

  // ── 8. 端点：/llm 超限返回 429（不消耗上游额度）──────────────────
  {
    const jwt = new JwtService({ secret: TEST_SECRET });
    const controller = new LlmProxyController(
      {
        get: (key: string, fallback?: string) => {
          if (key === 'LLM_API_HOST') return 'http://127.0.0.1:9/invalid';
          if (key === 'LLM_API_KEY') return 'sk-smoke';
          if (key === 'LLM_PROXY_MAX_PER_MINUTE') return '1';
          return fallback;
        },
      } as never,
      jwt,
    );
    const ticket = jwt.sign({ sub: 'u1', type: 'llm_proxy' }, { expiresIn: 600 });
    const res = {
      status() { return this; },
      setHeader() { return this; },
      send() { return this; },
      json() { return this; },
    } as never;
    const call = () => controller.chatCompletions(
      {},
      { headers: { authorization: `Bearer ${ticket}` } },
      res,
    );

    // 第一次：放行，走到上游（故意不可达 → 502）
    await call();
    // 第二次：应被限流，且不会再打到上游
    const seconds = await expectTooManyRequestsAsync(call);
    assert.ok(seconds > 0, '应给出重试等待时间');
  }

  // ── 9. 端点：/python/exec 超限返回 429 ───────────────────────────
  // 用空代码让第一次调用在限流之后、真正起 Python 之前就失败，
  // 这样不必依赖本机是否有 Python。
  {
    const controller = new PythonExecController({
      get: (key: string, fallback?: string) => {
        if (key === 'PYTHON_EXEC_MAX_PER_MINUTE') return '1';
        if (key === 'GATEWAY_HOST') return '127.0.0.1';
        return fallback;
      },
    } as never);

    let firstThrew = false;
    try {
      await controller.exec({ user: { id: 'u1' } }, { code: '' });
    } catch (error) {
      firstThrew = true;
      assert.match(String((error as Error).message), /代码不能为空/, '第一次应因空代码被拒');
    }
    assert.ok(firstThrew, '第一次调用应消耗掉配额');

    await expectTooManyRequestsAsync(() => controller.exec({ user: { id: 'u1' } }, { code: 'x' }));
    // 另一个用户不受影响
    let otherThrew = false;
    try {
      await controller.exec({ user: { id: 'u2' } }, { code: '' });
    } catch {
      otherThrew = true;
    }
    assert.ok(otherThrew, '其它用户不应被同一个桶挡住');
  }

  console.log(
    '限流测试通过: 窗口计数 / retryAfter 递减 / 跨窗口重置 / 配置回落 / key 隔离 / '
    + '429 提示 / 过期桶回收 / LLM 超限 / Python 超限',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
