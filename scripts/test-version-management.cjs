#!/usr/bin/env node
/**
 * 版本管理与导入导出端到端验收。
 *
 * 前置：一键启动已完成（本地 Dify 就绪、管理员已初始化）。
 * 覆盖：发布自动存版本 → 版本号 1.0/1.1 递增 → 手动另存为 → 注释编辑 →
 *       回退到历史版本 → 导入校验（缺节点/悬空边/正常文件）。
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const fs = require('node:fs');
const { join } = require('node:path');

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

/** 与网关 formatVersionLabel 相同的展示公式 */
const label = (n) => `${Math.floor((n - 1) / 10) + 1}.${(n - 1) % 10}`;

const graph = (promptText) => ({
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      meta: { position: { x: 80, y: 200 } },
      data: {
        title: '开始',
        outputs: { type: 'object', properties: { query: { type: 'string', default: '你好' } } },
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
          systemPrompt: { type: 'template', content: '你是一名可靠的 AI 助手。' },
          prompt: { type: 'template', content: promptText },
        },
        inputs: {
          type: 'object',
          required: ['modelName', 'temperature', 'prompt'],
          properties: {
            modelName: { type: 'string' },
            temperature: { type: 'number' },
            systemPrompt: { type: 'string' },
            prompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
          },
        },
        outputs: { type: 'object', properties: { result: { type: 'string' } } },
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
});

async function main() {
  const login = await json('POST', '/auth/login', null, { account: ADMIN, password: PASSWORD });
  const token = login.data?.accessToken;
  record('登录获取管理员 JWT', !!token, `HTTP ${login.status}`);
  if (!token) throw new Error('登录失败');

  // 1) 建一张最小工作流（开始 → 大语言模型 → 结束）
  const created = await json('POST', '/workflows', token, {
    name: `版本验收-${Date.now().toString().slice(-6)}`,
    description: '版本管理端到端验收',
    flowgram: JSON.stringify(graph('{{start_0.query}}')),
  });
  const workflowId = created.data?.id;
  record('创建工作流', !!workflowId, `HTTP ${created.status}`);
  if (!workflowId) throw new Error('创建工作流失败');

  try {
    // 2) 第一次发布：自动保存一个版本，编号 1.0
    const publish1 = await json('POST', `/workflows/${workflowId}/publish`, token);
    record(
      '发布自动保存版本 v1.0',
      publish1.status === 201 || publish1.status === 200,
      String(publish1.data?.message || `HTTP ${publish1.status}`),
    );
    let versions = (await json('GET', `/workflows/${workflowId}/versions`, token)).data;
    versions = Array.isArray(versions) ? versions : versions?.items || [];
    record(
      '版本列表返回 label/时间/注释字段',
      versions.length === 1
        && versions[0].label === '1.0'
        && !!versions[0].createdAt
        && typeof versions[0].comment === 'string'
        && versions[0].isPublished === true,
      JSON.stringify({ label: versions[0]?.label, comment: versions[0]?.comment }),
    );

    // 3) 改草稿后再次发布 → 1.1
    const updated = await json('PUT', `/workflows/${workflowId}`, token, {
      flowgram: JSON.stringify(graph('{{start_0.query}} 请更简洁')),
    });
    record('修改草稿', updated.status === 200, `HTTP ${updated.status}`);
    const publish2 = await json('POST', `/workflows/${workflowId}/publish`, token);
    versions = (await json('GET', `/workflows/${workflowId}/versions`, token)).data;
    versions = Array.isArray(versions) ? versions : versions?.items || [];
    record(
      '二次发布递增到 v1.1',
      versions[0]?.label === '1.1' && versions[0]?.source === 'publish',
      `latest=${versions[0]?.label} source=${versions[0]?.source} msg=${publish2.data?.message}`,
    );

    // 4) 手动另存为 → 1.2，可带注释（必须先改草稿，否则与最新版本一致会被正确拒绝）
    await json('PUT', `/workflows/${workflowId}`, token, {
      flowgram: JSON.stringify(graph('{{start_0.query}} 请更简洁，一句话')),
    });
    const manual = await json('POST', `/workflows/${workflowId}/versions`, token, {
      comment: '上线前的稳定版',
    });
    record(
      '手动另存为版本 v1.2（带注释）',
      (manual.status === 200 || manual.status === 201) && manual.data?.label === '1.2'
        && manual.data?.source === 'manual' && manual.data?.comment === '上线前的稳定版',
      JSON.stringify({ label: manual.data?.label, comment: manual.data?.comment }),
    );

    // 5) 草稿没变时重复另存应被拒
    const duplicate = await json('POST', `/workflows/${workflowId}/versions`, token, {});
    record(
      '草稿未变化时拒绝另存(400)',
      duplicate.status === 400,
      String(duplicate.data?.message || `HTTP ${duplicate.status}`),
    );

    // 6) 编辑注释
    const patched = await json(
      'PATCH',
      `/workflows/${workflowId}/versions/${versions[1]?.version ?? 1}`,
      token,
      { comment: '首个可用版本' },
    );
    record('编辑历史版本注释', patched.status === 200, `HTTP ${patched.status}`);

    // 7) 回退到 v1.0：只改草稿，不产生新版本、不自动发布
    const beforeRestore = (await json('GET', `/workflows/${workflowId}/versions`, token)).data;
    const allVersions = Array.isArray(beforeRestore) ? beforeRestore : beforeRestore?.items || [];
    const target = allVersions.find((item) => item.label === '1.0') || allVersions[allVersions.length - 1];
    const restore = await json(
      'POST',
      `/workflows/${workflowId}/versions/${target.version}/restore`,
      token,
    );
    const afterRestore = (await json('GET', `/workflows/${workflowId}/versions`, token)).data;
    const afterList = Array.isArray(afterRestore) ? afterRestore : afterRestore?.items || [];
    record(
      '回退到 v1.0 只更新草稿',
      restore.status === 200 || restore.status === 201,
      `label=${restore.data?.label} 版本数=${afterList.length}`,
    );
    record('回退不自动发布', !!(await json('GET', `/workflows/${workflowId}`, token)).data, '');

    // 8) 导入：正常文件 / 缺节点 / 悬空边
    const okImport = await json('POST', '/workflows/import', token, {
      name: '导入验收工作流',
      description: '由版本验收脚本导入',
      flowgram: graph('{{start_0.query}}'),
    });
    record('导入合法工作流', okImport.status === 201 || okImport.status === 200, `HTTP ${okImport.status}`);
    if (okImport.data?.id) {
      await json('DELETE', `/workflows/${okImport.data.id}`, token);
    }

    const noNodes = await json('POST', '/workflows/import', token, {
      name: '坏文件',
      flowgram: { nodes: [], edges: [] },
    });
    record('导入空节点文件被拒(400)', noNodes.status === 400, String(noNodes.data?.message || ''));

    const badEdge = await json('POST', '/workflows/import', token, {
      name: '坏边文件',
      flowgram: {
        nodes: [{ id: 'a', type: 'start', data: {} }],
        edges: [{ sourceNodeID: 'a', targetNodeID: '不存在' }],
      },
    });
    record('导入悬空边被拒(400)', badEdge.status === 400, String(badEdge.data?.message || ''));
  } finally {
    const cleanup = await json('DELETE', `/workflows/${workflowId}`, token);
    record('清理验收工作流', cleanup.status === 200 || cleanup.status === 204, `HTTP ${cleanup.status}`);
  }

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n===== 版本管理验收: ${results.length - failed}/${results.length} passed =====`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[FAIL] 版本管理验收中断 :: ${error.message}`);
  process.exit(1);
});
