#!/usr/bin/env node
/**
 * 任务中心端到端验收。
 *
 * 前置：一键启动已完成（本地 Dify 就绪、管理员已初始化）。
 * 覆盖：批量任务创建 → 逐行真实执行 → 进度轮询 → 结果落库 → 校验失败用例 →
 *       取消执行 → 异步任务列表。
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const fs = require('node:fs');
const { join } = require('node:path');

// 默认网关地址从仓库根目录 .env 读取，避免端口调整后脚本失联。
function resolveGatewayBase() {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL.replace(/\/+$/, '');
  try {
    const env = fs.readFileSync(join(process.cwd(), '.env'), 'utf8');
    const port = env.match(/^GATEWAY_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* fall through */ }
  return 'http://localhost:3001';
}
const BASE = resolveGatewayBase();
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.argv[2] || 'futureFlow@';
const POLL_TIMEOUT_MS = Number(process.env.TASK_CENTER_TIMEOUT_MS || 240000);

const results = [];
function record(name, ok, detail = '') {
  results.push({ ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTerminal(taskId, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await json('GET', `/tasks/batch/${taskId}`, token);
    last = data;
    if (data.status && !['pending', 'running'].includes(data.status)) return data;
    await sleep(1500);
  }
  return last;
}

async function main() {
  // 1) 登录
  const login = await json('POST', '/auth/login', null, { account: ADMIN, password: PASSWORD });
  const token = login.data?.accessToken;
  record('登录获取管理员 JWT', login.status === 200 || login.status === 201, `HTTP ${login.status}`);
  if (!token) throw new Error('登录失败，无法继续');

  // 2) 选一张可执行的工作流：优先已发布版本，否则退回草稿沙箱执行。
  //    云端执行链只认 Dify 支持的节点，纯本地工具（Python/SQL）图要跳过，
  //    否则拿到的是「工作流至少需要一个可执行节点」这类预期的拒绝结果。
  // 2) 自建一张最小可执行工作流（开始 → 大语言模型 → 结束）。
  //    不复用库里已有的工作流：历史草稿可能带空提示词或未配置的条件分支，
  //    那样测到的是「拒绝」而不是「批量执行」，结论不可复现。
  const batchWorkflow = await json('POST', '/workflows', token, {
    name: `任务中心验收-${Date.now().toString().slice(-6)}`,
    description: '任务中心端到端验收专用（开始 → 大语言模型 → 结束）',
    flowgram: JSON.stringify({
      nodes: [
        {
          id: 'start_0',
          type: 'start',
          meta: { position: { x: 80, y: 200 } },
          data: {
            title: '开始',
            outputs: {
              type: 'object',
              properties: { query: { type: 'string', default: '你好' } },
            },
          },
        },
        {
          id: 'llm_0',
          type: 'llm',
          meta: { position: { x: 480, y: 200 } },
          data: {
            title: '大语言模型 1',
            inputsValues: {
              modelName: { type: 'constant', content: 'glm-5.3-flash' },
              temperature: { type: 'constant', content: 0.5 },
              systemPrompt: {
                type: 'template',
                content: '你是一名可靠的 AI 助手，请用清晰、准确的中文回答。',
              },
              prompt: { type: 'template', content: '{{start_0.query}}' },
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
            outputs: {
              type: 'object',
              properties: { result: { type: 'string' } },
            },
          },
        },
        {
          id: 'end_0',
          type: 'end',
          meta: { position: { x: 900, y: 200 } },
          data: {
            title: '结束',
            inputsValues: { result: { type: 'ref', content: ['llm_0', 'result'] } },
            inputs: { type: 'object', properties: { result: { type: 'string' } } },
          },
        },
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
        { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
      ],
    }),
  });
  const target = batchWorkflow.data;
  const created = batchWorkflow.status === 201 || batchWorkflow.status === 200;
  record(
    '创建验收专用工作流',
    created && !!target?.id,
    created ? `${target.name}` : `HTTP ${batchWorkflow.status}`,
  );
  if (!created) throw new Error('创建工作流失败，无法继续');

  const mode = 'draft';

  // 3) 参数校验：空输入必须被拒
  const invalid = await json('POST', '/tasks/batch', token, {
    workflowId: target.id,
    mode,
    inputs: [],
  });
  record('空输入被拒绝(400)', invalid.status === 400, `HTTP ${invalid.status}`);

  // 4) 越权校验：伪造 workflowId 必须被拒
  const foreign = await json('POST', '/tasks/batch', token, {
    workflowId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    mode,
    inputs: [{ query: 'hello' }],
  });
  record(
    '不存在的工作流被拒绝(400)',
    foreign.status === 400,
    `HTTP ${foreign.status}`,
  );

  // 5) 真实批量执行：两行输入逐行驱动同一张工作流
  const taskCreated = await json('POST', '/tasks/batch', token, {
    workflowId: target.id,
    name: '任务中心验收批量任务',
    mode,
    inputs: [{ query: '用一句话介绍你自己' }, { query: '1+1等于几？请只回答数字' }],
  });
  const okCreate = taskCreated.status === 200 || taskCreated.status === 201;
  record('创建批量任务(2 行输入)', okCreate, `HTTP ${taskCreated.status} id=${taskCreated.data?.id || '-'}`);
  if (!okCreate) throw new Error(`创建批量任务失败: ${JSON.stringify(taskCreated.data).slice(0, 200)}`);
  const taskId = taskCreated.data.id;

  // 6) 列表里能查到刚才的任务
  const listed = await json('GET', '/tasks/batch?page=1&pageSize=20', token);
  record(
    '批量任务列表包含新任务',
    Array.isArray(listed.data?.items) && listed.data.items.some((item) => item.id === taskId),
    `total=${listed.data?.total}`,
  );

  // 7) 轮询到终态并校验逐行结果
  const finished = await waitForTerminal(taskId, token);
  const rows = Array.isArray(finished?.results) ? finished.results : [];
  record('批量任务执行成功', finished?.status === 'succeeded', `status=${finished?.status}`);
  record(
    '逐行结果全部落库',
    rows.length === 2 && rows.every((row) => row.status === 'succeeded'),
    `rows=${rows.length} succeeded=${finished?.succeededCount} failed=${finished?.failedCount}`,
  );
  const firstOutput = (rows[0]?.outputText || '').trim();
  record('第一行有真实模型输出', firstOutput.length > 0, `${firstOutput.length} 字符`);
  record(
    '任务计数与结果一致',
    finished?.succeededCount === 2 && finished?.failedCount === 0 && finished?.totalCount === 2,
    `${finished?.succeededCount}/${finished?.totalCount}`,
  );
  record('任务已写入完成时间', !!finished?.finishedAt, String(finished?.finishedAt || ''));

  // 8) 运行记录里能看到 batch 来源
  const runs = await json('GET', `/workflows/${target.id}/runs?page=1&pageSize=50`, token);
  const runItems = runs.data?.items || runs.data || [];
  record(
    '运行记录包含 batch 来源',
    Array.isArray(runItems) && runItems.some((run) => run.source === 'batch'),
    `runs=${Array.isArray(runItems) ? runItems.length : 0}`,
  );

  // 9) 取消：新建任务后立刻取消，必须落到 cancelled
  const cancelTarget = await json('POST', '/tasks/batch', token, {
    workflowId: target.id,
    name: '任务中心验收-取消用例',
    mode,
    inputs: [{ query: 'a' }, { query: 'b' }, { query: 'c' }],
  });
  if (cancelTarget.data?.id) {
    const cancelRes = await json('POST', `/tasks/batch/${cancelTarget.data.id}/cancel`, token);
    record('取消接口返回 ok', cancelRes.data?.ok === true, `HTTP ${cancelRes.status}`);
    const cancelled = await waitForTerminal(cancelTarget.data.id, token);
    record(
      '取消后任务进入终态(cancelled/failed)',
      cancelled?.status === 'cancelled' || cancelled?.status === 'failed',
      `status=${cancelled?.status}`,
    );
  } else {
    record('取消接口返回 ok', false, '创建取消用例任务失败');
    record('取消后任务进入终态(cancelled/failed)', false, '创建取消用例任务失败');
  }

  // 10) 异步任务列表（Webhook/定时/API 来源）
  const async = await json('GET', '/tasks/async?page=1&pageSize=10', token);
  record(
    '异步任务列表返回分页结构',
    Array.isArray(async.data?.items) && typeof async.data?.total === 'number',
    `total=${async.data?.total}`,
  );

  // 11) 清理：删掉验收专用工作流，避免污染资源列表
  const cleanup = await json('DELETE', `/workflows/${target.id}`, token);
  record('清理验收专用工作流', cleanup.status === 200 || cleanup.status === 204, `HTTP ${cleanup.status}`);

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n===== 任务中心验收: ${results.length - failed}/${results.length} passed =====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[FAIL] 任务中心验收中断 :: ${error.message}`);
  const failed = results.filter((item) => !item.ok).length + 1;
  console.log(`\n===== 任务中心验收: ${results.length - failed + 1}/${results.length + 1} passed =====`);
  process.exit(1);
});
