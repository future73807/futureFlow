#!/usr/bin/env node
/**
 * 草稿云端试运行（draft-run）端到端验收。
 *
 * 前置：一键启动已完成（本地 Dify 就绪、管理员已初始化）。
 * 覆盖：知识检索草稿 → 沙箱导入/发布 → SSE 真实执行 → 修改草稿后重新导入 → 二次执行复用沙箱。
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
    const url = env.match(/^PUBLIC_GATEWAY_URL=(.*)$/m)?.[1]?.trim();
    if (url) return url.replace(/\/+$/, '');
  } catch { /* fall through */ }
  return 'http://localhost:3001';
}
const BASE = resolveGatewayBase();
const PASSWORD = process.argv[2] || 'futureFlow@';

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

const UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function draftGraph(datasetId, marker) {
  return {
    nodes: [
      {
        id: 'start_1',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: {
          title: '开始',
          inputsValues: { query: { type: 'constant', content: 'futureFlow' } },
          outputs: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string', title: '问题', default: 'futureFlow' } },
          },
        },
      },
      {
        id: 'kb_1',
        type: 'knowledge',
        meta: { position: { x: 300, y: 0 } },
        data: {
          title: '知识检索',
          datasetId,
          queryValue: { type: 'ref', content: ['start_1', 'query'] },
          topK: 3,
          outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'object' }, title: '检索结果' } } },
        },
      },
      {
        id: 'text_1',
        type: 'text',
        meta: { position: { x: 600, y: 0 } },
        data: {
          title: '文本处理',
          inputsValues: {
            text: { type: 'template', content: `检索完成 ${marker}，共 {{#kb_1.result#}} 条` },
          },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'end_1',
        type: 'end',
        data: {
          title: '结束',
          inputsValues: { result: { type: 'ref', content: ['text_1', 'text'] } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start_1', targetNodeID: 'kb_1' },
      { sourceNodeID: 'kb_1', targetNodeID: 'text_1' },
      { sourceNodeID: 'text_1', targetNodeID: 'end_1' },
    ],
  };
}

async function drainSse(res) {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const messages = buffer.split(/\r?\n\r?\n/);
    buffer = messages.pop() || '';
    for (const message of messages) {
      const jsonText = message
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (jsonText) {
        try { events.push(JSON.parse(jsonText)); } catch { /* 忽略无法解析的块 */ }
      }
    }
  }
  return events;
}

async function main() {
  const login = await json('POST', '/auth/login', null, { account: 'admin', password: PASSWORD });
  const token = login.data.accessToken;
  record('登录', Boolean(token));
  if (!token) process.exit(1);

  // 1. 建知识库 + 文档（云端专属节点的前置数据）。
  // 唯一后缀：Dify dataset 名称全局唯一，历史残留（如网关中断导致清理未执行）会引发 409。
  const uniqueSuffix = Date.now().toString(36);
  const ds = await json('POST', '/knowledge/datasets', token, { name: `试运行验收库-${uniqueSuffix}`, description: 'draft-run e2e' });
  record('创建知识库', ds.status === 201 && Boolean(ds.data.id), JSON.stringify(ds.data).slice(0, 100));
  const doc = await json('POST', `/knowledge/datasets/${ds.data.id}/documents`, token, {
    name: '说明.txt',
    text: 'futureFlow 是一个本地优先的 AI 工作流平台，支持草稿云端试运行。',
  });
  record('创建知识文档', doc.status === 201 && Boolean(doc.data.id));
  // economy 索引通常几秒内完成；轮询至 completed 再执行检索才有意义。
  let indexed = false;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const docs = await json('GET', `/knowledge/datasets/${ds.data.id}/documents`, token);
    const row = Array.isArray(docs.data) ? docs.data.find((d) => d.id === doc.data.id) : null;
    if (row && row.indexingStatus === 'completed') { indexed = true; break; }
  }
  record('文档索引完成', indexed);

  // 2. 创建工作流并保存含知识检索节点的草稿。
  const wf = await json('POST', '/workflows', token, {
    name: '云端试运行验收',
    description: 'draft-run e2e',
    flowgram: JSON.stringify({ nodes: [], edges: [] }),
  });
  const workflowId = wf.data.id || wf.data.workflow?.id;
  record('创建工作流', wf.status === 201 && Boolean(workflowId), wf.status === 201 ? '' : JSON.stringify(wf.data).slice(0, 120));
  const save = await json('PUT', `/workflows/${workflowId}`, token, {
    name: '云端试运行验收',
    flowgram: JSON.stringify(draftGraph(ds.data.id, 'v1')),
  });
  record('保存草稿 v1（含知识检索节点）', save.status === 200);

  // 3. 第一次 draft-run：导入沙箱 + 真实执行。
  const run1 = await fetch(`${BASE}/workflows/${workflowId}/draft-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: { query: 'futureFlow 是什么' } }),
  });
  const events1 = run1.ok ? await drainSse(run1) : [];
  const finished1 = events1.find((e) => e.event === 'workflow_finished');
  const nodeFailures1 = events1
    .filter((e) => (e.event === 'node_finished' && e.data?.status === 'failed') || e.event === 'error')
    .map((e) => JSON.stringify(e.data?.error || e.data?.message || e.data).slice(0, 200));
  record('第一次云端试运行（导入+发布+执行成功）', run1.ok && Boolean(finished1) && finished1.data?.status === 'succeeded' && nodeFailures1.length === 0,
    run1.ok
      ? `finished=${finished1?.data?.status || 'none'} failures=${nodeFailures1.join(' | ') || 'none'}`
      : `HTTP ${run1.status} ${JSON.stringify(await run1.json().catch(() => ({}))).slice(0, 160)}`);

  // 4. 修改草稿后第二次 draft-run：DSL 变化触发重新导入，仍执行成功。
  const save2 = await json('PUT', `/workflows/${workflowId}`, token, {
    name: '云端试运行验收',
    flowgram: JSON.stringify(draftGraph(ds.data.id, 'v2')),
  });
  record('修改草稿 v2', save2.status === 200);
  const run2 = await fetch(`${BASE}/workflows/${workflowId}/draft-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: { query: 'futureFlow' } }),
  });
  const events2 = run2.ok ? await drainSse(run2) : [];
  const finished2 = events2.find((e) => e.event === 'workflow_finished');
  record('草稿变更后第二次试运行（重新导入+执行成功）', run2.ok && Boolean(finished2) && finished2.data?.status === 'succeeded',
    run2.ok ? `finished=${finished2?.data?.status || 'none'}` : `HTTP ${run2.status}`);

  // 5. 第三次不改草稿直接执行（沙箱复用路径）。
  const run3 = await fetch(`${BASE}/workflows/${workflowId}/draft-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: { query: 'futureFlow' } }),
  });
  const events3 = run3.ok ? await drainSse(run3) : [];
  record('草稿未变第三次试运行（复用沙箱）', run3.ok && events3.some((e) => e.event === 'workflow_finished'),
    run3.ok ? `events=${events3.length}` : `HTTP ${run3.status} ${JSON.stringify(await run3.json().catch(() => ({}))).slice(0, 160)}`);

  // 6. 运行记录中应有 draft-run 来源。
  const runs = await json('GET', `/workflows/${workflowId}/runs?page=1&pageSize=10`, token);
  const items = runs.data?.items || runs.data?.runs || [];
  record('运行记录包含 draft-run 来源', items.some((r) => r.source === 'draft-run'),
    `keys=${Object.keys(runs.data || {})} sources=${items.map((r) => r.source).join(',')}`);

  // 7. 清理。
  await json('DELETE', `/workflows/${workflowId}`, token);
  await json('DELETE', `/knowledge/datasets/${ds.data.id}`, token);
  record('清理验收资源', true);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== 草稿云端试运行端到端验收: ${passed}/${results.length} passed =====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exit(1);
});
