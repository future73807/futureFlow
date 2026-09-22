#!/usr/bin/env node
/**
 * 复杂工作流端到端验收：文本处理 → 大语言模型 → 代码执行 真实云端执行。
 * 其余节点类型（SQL/Python/知识检索/子工作流/MCP/批处理/条件/http）由各自专项套件覆盖，
 * 这里验证的是「多个异构节点串成一条链，用真实模型跑到底」。
 * 退出码：0 全通过；1 有失败。
 */
'use strict';

const fs = require('node:fs');
const { adminPassword } = require('./lib/admin-credentials.cjs');
const { cleanupTestWorkflows, reportCleanup } = require('./lib/cleanup-workflows.cjs');
const { join } = require('node:path');

function gatewayBase() {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL.replace(/\/+$/, '');
  try {
    const env = fs.readFileSync(join(process.cwd(), '.env'), 'utf8');
    const port = env.match(/^GATEWAY_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* ignore */ }
  return 'http://localhost:3001';
}
const BASE = gatewayBase();
const PASSWORD = process.argv[2] || adminPassword();

/**
 * 本套件建两张工作流，名字都带时间戳后缀，只能前缀匹配。
 * 两个前缀都足够独特，不会撞上用户自己起的名字。
 */
const WORKFLOW_PREFIXES = ['诗词 API 验收-', '复杂工作流验收-'];

/** 登录后记下来，好让异常退出路径也能清理（脚本用 process.exit，finally 不保证执行）。 */
let activeToken = '';

/**
 * 收尾清理：按前缀扫描并删除本套件（含此前中断残留）的工作流。
 * 清理失败只警告、不判定套件失败——它是收尾动作，不是验收项本身。
 */
async function cleanupArtifacts() {
  if (!activeToken) return null;
  try {
    return await cleanupTestWorkflows({
      gateway: BASE,
      token: activeToken,
      prefixes: WORKFLOW_PREFIXES,
    });
  } catch (error) {
    console.warn(`工作流清理未完成（不判定失败）：${error?.message || error}`);
    return null;
  }
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
};

async function json(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** 复杂链：开始 → 文本处理（拼提示词）→ 大语言模型 → 代码执行 → 结束 */
const buildGraph = () => ({
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      meta: { position: { x: 80, y: 200 } },
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: { query: { type: 'string', title: '用户输入', default: '用一句话介绍未来科技' } },
        },
      },
    },
    {
      id: 'text_0',
      type: 'text',
      meta: { position: { x: 360, y: 200 } },
      data: {
        title: '文本处理',
        // 固定文本 + 上游变量混排，验证文本处理节点的拼接能力
        inputsValues: { text: { type: 'template', content: '请用不超过 30 个字回答：{{start_0.query}}' } },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
      },
    },
    {
      id: 'llm_0',
      type: 'llm',
      meta: { position: { x: 640, y: 200 } },
      data: {
        title: '大语言模型',
        inputsValues: {
          modelName: { type: 'constant', content: 'GLM-5.3-Flash' },
          temperature: { type: 'constant', content: 0.5 },
          systemPrompt: { type: 'template', content: '你是一名简洁的中文助手，直接给结论。' },
          prompt: { type: 'ref', content: ['text_0', 'text'] },
        },
        inputs: {
          type: 'object',
          required: ['modelName', 'temperature', 'prompt'],
          properties: {
            modelName: { type: 'string' },
            temperature: { type: 'number' },
            systemPrompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
            prompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
          },
        },
        outputs: { type: 'object', properties: { result: { type: 'string', title: '模型输出' } } },
      },
    },
    {
      id: 'code_0',
      type: 'code',
      meta: { position: { x: 940, y: 200 } },
      data: {
        title: '代码执行',
        inputsValues: {
          code: {
            type: 'template',
            content:
            'function main({ params }) {\n'
            + '  const text = String(params.text || "");\n'
            + '  return { result: { length: text.length, upper: text.slice(0, 20) } };\n'
            + '}',
          },
          text: { type: 'ref', content: ['llm_0', 'result'] },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { result: { type: 'object', title: '结果' } } },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 1220, y: 200 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['code_0', 'result'] } },
        inputs: { type: 'object', properties: { result: { type: 'object', title: '最终结果' } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'text_0' },
    { sourceNodeID: 'text_0', targetNodeID: 'llm_0' },
    { sourceNodeID: 'llm_0', targetNodeID: 'code_0' },
    { sourceNodeID: 'code_0', targetNodeID: 'end_0' },
  ],
});

async function runDraft(workflowId, token) {
  const res = await fetch(`${BASE}/workflows/${workflowId}/draft-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: {} }),
  });
  if (!res.body) return { events: [], status: res.status, raw: 'no-body' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || '';
    for (const part of parts) {
      const text = part
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!text) continue;
      try {
        events.push(JSON.parse(text));
      } catch { /* ignore keep-alive */ }
    }
  }
  return { events, status: res.status, raw: buffer.slice(0, 300) };
}


/** 真实外网 API 链：开始 → API 请求(每日诗词) → 文本处理(截取正文) → 结束 */
const buildPoetryGraph = () => ({
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      meta: { position: { x: 80, y: 200 } },
      data: {
        title: '开始',
        outputs: { type: 'object', properties: { query: { type: 'string', default: 'poetry' } } },
      },
    },
    {
      id: 'http_0',
      type: 'http',
      meta: { position: { x: 400, y: 200 } },
      data: {
        title: 'API 请求（每日诗词）',
        // 真实公网诗词接口：一言 hitokoto 的文学/诗词分类
        api: { method: 'GET', url: { type: 'constant', content: 'https://v1.hitokoto.cn/?c=i&encode=json' } },
        authorization: { type: 'none' },
        headers: { type: 'object', properties: {} },
        headersValues: {},
        params: { type: 'object', properties: {} },
        paramsValues: {},
        body: { bodyType: 'none' },
        timeout: { timeout: 15000, retryTimes: 1 },
        outputs: {
          type: 'object',
          properties: {
            // Dify 的 HTTP 节点把响应体作为整体输出，这里按字符串声明并由下游直接引用
            body: { type: 'string', title: '响应体' },
            statusCode: { type: 'integer', title: '状态码' },
          },
        },
      },
    },
    {
      id: 'text_0',
      type: 'text',
      meta: { position: { x: 760, y: 200 } },
      data: {
        title: '文本处理',
        // 把接口返回的诗句与出处拼成一句话，验证响应体能被下游引用
        inputsValues: {
          text: {
            type: 'template',
            content: '今日诗词接口响应：{{http_0.body}}',
          },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 1080, y: 200 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['text_0', 'text'] } },
        inputs: { type: 'object', properties: { result: { type: 'string', title: '结果' } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'http_0' },
    { sourceNodeID: 'http_0', targetNodeID: 'text_0' },
    { sourceNodeID: 'text_0', targetNodeID: 'end_0' },
  ],
});

async function runPoetryCase(token) {
  const created = await json('POST', '/workflows', token, {
    name: `诗词 API 验收-${Date.now().toString().slice(-6)}`,
    description: 'API 请求节点访问真实公网诗词接口',
    flowgram: JSON.stringify(buildPoetryGraph()),
  });
  const workflowId = created.data?.id;
  record('创建诗词 API 工作流(4 节点)', !!workflowId, `HTTP ${created.status}`);
  if (!workflowId) return;
  try {
    const { events, raw, status } = await runDraft(workflowId, token);
    const finished = events.find((e) => e.event === 'workflow_finished');
    const nodeFinished = events.filter((e) => e.event === 'node_finished');
    // Dify 上报的节点类型是 http-request，两种写法都认
    const httpNode = nodeFinished.find((e) => ['http', 'http-request'].includes(e.data?.node_type));
    const outputs = finished?.data?.outputs || {};
    const resultText = String(outputs.result || outputs.text || '');
    record(
      'API 请求节点访问公网诗词接口成功',
      httpNode?.data?.status === 'succeeded',
      httpNode?.data?.status === 'succeeded'
        ? `status=${finished?.data?.status}`
        : `HTTP=${status} raw=${String(raw).replace(/\s+/g, ' ').slice(0, 160)}`,
    );
    record(
      '接口返回真实诗词内容',
      resultText.indexOf('hitokoto') >= 0,
      `响应长度 ${resultText.length}`,
    );
    record(
      '响应体被下游文本处理引用并回填结束节点',
      resultText.indexOf('今日诗词接口响应') >= 0 && resultText.length > 40,
      resultText.replace(/\s+/g, ' ').slice(0, 90),
    );
    record(
      '整条链执行成功',
      finished?.data?.status === 'succeeded' && nodeFinished.every((e) => e.data?.status === 'succeeded'),
      nodeFinished.map((e) => `${e.data?.title}:${e.data?.status}`).join(' | '),
    );
  } finally {
    // 走共享清理件：按前缀扫描，连此前中断残留的一起收拾（单删 workflowId 只能
    // 收拾「跑到这一行」的那一次，套件崩掉留下的残留会一直堆在用户列表里）。
    const cleanup = await cleanupArtifacts();
    if (cleanup) reportCleanup(cleanup, '诗词/复杂工作流验收');
    record(
      '清理诗词验收工作流',
      !!cleanup && cleanup.failed.length === 0 && cleanup.matched >= 1,
      cleanup ? `匹配 ${cleanup.matched} 个，删除 ${cleanup.deleted} 个` : '清理未执行',
    );
  }
}

async function main() {
  const login = await json('POST', '/auth/login', null, { account: 'admin', password: PASSWORD });
  const token = login.data?.accessToken;
  activeToken = token || '';
  record('登录', !!token, `HTTP ${login.status}`);
  if (!token) throw new Error('登录失败');

  const created = await json('POST', '/workflows', token, {
    name: `复杂工作流验收-${Date.now().toString().slice(-6)}`,
    description: '文本处理 → 大语言模型 → 代码执行 异构链路',
    flowgram: JSON.stringify(buildGraph()),
  });
  const workflowId = created.data?.id;
  record('创建复杂工作流(5 节点/4 连线)', !!workflowId, `HTTP ${created.status}`);
  if (!workflowId) throw new Error('创建工作流失败');

  try {
    const started = Date.now();
    const { events, raw, status } = await runDraft(workflowId, token);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const finished = events.find((e) => e.event === 'workflow_finished');
    const nodeFinished = events.filter((e) => e.event === 'node_finished');
    const titles = nodeFinished.map((e) => `${e.data?.title}:${e.data?.status}`);
    const failed = nodeFinished.filter((e) => e.data?.status !== 'succeeded');

    record(
      '复杂工作流真实执行完成',
      finished?.data?.status === 'succeeded',
      finished?.data?.status
        ? `status=${finished.data.status} 耗时=${elapsed}s`
        : `HTTP=${status} raw=${String(raw).replace(/\s+/g, ' ').slice(0, 220)}`,
    );
    record(
      '四个业务节点全部成功（文本处理/大语言模型/代码执行/结束）',
      nodeFinished.length >= 4 && failed.length === 0,
      titles.join(' | '),
    );

    const llmNode = nodeFinished.find((e) => e.data?.node_type === 'llm');
    const llmText = String(llmNode?.data?.outputs?.result || llmNode?.data?.outputs?.text || '');
    record('大语言模型产出真实文本', llmText.length > 0, `${llmText.length} 字`);

    // 代码节点的产出经结束节点回填：result.length 应等于模型输出字数，证明链路真的串起来了
    const outputs = finished?.data?.outputs || {};
    const codeResult = outputs.result || outputs;
    const codeLength = Number(codeResult?.length || codeResult?.result?.length || 0);
    record(
      '代码执行消费上游模型输出并返回结构化结果',
      codeLength > 0 && codeLength === llmText.length,
      `code.length=${codeLength} llm.length=${llmText.length}`,
    );
    record(
      '工作流输出回填结束节点',
      !!outputs && Object.keys(outputs).length > 0,
      JSON.stringify(outputs).slice(0, 90),
    );

    const runs = await json('GET', `/workflows/${workflowId}/runs?page=1&pageSize=5`, token);
    const items = runs.data?.items || [];
    record(
      '运行记录落库（可用于回看与审计）',
      items.length >= 1 && items.some((r) => r.status === 'succeeded'),
      `runs=${items.length}`,
    );
    record(
      '本次执行计入计费（tokens 非零）',
      Number(finished?.data?.total_tokens || 0) > 0,
      `tokens=${finished?.data?.total_tokens}`,
    );
  } finally {
    // 见 runPoetryCase 里的同款说明：按前缀扫描，连残留一起清。
    const cleanup = await cleanupArtifacts();
    if (cleanup) reportCleanup(cleanup, '诗词/复杂工作流验收');
    record(
      '清理验收工作流',
      !!cleanup && cleanup.failed.length === 0 && cleanup.matched >= 1,
      cleanup ? `匹配 ${cleanup.matched} 个，删除 ${cleanup.deleted} 个` : '清理未执行',
    );
  }

  await runPoetryCase(token);

  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n===== 复杂工作流验收: ${results.length - failedCount}/${results.length} passed =====`);
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`[FAIL] 复杂工作流验收中断 :: ${error.message}`);
  // 中断也要清：否则这两张验收工作流会留在用户列表里
  await cleanupArtifacts();
  process.exit(1);
});
