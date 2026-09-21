#!/usr/bin/env node
/**
 * LLM 节点「前端链路」契约回归。
 *
 * 背景：浏览器「试运行」由 runtime-js 在前端执行，LLM 节点只能把凭证放进节点输入
 * （apiKey / apiHost）再由运行时发出。此前那两个位置填的是占位串
 * `managed-by-gateway`，而网关侧**完全不校验**，等于任何人只要能连到网关端口就能
 * 消耗平台级 LLM_API_KEY。现在改成：执行前先向 `POST /llm/ticket` 领一张短期票。
 *
 * 本脚本守住前端这一半（网关那一半由 gateway/test/llm-proxy-ticket-smoke.ts 守住）：
 *   - 票据要真的被注入到节点输入里（漏了的话节点会带着占位串去请求并被 401 拒掉）；
 *   - 领票失败不能让整条试运行在准备阶段崩掉，也不能静默填一个看起来像凭证的值。
 *
 * 刻意不 import 任何 gateway 源码：网关模块会连带加载 TypeORM 实体，在
 * transpile-only 下缺少装饰器元数据会直接抛错（同 test-python-runtime.cjs）。
 *
 * 用法：node scripts/test-llm-runtime.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { resolve } = require('node:path');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'CommonJS',
  moduleResolution: 'Node',
  esModuleInterop: true,
  target: 'ES2022',
  lib: ['ES2022', 'DOM'],
});
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require(resolve(__dirname, '../gateway/node_modules/ts-node/register/transpile-only'));

// utils/config.ts 里的 __GATEWAY_URL__ 由 rsbuild 在构建期注入。
const GATEWAY = 'http://localhost:3001';
global.__GATEWAY_URL__ = GATEWAY;

const {
  ensureLlmProxyTicket,
  peekLlmProxyTicket,
  prepareLLMNodesForRuntime,
  resetLlmProxyTicketCache,
} = require(resolve(__dirname, '../frontend/src/nodes/llm/runtime.ts'));
const { removeToken, setToken } = require(resolve(__dirname, '../frontend/src/utils/auth.ts'));

/** 造一个只含一个 LLM 节点的最小 schema。 */
function schemaWithLlm(llmData) {
  return {
    nodes: [
      {
        id: 'start_0',
        type: 'start',
        data: { title: '开始', outputs: { type: 'object', properties: {} } },
      },
      { id: 'llm_1', type: 'llm', data: llmData || {} },
    ],
  };
}

/** 取出准备后 LLM 节点的 apiKey / apiHost。 */
function readLlmInputs(schema) {
  const node = schema.nodes.find((n) => n.type === 'llm');
  const values = node.data.inputsValues || {};
  return {
    apiKey: values.apiKey && values.apiKey.content,
    apiHost: values.apiHost && values.apiHost.content,
  };
}

/**
 * 装一个假的 fetch，记录每次调用。
 * handler 返回 { status, json } 或抛错。
 */
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    const result = handler ? handler(calls.length) : { status: 200, json: {} };
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.json,
    };
  };
  return calls;
}

const realFetch = global.fetch;

// 顺序执行，每条都 await —— 不能 void 掉异步断言，否则失败会变成未处理拒绝，
// 而成功信息照常打印，看起来像通过。
async function run() {
  // ── 1. 未自定义时注入网关代理地址 ────────────────────────────────
  {
    const prepared = prepareLLMNodesForRuntime(schemaWithLlm({}));
    const { apiHost } = readLlmInputs(prepared);
    assert.equal(apiHost, `${GATEWAY}/llm`, 'apiHost 应指向网关的 LLM 代理');
  }

  // ── 2. 用户显式填过的值不被覆盖 ──────────────────────────────────
  {
    const prepared = prepareLLMNodesForRuntime(
      schemaWithLlm({
        inputsValues: {
          apiHost: { type: 'constant', content: 'https://my-own.example/v1' },
          apiKey: { type: 'constant', content: 'sk-my-own' },
        },
      }),
    );
    const { apiHost, apiKey } = readLlmInputs(prepared);
    assert.equal(apiHost, 'https://my-own.example/v1', '显式 apiHost 应保留');
    assert.equal(apiKey, 'sk-my-own', '显式 apiKey 应保留');
  }

  // ── 3. 没有票据时退回占位串（由网关给出明确 401，而不是这里静默造凭证）──
  {
    resetLlmProxyTicketCache();
    const prepared = prepareLLMNodesForRuntime(schemaWithLlm({}));
    assert.equal(
      readLlmInputs(prepared).apiKey,
      'managed-by-gateway',
      '无票据时应退回占位串，让网关给出可定位的报错',
    );
    assert.equal(peekLlmProxyTicket(), null, '此时缓存应为空');
  }

  // ── 4. 未登录：不发起请求，也不抛错 ──────────────────────────────
  {
    resetLlmProxyTicketCache();
    removeToken();
    const calls = stubFetch(() => ({ status: 200, json: { ticket: 'T' } }));
    const ticket = await ensureLlmProxyTicket();
    assert.equal(ticket, null, '未登录应返回 null');
    assert.equal(calls.length, 0, '未登录不应发起领票请求');
  }

  // ── 5. 登录后领票：请求地址与凭证头都要对 ────────────────────────
  {
    resetLlmProxyTicketCache();
    setToken('jwt-abc');
    const calls = stubFetch(() => ({
      status: 200,
      json: { ticket: 'ticket-1', ttlSeconds: 600 },
    }));
    const ticket = await ensureLlmProxyTicket();
    assert.equal(ticket, 'ticket-1', '应返回票据');
    assert.equal(calls.length, 1, '应只请求一次');
    assert.equal(calls[0].url, `${GATEWAY}/llm/ticket`, '请求地址应为 /llm/ticket');
    assert.equal(calls[0].options.method, 'POST', '应为 POST');
    assert.equal(
      calls[0].options.headers.Authorization,
      'Bearer jwt-abc',
      '应带上登录令牌，否则服务端无从判断发给谁',
    );
  }

  // ── 6. 领到的票要真的注入到节点输入里 ─────────────────────────────
  // 这是整条链路最容易断的一环：票据拿到了却没写进 schema，节点会带着占位串
  // 去请求，表现是「LLM 节点 401」，而原因看起来像网关配置问题。
  {
    const prepared = prepareLLMNodesForRuntime(schemaWithLlm({}));
    assert.equal(
      readLlmInputs(prepared).apiKey,
      'ticket-1',
      '票据必须注入到 apiKey，否则节点仍会带着占位串请求',
    );
  }

  // ── 7. 缓存：有效期内不重复请求 ──────────────────────────────────
  {
    const calls = stubFetch(() => ({ status: 200, json: { ticket: 'ticket-2' } }));
    const again = await ensureLlmProxyTicket();
    assert.equal(again, 'ticket-1', '有效期内应复用缓存');
    assert.equal(calls.length, 0, '有效期内不应重复请求');
  }

  // ── 8. 临近过期时续期 ────────────────────────────────────────────
  {
    // 先灌一张只剩 30 秒的票（续期余量是 60 秒）。
    // 必须先清缓存：否则上一条留下的 600 秒票会被直接命中，这步根本不会发请求，
    // 于是「续期」看起来通过了，实际测的是缓存复用。
    resetLlmProxyTicketCache();
    stubFetch(() => ({ status: 200, json: { ticket: 'ticket-short', ttlSeconds: 30 } }));
    const seeded = await ensureLlmProxyTicket();
    assert.equal(seeded, 'ticket-short', '短票应被灌入缓存');

    const calls = stubFetch(() => ({
      status: 200,
      json: { ticket: 'ticket-renewed', ttlSeconds: 600 },
    }));
    const renewed = await ensureLlmProxyTicket();
    assert.equal(renewed, 'ticket-renewed', '临近过期应重新领票');
    assert.equal(calls.length, 1, '应发起一次续期请求');
  }

  // ── 9. 服务端非 2xx：返回 null，不抛错 ────────────────────────────
  // 未登录、网关未配 LLM、网关版本较旧没有该端点，都不该让整条试运行在准备
  // 阶段就崩掉——让 LLM 节点自己带明确报错失败，比在这里抛无关异常好定位。
  {
    resetLlmProxyTicketCache();
    stubFetch(() => ({ status: 401, json: {} }));
    assert.equal(await ensureLlmProxyTicket(), null, '401 应返回 null 而不是抛错');
    assert.equal(peekLlmProxyTicket(), null, '失败后缓存应清空');
  }

  // ── 10. 响应缺 ticket 字段：同样不能当成成功 ──────────────────────
  {
    resetLlmProxyTicketCache();
    stubFetch(() => ({ status: 200, json: { ttlSeconds: 600 } }));
    assert.equal(await ensureLlmProxyTicket(), null, '缺 ticket 字段应视为失败');
  }

  // ── 11. 网络异常：吞掉并降级，不影响其它节点 ──────────────────────
  {
    resetLlmProxyTicketCache();
    stubFetch(() => { throw new Error('network down'); });
    assert.equal(await ensureLlmProxyTicket(), null, '网络异常应返回 null');
  }

  // ── 12. 领票失败后，节点仍退回占位串而不是 undefined ───────────────
  {
    const prepared = prepareLLMNodesForRuntime(schemaWithLlm({}));
    assert.equal(
      readLlmInputs(prepared).apiKey,
      'managed-by-gateway',
      '领票失败后应退回占位串，保证 schema 结构完整',
    );
  }

  // ── 13. 嵌套 block 内的 LLM 节点也要被处理 ────────────────────────
  {
    resetLlmProxyTicketCache();
    setToken('jwt-abc');
    stubFetch(() => ({ status: 200, json: { ticket: 'ticket-nested', ttlSeconds: 600 } }));
    await ensureLlmProxyTicket();
    const schema = {
      nodes: [
        {
          id: 'loop_0',
          type: 'loop',
          blocks: [{ id: 'llm_in', type: 'llm', data: {} }],
          data: {},
        },
      ],
    };
    const prepared = prepareLLMNodesForRuntime(schema);
    const inner = prepared.nodes[0].blocks.find((n) => n.type === 'llm');
    assert.equal(
      inner.data.inputsValues.apiKey.content,
      'ticket-nested',
      '循环体内的 LLM 节点同样要注入票据',
    );
  }

  global.fetch = realFetch;
  console.log(
    'llm runtime tests passed: 代理地址注入 / 显式值保留 / 无票退回占位串 / 未登录不请求 / '
    + '领票地址与凭证头 / 票据注入节点 / 缓存复用 / 临近过期续期 / 非 2xx 降级 / '
    + '缺字段降级 / 网络异常降级 / 失败后结构完整 / 嵌套节点',
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
