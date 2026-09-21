import assert from 'node:assert/strict';

import { JwtService } from '@nestjs/jwt';

import { LlmProxyController } from '../src/llm/llm-proxy.controller';
import {
  DEFAULT_LLM_TICKET_TTL_SECONDS,
  LLM_PROXY_TOKEN_TYPE,
  clampLlmCostFields,
  classifyLlmProxyToken,
  resolveLlmTicketTtlSeconds,
} from '../src/llm/llm-proxy-ticket';

/**
 * LLM 直连代理的票据机制回归。
 *
 * 要守的是一件事：**这个端点以前谁都能用**。它没有 guard，全项目也没有全局
 * 守卫，于是任何能连到网关端口的人都能消耗平台级 LLM_API_KEY。现在改成必须
 * 持票，而票据只发给登录用户、且只能用于这一个接口。
 *
 * 这类改动是静默退化的重灾区：漏一次校验的表现是「功能正常、额度在烧」，
 * 不会有任何报错。
 */

const TEST_SECRET = 'llm-proxy-ticket-smoke-secret-0123456789';

function makeJwt(): JwtService {
  return new JwtService({ secret: TEST_SECRET });
}

/** 断言异步调用抛出了含指定文字的错误。 */
async function expectReject(run: () => Promise<unknown>, needle: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `应拒绝调用（期望匹配 ${needle}）`);
  assert.match(String((thrown as Error).message), needle);
}

async function main() {
  // ── 1. 有效期解析：非法值回落默认，不做报错 ────────────────────────
  {
    assert.equal(
      resolveLlmTicketTtlSeconds(null),
      DEFAULT_LLM_TICKET_TTL_SECONDS,
      '未配置时应回落默认值',
    );
    for (const raw of ['', '   ', 'abc', '0', '-5', 'NaN']) {
      assert.equal(
        resolveLlmTicketTtlSeconds(raw),
        DEFAULT_LLM_TICKET_TTL_SECONDS,
        `非法值 ${JSON.stringify(raw)} 应回落默认值（这是可用性配置，不该让试运行起不来）`,
      );
    }
    assert.equal(resolveLlmTicketTtlSeconds('120'), 120, '合法值应生效');
    assert.equal(resolveLlmTicketTtlSeconds(' 300 '), 300, '应容忍空白');
  }

  // ── 2. 有效期上下限：挡住两端极端值 ────────────────────────────────
  {
    assert.equal(resolveLlmTicketTtlSeconds('1'), 60, '过短应被抬到下限');
    assert.equal(resolveLlmTicketTtlSeconds('99999999'), 3600, '过长应被压到上限');
  }

  // ── 3. 用途判定：专用票据与普通登录令牌都可调用 ─────────────────────
  {
    assert.equal(
      classifyLlmProxyToken({ sub: 'u1', type: LLM_PROXY_TOKEN_TYPE }).ok,
      true,
      '本端点签发的票据应被接受',
    );
    assert.equal(
      classifyLlmProxyToken({ sub: 'u1' }).ok,
      true,
      '普通登录令牌权限更强，也应被接受',
    );
  }

  // ── 4. 用途判定：其它专用令牌不能混用 ──────────────────────────────
  {
    const decision = classifyLlmProxyToken({ sub: 'u1', type: 'media_execution' });
    assert.equal(decision.ok, false, '媒体执行令牌不应能调用 LLM 代理');
    assert.match(
      decision.ok === false ? decision.reason : '',
      /媒体执行令牌/,
      '拒绝原因应说清是哪一类令牌，便于排查',
    );
  }

  // ── 5. 用途判定：无主体 / 非对象一律拒绝 ───────────────────────────
  {
    for (const payload of [null, undefined, 'a-string', 42, {}, { type: LLM_PROXY_TOKEN_TYPE }]) {
      assert.equal(
        classifyLlmProxyToken(payload).ok,
        false,
        `${JSON.stringify(payload)} 不应被接受`,
      );
    }
  }

  // ── 6. 端到端：签发的票据能验签、带对用途、带对主体 ─────────────────
  {
    const jwt = makeJwt();
    const controller = new LlmProxyController(
      { get: () => undefined } as never,
      jwt,
    );
    const issued = controller.issueTicket({ user: { id: 'user-42' } }) as {
      ticket: string;
      ttlSeconds: number;
      expiresAt: string;
    };
    assert.ok(issued.ticket, '应返回票据');
    assert.equal(issued.ttlSeconds, DEFAULT_LLM_TICKET_TTL_SECONDS, '应返回生效的有效期');
    assert.ok(Date.parse(issued.expiresAt) > Date.now(), '过期时间应在未来');

    const claims = jwt.verify(issued.ticket) as { sub?: string; type?: string };
    assert.equal(claims.sub, 'user-42', '票据应绑定领取者');
    assert.equal(claims.type, LLM_PROXY_TOKEN_TYPE, '票据应带用途标记');
    assert.equal(classifyLlmProxyToken(claims).ok, true, '自己签的票应能过校验');

    // 票据必须短命：它会被写进节点输入，工作流一旦保存就落库了
    const ttlMs = Date.parse(issued.expiresAt) - Date.now();
    assert.ok(ttlMs <= 3_600_000, `票据有效期应在 1 小时内，实际 ${ttlMs}ms`);
  }

  // ── 7. 领票必须登录 ────────────────────────────────────────────────
  {
    const controller = new LlmProxyController({ get: () => undefined } as never, makeJwt());
    assert.throws(
      () => controller.issueTicket({}),
      /未认证/,
      '未登录不应能领票',
    );
    assert.throws(
      () => controller.issueTicket({ user: {} }),
      /未认证/,
      '缺少用户 id 不应能领票',
    );
  }

  // ── 8. 端点拦截：没有凭证不得消耗 LLM 额度 ─────────────────────────
  {
    const controller = new LlmProxyController(
      { get: (_key: string, fallback?: string) => fallback } as never,
      makeJwt(),
    );
    const res = {} as never;
    // 未带 Authorization
    await expectReject(
      () => controller.chatCompletions({}, { headers: {} }, res),
      /缺少 LLM 代理票据/,
    );
    // 带了但不是 Bearer
    await expectReject(
      () => controller.chatCompletions({}, { headers: { authorization: 'managed-by-gateway' } }, res),
      /缺少 LLM 代理票据/,
    );
    // 占位串：这是改动前前端实际填的值，必须被挡住
    await expectReject(
      () => controller.chatCompletions(
        {},
        { headers: { authorization: 'Bearer managed-by-gateway' } },
        res,
      ),
      /票据无效或已过期/,
    );
  }

  // ── 9. 端点拦截：过期票据与错用途令牌都不放行 ───────────────────────
  {
    const jwt = makeJwt();
    const controller = new LlmProxyController(
      { get: (_key: string, fallback?: string) => fallback } as never,
      jwt,
    );
    const res = {} as never;

    const expired = jwt.sign({ sub: 'u1', type: LLM_PROXY_TOKEN_TYPE }, { expiresIn: -60 });
    await expectReject(
      () => controller.chatCompletions({}, { headers: { authorization: `Bearer ${expired}` } }, res),
      /票据无效或已过期/,
    );

    const mediaToken = jwt.sign({ sub: 'u1', type: 'media_execution' }, { expiresIn: 600 });
    await expectReject(
      () => controller.chatCompletions(
        {},
        { headers: { authorization: `Bearer ${mediaToken}` } },
        res,
      ),
      /媒体执行令牌/,
    );
  }

  // ── 10. 持有效票据时不再被鉴权拦截 ─────────────────────────────────
  // 反向确认第 8/9 条不是因为「所有请求都被拦」而假通过：这里放行后应当走到
  // 上游调用阶段（用无效上游制造失败，只要错误不是 401 就说明鉴权已放行）。
  {
    const jwt = makeJwt();
    const controller = new LlmProxyController(
      {
        get: (key: string, fallback?: string) => {
          if (key === 'LLM_API_HOST') return 'http://127.0.0.1:9/invalid';
          if (key === 'LLM_API_KEY') return 'sk-smoke-test-key';
          return fallback;
        },
      } as never,
      jwt,
    );
    const ticket = jwt.sign({ sub: 'u1', type: LLM_PROXY_TOKEN_TYPE }, { expiresIn: 600 });
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) { sent.status = code; return this; },
      setHeader() { return this; },
      send(body: unknown) { sent.body = body; return this; },
      json(body: unknown) { sent.body = body; return this; },
    } as never;

    await controller.chatCompletions(
      {},
      { headers: { authorization: `Bearer ${ticket}` } },
      res,
    );
    // 上游不可达会走 502 分支；只要不是 401，就说明鉴权这一关确实放行了
    assert.notEqual(sent.status, 401, '有效票据不应被鉴权拦截');
    assert.equal(sent.status, 502, '放行后应进入上游调用阶段（此处上游故意不可达）');
  }

  // ── 11. 单次成本上限：超限字段被收敛，其它字段原样 ─────────────────
  {
    const { payload, clamped } = clampLlmCostFields(
      { messages: [{ role: 'user', content: 'hi' }], max_tokens: 999_999, n: 8, temperature: 0.5 },
      { maxTokens: 4096, maxCompletions: 1 },
    );
    assert.equal(payload.max_tokens, 4096, 'max_tokens 应被压到上限');
    assert.equal(payload.n, 1, 'n 应被压到 1（否则一次请求成本翻好几倍）');
    assert.equal(payload.temperature, 0.5, '非成本字段不应被改动');
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }], 'messages 应原样透传');
    assert.equal(clamped.length, 2, '应记录被收敛了哪几项');
  }

  // ── 12. 未超限 / 非法值都不动 ────────────────────────────────────
  {
    const under = clampLlmCostFields({ max_tokens: 100, n: 1 }, { maxTokens: 4096, maxCompletions: 1 });
    assert.equal(under.payload.max_tokens, 100, '未超限应保留');
    assert.equal(under.clamped.length, 0);

    // 非法值交给上游报错就好，不要在这里替用户猜
    const junk = clampLlmCostFields({ max_tokens: 'abc' }, { maxTokens: 4096, maxCompletions: 1 });
    assert.equal(junk.payload.max_tokens, 'abc', '非法值应原样保留，由上游判定');
    assert.equal(junk.clamped.length, 0);

    const missing = clampLlmCostFields({ messages: [] }, { maxTokens: 4096, maxCompletions: 1 });
    assert.equal('max_tokens' in missing.payload, false, '缺失时不应凭空塞一个默认值');
  }

  // ── 13. 无副作用 ─────────────────────────────────────────────────
  {
    const original = { max_tokens: 999_999 };
    clampLlmCostFields(original, { maxTokens: 10, maxCompletions: 1 });
    assert.equal(original.max_tokens, 999_999, 'clampLlmCostFields 不应修改入参对象');
  }

  // ── 14. 端点级：真的把收敛后的 body 发给了上游 ─────────────────────
  // 纯函数算对了 ≠ 控制器真的用它。这里拦下 fetch，看上游实际收到什么。
  {
    const jwt = makeJwt();
    const realFetch = global.fetch;
    // 用对象容器而不是 let x: T|null：闭包里赋值后 TS 会把它收窄成 null
    const captured: { body?: Record<string, any> } = {};
    global.fetch = (async (_url: unknown, options: any) => {
      captured.body = JSON.parse(options.body);
      return {
        status: 200,
        text: async () => '{"choices":[]}',
        headers: { get: () => 'application/json' },
      } as never;
    }) as never;

    try {
      const controller = new LlmProxyController(
        {
          get: (key: string, fallback?: string) => {
            if (key === 'LLM_API_HOST') return 'http://upstream.invalid';
            if (key === 'LLM_API_KEY') return 'sk-smoke';
            if (key === 'LLM_PROXY_MAX_TOKENS') return '5';
            if (key === 'LLM_PROXY_MAX_COMPLETIONS') return '1';
            return fallback;
          },
        } as never,
        jwt,
      );
      const ticket = jwt.sign({ sub: 'u1', type: LLM_PROXY_TOKEN_TYPE }, { expiresIn: 600 });
      const res = {
        status() { return this; },
        setHeader() { return this; },
        send() { return this; },
        json() { return this; },
      } as never;

      await controller.chatCompletions(
        { messages: [{ role: 'user', content: 'hi' }], max_tokens: 9999, n: 8, temperature: 0.5 },
        { headers: { authorization: `Bearer ${ticket}` } },
        res,
      );

      assert.ok(captured.body, '应真的发起上游请求');
      assert.equal(captured.body?.max_tokens, 5, '上游收到的 max_tokens 应是收敛后的值');
      assert.equal(captured.body?.n, 1, '上游收到的 n 应是收敛后的值');
      assert.equal(captured.body?.temperature, 0.5, '非成本字段仍应透传');
    } finally {
      global.fetch = realFetch;
    }
  }

  console.log(
    'llm-proxy 票据测试通过: 有效期回落 / 上下限 / 专用票据放行 / 登录令牌放行 / '
    + '跨用途拒绝 / 无主体拒绝 / 签发与绑定 / 领票需登录 / 无凭证拦截 / 占位串拦截 / '
    + '过期与错用途拦截 / 成本字段收敛 / 未超限与非法值不动 / 无副作用 / 上游实际收到收敛值',
  );
}

main();
