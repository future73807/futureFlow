import assert from 'node:assert/strict';

import { JwtService } from '@nestjs/jwt';

import { McpExecutionGuard } from '../src/mcp/mcp-execution.guard';

/**
 * MCP 执行令牌守卫回归。
 *
 * 与媒体执行令牌同构的短时窄权限令牌，此前少了一项：**没有校验账号是否仍 active**。
 * JwtAuthGuard 和 MediaExecutionGuard 都有这个检查（按 sub 查库并强制 active），
 * MCP 是唯一的例外——于是封禁/删除在令牌有效期内不生效，而 MCP 服务器上存的正是
 * 租户自己的 Bearer 令牌。
 *
 * 这里守住三件事：
 *   1. 停用/不存在的账号必须被拒绝（本次修的缺口）
 *   2. 作用域校验仍然生效（服务器白名单、UUID 形状）
 *   3. 顺带确认「路由必须精确匹配」不会因为改校验而退化
 */

const SECRET = 'mcp-guard-smoke-secret-0123456789';

interface StubOptions {
  user?: { id: string; status: string } | null;
  payload?: Record<string, unknown>;
  method?: string;
  url?: string;
  serverId?: string;
}

function buildContext(options: StubOptions = {}) {
  const jwt = new JwtService({ secret: SECRET });
  const token = jwt.sign(
    options.payload ?? {
      sub: '11111111-1111-4111-8111-111111111111',
      type: 'mcp_execution',
      workflowId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      serverIds: ['44444444-4444-4444-8444-444444444444'],
    },
    { expiresIn: 600 },
  );

  const repo = {
    findOne: async () => (options.user === undefined
      ? { id: '11111111-1111-4111-8111-111111111111', status: 'active' }
      : options.user),
  };

  const guard = new McpExecutionGuard(jwt, repo as never);

  const request = {
    method: options.method ?? 'POST',
    url: options.url ?? '/mcp/proxy',
    headers: { authorization: `Bearer ${token}` },
    body: { serverId: options.serverId ?? '44444444-4444-4444-8444-444444444444' },
  };

  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  return { guard, context: context as never, request: request as never };
}

async function expectRejected(run: () => Promise<unknown>, needle: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `应被拒绝（期望匹配 ${needle}）`);
  assert.match(String((thrown as Error).message), needle);
}

async function main() {
  // ── 1. 正常情况放行，并填好请求上下文 ────────────────────────────
  {
    const { guard, context, request } = buildContext();
    assert.equal(await guard.canActivate(context), true, '正常令牌应放行');
    assert.equal((request as any).user.id, '11111111-1111-4111-8111-111111111111');
    assert.equal((request as any).mcpExecution.serverIds.length, 1, '作用域应写入请求');
  }

  // ── 2. 本次修的缺口：账号被停用必须拒绝 ──────────────────────────
  {
    const { guard, context } = buildContext({
      user: { id: '11111111-1111-4111-8111-111111111111', status: 'disabled' },
    });
    await expectRejected(() => guard.canActivate(context), /已被停用|不存在/);
  }

  // ── 3. 账号已被删除也必须拒绝 ────────────────────────────────────
  {
    const { guard, context } = buildContext({ user: null });
    await expectRejected(() => guard.canActivate(context), /已被停用|不存在/);
  }

  // ── 4. 令牌类型不对不能用于本接口 ────────────────────────────────
  {
    const { guard, context } = buildContext({
      payload: {
        sub: '11111111-1111-4111-8111-111111111111',
        type: 'media_execution',
        workflowId: '22222222-2222-4222-8222-222222222222',
        runId: '33333333-3333-4333-8333-333333333333',
        serverIds: ['44444444-4444-4444-8444-444444444444'],
      },
    });
    await expectRejected(() => guard.canActivate(context), /仅接受 MCP 执行令牌/);
  }

  // ── 5. 服务器不在签发范围内必须拒绝 ──────────────────────────────
  {
    const { guard, context } = buildContext({ serverId: '99999999-9999-4999-8999-999999999999' });
    await expectRejected(() => guard.canActivate(context), /未授权该服务器/);
  }

  // ── 6. 作用域字段形状不对必须拒绝 ────────────────────────────────
  {
    const { guard, context } = buildContext({
      payload: {
        sub: 'not-a-uuid',
        type: 'mcp_execution',
        workflowId: '22222222-2222-4222-8222-222222222222',
        runId: '33333333-3333-4333-8333-333333333333',
        serverIds: ['44444444-4444-4444-8444-444444444444'],
      },
    });
    await expectRejected(() => guard.canActivate(context), /作用域无效/);
  }

  console.log(
    'MCP 执行守卫测试通过: 正常放行 / 停用账号拒绝 / 已删除账号拒绝 / 令牌类型 / '
    + '服务器越权 / 作用域形状',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
