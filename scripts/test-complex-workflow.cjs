#!/usr/bin/env node
/**
 * 复杂工作流端到端验收：文本处理 → 大语言模型 → 代码执行 真实云端执行。
 * 其余节点类型（SQL/Python/知识检索/子工作流/MCP/批处理/条件/http）由各自专项套件覆盖，
 * 这里验证的是「多个异构节点串成一条链，用真实模型跑到底」。
 * 退出码：0 全通过；1 有失败。
 */
'use strict';

const fs = require('node:fs');
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
const PASSWORD = process.argv[2] || 'futureFlow@';

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

async function main() {
  const login = await json('POST', '/auth/login', null, { account: 'admin', password: PASSWORD });
  const token = login.data?.accessToken;
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
    const cleanup = await json('DELETE', `/workflows/${workflowId}`, token);
    record('清理验收工作流', cleanup.status === 200 || cleanup.status === 204, `HTTP ${cleanup.status}`);
  }

  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n===== 复杂工作流验收: ${results.length - failedCount}/${results.length} passed =====`);
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[FAIL] 复杂工作流验收中断 :: ${error.message}`);
  process.exit(1);
});
