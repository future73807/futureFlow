#!/usr/bin/env node

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function loadEnvFile() {
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const gatewayPort = process.env.GATEWAY_PORT || '3001';
const CONFIG = {
  gatewayUrl: (process.env.GATEWAY_URL || `http://127.0.0.1:${gatewayPort}`).replace(/\/+$/, ''),
  adminAccount: process.env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME,
  adminPassword: process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD,
  modelName: process.env.LLM_DEFAULT_MODEL || 'deepseek-chat',
  difyConsoleBase: (
    process.env.DIFY_CONSOLE_BASE || 'http://127.0.0.1:5001/console/api'
  ).replace(/\/+$/, ''),
  difyConsoleToken: process.env.DIFY_CONSOLE_TOKEN,
  difyAdminEmail: process.env.DIFY_ADMIN_EMAIL || 'admin@futureflow.local',
  difyAdminPassword: process.env.DIFY_ADMIN_PASSWORD,
  skipLlm: process.env.FUTUREFLOW_SKIP_LLM?.trim().toLowerCase() === 'true',
};

const state = {
  adminToken: null,
  apiKey: null,
  apiKeyId: null,
  workflowId: null,
  publishedVersion: null,
  difyAppId: null,
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(path, {
  method = 'GET',
  token,
  body,
  expected = [200],
  timeoutMs,
} = {}) {
  const response = await fetchWithTimeout(`${CONFIG.gatewayUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, timeoutMs);
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw.slice(0, 500) };
  }
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path} 返回 ${response.status}：${data.message || data.error || '未知错误'}`,
    );
  }
  return data;
}

function parseSseEvents(body) {
  const source = String(body).replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('工作流返回了空的 SSE 数据流');
  const frames = source.split('\n\n');
  const trailing = frames.pop();
  if (trailing?.trim()) {
    throw new Error(`SSE 数据流不完整：${trailing.trim().slice(0, 160)}`);
  }

  return frames
    .map((frame) => frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim())
    .filter(Boolean)
    .map((jsonText) => {
      let event;
      try {
        event = JSON.parse(jsonText);
      } catch {
        throw new Error(`SSE 事件不是合法 JSON：${jsonText.slice(0, 160)}`);
      }
      if (!event || typeof event !== 'object' || typeof event.event !== 'string' || !event.event.trim()) {
        throw new Error(`SSE 事件缺少有效的 event 类型：${jsonText.slice(0, 160)}`);
      }
      return event;
    });
}

function findSensitiveValuePaths(value, marker, path = '$') {
  if (typeof value === 'string') return value.includes(marker) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSensitiveValuePaths(item, marker, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => (
    findSensitiveValuePaths(child, marker, `${path}.${key}`)
  ));
}

function validateExecutionEvents(events) {
  assert.ok(Array.isArray(events) && events.length > 0, 'SSE 事件列表不能为空');

  const startedEvents = events.filter((event) => event.event === 'workflow_started');
  assert.equal(startedEvents.length, 1, '必须且只能收到一个 workflow_started 事件');

  const errorEvents = events.filter((event) => event.event === 'error');
  if (errorEvents.length > 0) {
    const firstError = errorEvents[0];
    throw new Error(
      `工作流事件流返回错误：${firstError.data?.message || firstError.data?.code || '未知错误'}`,
    );
  }

  const terminalEvents = events.filter((event) => (
    event.event === 'workflow_finished' || event.event === 'error'
  ));
  assert.equal(terminalEvents.length, 1, '必须且只能收到一个工作流终态事件');
  const finished = terminalEvents[0];
  assert.equal(finished.event, 'workflow_finished', '工作流必须以 workflow_finished 正常结束');

  const trailingEvents = events
    .slice(events.indexOf(finished) + 1)
    .filter((event) => event.event !== 'ping');
  assert.equal(trailingEvents.length, 0, 'workflow_finished 后不得再出现非 ping 事件');
  const nodeEvents = events.filter((event) => event.event === 'node_finished');
  const firstFailedNode = nodeEvents.find((event) => event.data?.status !== 'succeeded');
  const failedNodeContext = firstFailedNode
    ? `；失败节点：${firstFailedNode.data?.title || firstFailedNode.data?.node_id || '未知'}（${firstFailedNode.data?.node_type || '未知类型'} / ${firstFailedNode.data?.status || '未知状态'}）`
    : '';
  assert.equal(
    finished.data?.status,
    'succeeded',
    `工作流失败：${finished.data?.error || finished.data?.status || '未知错误'}${failedNodeContext}`,
  );

  assert.ok(nodeEvents.length > 0, '工作流未返回任何 node_finished 事件');
  return { finished, nodeEvents };
}

function buildWorkflow() {
  const workflow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            required: ['query', 'apiToken'],
            properties: {
              query: { type: 'string', default: '你好，futureFlow' },
              apiToken: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'model',
        type: 'llm',
        meta: { position: { x: 280, y: 0 } },
        data: {
          title: '大语言模型',
          inputsValues: {
            modelName: { type: 'constant', content: CONFIG.modelName },
            temperature: { type: 'constant', content: 0.1 },
            prompt: {
              type: 'template',
              content: '请用一句简短中文回答：{{start.query}}',
            },
          },
          outputs: { type: 'object', properties: { result: { type: 'string' } } },
        },
      },
      {
        id: 'text',
        type: 'text',
        meta: { position: { x: 560, y: 0 } },
        data: {
          title: '文本处理',
          inputsValues: {
            text: {
              type: 'template',
              content: '输入：{{start.query}}\n模型：{{model.result}}',
            },
          },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'image',
        type: 'image',
        meta: { position: { x: 840, y: 0 } },
        data: {
          title: '图片处理',
          inputsValues: {
            url: { type: 'constant', content: 'https://example.com/futureflow-image.png' },
            caption: { type: 'ref', content: ['text', 'text'] },
          },
          outputs: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              caption: { type: 'string' },
              mediaType: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'video',
        type: 'video',
        meta: { position: { x: 1120, y: 0 } },
        data: {
          title: '视频处理',
          inputsValues: {
            url: { type: 'constant', content: 'https://example.com/futureflow-video.mp4' },
            poster: { type: 'ref', content: ['image', 'url'] },
            caption: { type: 'ref', content: ['image', 'caption'] },
          },
          outputs: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              poster: { type: 'string' },
              caption: { type: 'string' },
              mediaType: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'api',
        type: 'http',
        meta: { position: { x: 1400, y: 0 } },
        data: {
          title: 'API 请求',
          api: {
            method: 'GET',
            url: { type: 'constant', content: 'https://dns.google/resolve' },
          },
          authorization: {
            type: 'bearer',
            token: { type: 'ref', content: ['start', 'apiToken'] },
          },
          paramsValues: {
            name: { type: 'constant', content: 'example.com' },
            type: { type: 'constant', content: 'A' },
          },
          headersValues: {
            Accept: { type: 'constant', content: 'application/dns-json' },
          },
          body: { bodyType: 'none' },
          timeout: { timeout: 30_000, retryTimes: 1 },
          outputs: {
            type: 'object',
            properties: {
              body: { type: 'string' },
              headers: { type: 'object' },
              statusCode: { type: 'integer' },
            },
          },
        },
      },
      {
        id: 'code',
        type: 'code',
        meta: { position: { x: 1680, y: 0 } },
        data: {
          title: 'JavaScript 代码',
          inputsValues: {
            responseBody: { type: 'ref', content: ['api', 'body'] },
            statusCode: { type: 'ref', content: ['api', 'statusCode'] },
          },
          inputs: {
            type: 'object',
            properties: {
              responseBody: { type: 'string' },
              statusCode: { type: 'integer' },
            },
          },
          script: {
            language: 'javascript',
            content: `function main({ params }) {
  return {
    items: [1, 2, 3],
    apiStatus: Number(params.statusCode),
    bodyLength: String(params.responseBody || '').length,
    region: 'CN',
    metadata: { source: 'dns-api' }
  };
}`,
          },
          outputs: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'number' } },
              apiStatus: { type: 'integer' },
              bodyLength: { type: 'number' },
              region: { type: 'string' },
              metadata: {
                type: 'object',
                properties: { source: { type: 'string' } },
              },
            },
          },
        },
      },
      {
        id: 'variable',
        type: 'variable',
        meta: { position: { x: 2240, y: 0 } },
        data: {
          title: '变量赋值',
          assign: [
            {
              operator: 'declare',
              left: 'items',
              right: { type: 'ref', content: ['code', 'items'] },
            },
            {
              operator: 'declare',
              left: 'getApiStatus',
              right: { type: 'ref', content: ['code', 'getApiStatus'] },
            },
            {
              operator: 'declare',
              left: 'getBodyLength',
              right: { type: 'ref', content: ['code', 'getBodyLength'] },
            },
            {
              operator: 'declare',
              left: 'getProbe',
              right: { type: 'ref', content: ['code', 'getProbe'] },
            },
            {
              operator: 'declare',
              left: 'getQuery',
              right: { type: 'ref', content: ['code', 'getQuery'] },
            },
            {
              operator: 'declare',
              left: 'postApiStatus',
              right: { type: 'ref', content: ['code', 'postApiStatus'] },
            },
            {
              operator: 'declare',
              left: 'postBodyLength',
              right: { type: 'ref', content: ['code', 'postBodyLength'] },
            },
            {
              operator: 'declare',
              left: 'postProbe',
              right: { type: 'ref', content: ['code', 'postProbe'] },
            },
            {
              operator: 'declare',
              left: 'postMessage',
              right: { type: 'ref', content: ['code', 'postMessage'] },
            },
            {
              operator: 'declare',
              left: 'postCount',
              right: { type: 'ref', content: ['code', 'postCount'] },
            },
            {
              operator: 'declare',
              left: 'postNestedOk',
              right: { type: 'ref', content: ['code', 'postNestedOk'] },
            },
            {
              operator: 'declare',
              left: 'region',
              right: { type: 'ref', content: ['code', 'region'] },
            },
            {
              operator: 'declare',
              left: 'metadata',
              right: { type: 'ref', content: ['code', 'metadata'] },
            },
          ],
          outputs: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'number' } },
              getApiStatus: { type: 'integer' },
              getBodyLength: { type: 'number' },
              getProbe: { type: 'string' },
              getQuery: { type: 'string' },
              postApiStatus: { type: 'integer' },
              postBodyLength: { type: 'number' },
              postProbe: { type: 'string' },
              postMessage: { type: 'string' },
              postCount: { type: 'number' },
              postNestedOk: { type: 'integer' },
              region: { type: 'string' },
              metadata: {
                type: 'object',
                properties: { source: { type: 'string' } },
              },
            },
          },
        },
      },
      {
        id: 'condition',
        type: 'condition',
        meta: { position: { x: 2520, y: 0 } },
        data: {
          title: 'API 状态条件',
          conditions: [
            {
              key: 'api_success',
              value: {
                left: { type: 'ref', content: ['variable', 'getApiStatus'] },
                operator: 'eq',
                right: { type: 'constant', content: 200 },
              },
            },
          ],
        },
      },
      {
        id: 'condition_success_marker',
        type: 'text',
        meta: { position: { x: 2380, y: -120 } },
        data: {
          title: '普通条件成功分支',
          inputsValues: { text: { type: 'constant', content: 'api_success' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'condition_else_marker',
        type: 'text',
        meta: { position: { x: 2380, y: 120 } },
        data: {
          title: '普通条件兜底分支',
          inputsValues: { text: { type: 'constant', content: 'else' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'multi_condition',
        type: 'multi-condition',
        meta: { position: { x: 2520, y: 0 } },
        data: {
          title: 'API 响应多条件',
          branch: [
            {
              key: 'branch.0',
              logic: 'and',
              conditions: [
                {
                  key: 'get_status_success',
                  value: {
                    left: { type: 'ref', content: ['variable', 'getApiStatus'] },
                    operator: 'eq',
                    right: { type: 'constant', content: 200 },
                  },
                },
                {
                  key: 'get_body_not_empty',
                  value: {
                    left: { type: 'ref', content: ['variable', 'getBodyLength'] },
                    operator: 'gt',
                    right: { type: 'constant', content: 0 },
                  },
                },
                {
                  key: 'post_status_success',
                  value: {
                    left: { type: 'ref', content: ['variable', 'postApiStatus'] },
                    operator: 'eq',
                    right: { type: 'constant', content: 200 },
                  },
                },
                {
                  key: 'post_body_not_empty',
                  value: {
                    left: { type: 'ref', content: ['variable', 'postBodyLength'] },
                    operator: 'gt',
                    right: { type: 'constant', content: 0 },
                  },
                },
                {
                  key: 'region_supported',
                  value: {
                    left: { type: 'ref', content: ['variable', 'region'] },
                    operator: 'in',
                    right: {
                      type: 'constant',
                      content: '["CN", "US"]',
                      schema: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                {
                  key: 'metadata_available',
                  value: {
                    left: { type: 'ref', content: ['variable', 'metadata'] },
                    operator: 'is_not_empty',
                  },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'multi_success_marker',
        type: 'text',
        meta: { position: { x: 2660, y: -120 } },
        data: {
          title: '多条件成功分支',
          inputsValues: { text: { type: 'constant', content: 'branch.0' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'multi_else_marker',
        type: 'text',
        meta: { position: { x: 2660, y: 120 } },
        data: {
          title: '多条件兜底分支',
          inputsValues: { text: { type: 'constant', content: 'else' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'batch',
        type: 'loop',
        meta: { position: { x: 2800, y: 0 } },
        data: {
          title: '数组批处理',
          loopFor: { type: 'ref', content: ['variable', 'items'] },
          loopOutputs: {
            doubled: { type: 'ref', content: ['batch_code', 'doubled'] },
          },
          outputs: {
            type: 'object',
            properties: {
              doubled: { type: 'array', items: { type: 'number' } },
            },
          },
        },
        blocks: [
          {
            id: 'batch_start',
            type: 'block-start',
            meta: { position: { x: 32, y: 0 } },
            data: {},
          },
          {
            id: 'batch_code',
            type: 'code',
            meta: { position: { x: 190, y: 0 } },
            data: {
              title: '逐项翻倍',
              inputsValues: {
                item: { type: 'ref', content: ['batch_locals', 'item'] },
                index: { type: 'ref', content: ['batch_locals', 'index'] },
              },
              inputs: {
                type: 'object',
                properties: {
                  item: { type: 'number' },
                  index: { type: 'number' },
                },
              },
              script: {
                language: 'javascript',
                content: 'function main({ params }) { return { doubled: params.item * 2 }; }',
              },
              outputs: {
                type: 'object',
                properties: { doubled: { type: 'number' } },
              },
            },
          },
          {
            id: 'batch_end',
            type: 'block-end',
            meta: { position: { x: 600, y: 0 } },
            data: {},
          },
        ],
        edges: [
          { sourceNodeID: 'batch_start', targetNodeID: 'batch_code' },
          { sourceNodeID: 'batch_code', targetNodeID: 'batch_end' },
        ],
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 3310, y: 0 } },
        data: {
          title: '结束',
          inputsValues: {
            result: { type: 'ref', content: ['batch', 'doubled'] },
            getApiStatus: { type: 'ref', content: ['variable', 'getApiStatus'] },
            getBodyLength: { type: 'ref', content: ['variable', 'getBodyLength'] },
            getProbe: { type: 'ref', content: ['variable', 'getProbe'] },
            getQuery: { type: 'ref', content: ['variable', 'getQuery'] },
            postApiStatus: { type: 'ref', content: ['variable', 'postApiStatus'] },
            postBodyLength: { type: 'ref', content: ['variable', 'postBodyLength'] },
            postProbe: { type: 'ref', content: ['variable', 'postProbe'] },
            postMessage: { type: 'ref', content: ['variable', 'postMessage'] },
            postCount: { type: 'ref', content: ['variable', 'postCount'] },
            postNestedOk: { type: 'ref', content: ['variable', 'postNestedOk'] },
            region: { type: 'ref', content: ['variable', 'region'] },
            conditionApiStatus: { type: 'ref', content: ['variable', 'getApiStatus'] },
            multiConditionBodyLength: { type: 'ref', content: ['variable', 'postBodyLength'] },
            modelText: { type: 'ref', content: ['model', 'result'] },
            text: { type: 'ref', content: ['text', 'text'] },
            imageUrl: { type: 'ref', content: ['image', 'url'] },
            videoUrl: { type: 'ref', content: ['video', 'url'] },
          },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'model' },
      { sourceNodeID: 'model', targetNodeID: 'text' },
      { sourceNodeID: 'text', targetNodeID: 'image' },
      { sourceNodeID: 'image', targetNodeID: 'video' },
      { sourceNodeID: 'video', targetNodeID: 'api_get' },
      { sourceNodeID: 'api_get', targetNodeID: 'api_post' },
      { sourceNodeID: 'api_post', targetNodeID: 'code' },
      { sourceNodeID: 'code', targetNodeID: 'variable' },
      { sourceNodeID: 'variable', targetNodeID: 'condition' },
      {
        sourceNodeID: 'condition',
        targetNodeID: 'condition_success_marker',
        sourcePortID: 'api_success',
      },
      { sourceNodeID: 'condition', targetNodeID: 'condition_else_marker', sourcePortID: 'else' },
      { sourceNodeID: 'condition_success_marker', targetNodeID: 'multi_condition' },
      { sourceNodeID: 'condition_else_marker', targetNodeID: 'multi_condition' },
      { sourceNodeID: 'multi_condition', targetNodeID: 'multi_success_marker', sourcePortID: 'branch.0' },
      { sourceNodeID: 'multi_condition', targetNodeID: 'multi_else_marker', sourcePortID: 'else' },
      { sourceNodeID: 'multi_success_marker', targetNodeID: 'batch' },
      { sourceNodeID: 'multi_else_marker', targetNodeID: 'batch' },
      { sourceNodeID: 'batch', targetNodeID: 'end' },
    ],
  };

  if (CONFIG.skipLlm) {
    workflow.nodes = workflow.nodes.filter((node) => node.id !== 'model');
    const textNode = workflow.nodes.find((node) => node.id === 'text');
    textNode.data.inputsValues.text.content = '输入：{{start.query}}';
    const endNode = workflow.nodes.find((node) => node.id === 'end');
    delete endNode.data.inputsValues.modelText;
    workflow.edges = workflow.edges.filter(
      (edge) => edge.sourceNodeID !== 'model' && edge.targetNodeID !== 'model',
    );
    workflow.edges.unshift({ sourceNodeID: 'start', targetNodeID: 'text' });
  }

  return workflow;
}

async function verifyArchive(outputs, nodeEvents, finished) {
  process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    module: 'CommonJS',
    moduleResolution: 'Node',
    esModuleInterop: true,
    target: 'ES2022',
    lib: ['ES2022', 'DOM'],
  });
  process.env.TS_NODE_TRANSPILE_ONLY = 'true';
  require(resolve(__dirname, '../gateway/node_modules/ts-node/register/transpile-only'));
  const JSZip = require(resolve(__dirname, '../demo-free-layout/node_modules/jszip'));
  const { createResultArchive } = require(resolve(
    __dirname,
    '../demo-free-layout/src/utils/result-archive.ts',
  ));
  const { zip } = createResultArchive({
    workflowName: '富节点真实全链路',
    status: '执行成功',
    inputs: { query: FULL_CHAIN_QUERY },
    text: outputs.modelText || outputs.text,
    outputs,
    nodes: nodeEvents.map((event) => event.data),
    statistics: {
      totalSteps: finished.data?.total_steps,
      elapsedTime: finished.data?.elapsed_time,
      totalTokens: finished.data?.total_tokens,
    },
  });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const loaded = await JSZip.loadAsync(buffer);
  const expectedFiles = [
    'manifest.json',
    '结果摘要.md',
    '完整结果.json',
    '节点执行记录.json',
    '工作流输入.json',
    '文本输出.txt',
    '工作流输出.json',
  ];
  assert.deepEqual(Object.keys(loaded.files).sort(), expectedFiles.sort());
  assert.equal(
    await loaded.file('文本输出.txt').async('string'),
    outputs.modelText || outputs.text,
  );
  const archivedOutputs = JSON.parse(await loaded.file('工作流输出.json').async('string'));
  assert.deepEqual(archivedOutputs.result, [2, 4, 6]);
  return buffer.length;
}

async function run() {
  if (!CONFIG.adminAccount || !CONFIG.adminPassword) {
    throw new Error('缺少网关管理员账号配置，无法执行富节点全链路测试');
  }

  const health = await requestJson('/healthz');
  assert.equal(health.status, 'ok', '网关健康检查未通过');

  const login = await requestJson('/auth/login', {
    method: 'POST',
    body: { account: CONFIG.adminAccount, password: CONFIG.adminPassword },
    expected: [201],
  });
  state.adminToken = login.accessToken;
  assert.ok(state.adminToken, '管理员登录未返回访问令牌');
  assert.ok(['pro', 'enterprise'].includes(login.user?.vipLevel), '全链路账号不是专业版');

  const difyAuthorization = CONFIG.difyAdminPassword
    ? {
      email: CONFIG.difyAdminEmail,
      password: CONFIG.difyAdminPassword,
      consoleBase: CONFIG.difyConsoleBase,
    }
    : CONFIG.difyConsoleToken
      ? {
        consoleToken: CONFIG.difyConsoleToken,
        consoleBase: CONFIG.difyConsoleBase,
      }
      : null;
  if (!difyAuthorization) {
    throw new Error('缺少 Dify 管理员密码或 Console Token，无法验证真实发布链路');
  }
  const validation = await requestJson('/admin/dify/validate-authorization', {
    method: 'POST',
    token: state.adminToken,
    body: difyAuthorization,
    expected: [201],
    timeoutMs: 60_000,
  });
  assert.equal(validation.authorized, true, 'Dify Console 授权验证失败');
  const authorizationStatus = await requestJson('/admin/dify/bootstrap', {
    method: 'POST',
    token: state.adminToken,
    body: difyAuthorization,
    expected: [201],
    timeoutMs: 60_000,
  });
  assert.equal(authorizationStatus.connectionAuthorized, true, 'Dify Console 授权保存失败');
  if (!CONFIG.skipLlm) {
    assert.ok(
      ['active', 'configured'].includes(authorizationStatus.modelProvider?.status),
      authorizationStatus.modelProvider?.message
        || 'Dify 模型 Provider 未就绪，无法执行真实 LLM 链路',
    );
  }

  const key = await requestJson('/user/api-keys', {
    method: 'POST',
    token: state.adminToken,
    body: { name: `富节点全链路-${Date.now()}` },
    expected: [201],
  });
  state.apiKey = key.plaintext;
  state.apiKeyId = key.id;
  assert.match(state.apiKey, /^ff-[a-f0-9]{32}$/i, '平台 API Key 格式不正确');

  const workflow = await requestJson('/workflows', {
    method: 'POST',
    token: state.adminToken,
    body: {
      name: `富节点真实全链路-${Date.now()}`,
      description: '自动验证模型、内容、媒体、API、代码、变量、条件分支与数组批处理',
      flowgram: JSON.stringify(buildWorkflow()),
    },
    expected: [201],
  });
  state.workflowId = workflow.id;
  assert.ok(state.workflowId, '创建工作流未返回 ID');

  const published = await requestJson(`/workflows/${state.workflowId}/publish`, {
    method: 'POST',
    token: state.adminToken,
    body: {},
    expected: [201],
    timeoutMs: 180_000,
  });
  state.publishedVersion = published.workflow?.publishedVersion;
  state.difyAppId = published.dify?.appId;
  assert.ok(
    Number.isInteger(state.publishedVersion) && state.publishedVersion >= 1,
    '发布接口未返回有效的 publishedVersion',
  );
  assert.equal(published.dify?.status, 'synced', published.dify?.message || 'Dify 同步失败');
  assert.ok(state.difyAppId, 'Dify 同步未返回临时应用 ID');

  const apiCredentialMarker = `ff-sensitive-full-chain-${randomUUID()}`;
  const idempotencyKey = `full-chain-${state.workflowId}-v${state.publishedVersion}-${Date.now()}`;
  const response = await fetchWithTimeout(
    `${CONFIG.gatewayUrl}/workflows/${state.workflowId}/execute`,
    {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        inputs: {
          query: FULL_CHAIN_QUERY,
          apiToken: apiCredentialMarker,
        },
        publishedVersion: state.publishedVersion,
      }),
    },
    240_000,
  );
  const streamBody = await response.text();
  const parsedForLeakAudit = parseSseEvents(streamBody);
  const leakedPaths = parsedForLeakAudit.flatMap((event, index) => (
    findSensitiveValuePaths(event, apiCredentialMarker, `$events[${index}]`)
  ));
  assert.equal(
    streamBody.includes(apiCredentialMarker),
    false,
    `API Bearer 凭据泄漏到了原始 SSE 数据流；字段路径：${leakedPaths.join(', ') || '无法解析'}`,
  );
  assert.equal(response.status, 200, `运行接口返回 ${response.status}：${streamBody.slice(0, 300)}`);
  assert.match(
    response.headers.get('content-type') || '',
    /^text\/event-stream(?:;|$)/i,
    '运行接口未返回 text/event-stream',
  );
  const events = parseSseEvents(streamBody);
  const { finished, nodeEvents } = validateExecutionEvents(events);

  const outputs = finished.data?.outputs || {};
  assert.deepEqual(outputs.result, [2, 4, 6], '数组批处理结果不正确');
  assert.equal(outputs.getApiStatus, 200, 'API GET 请求未返回 200');
  assert.ok(Number(outputs.getBodyLength) > 0, 'API GET 响应正文为空');
  assert.equal(outputs.getProbe, API_ECHO_CONTRACT.getProbe, 'API GET 查询参数 probe 未原样送达');
  assert.equal(outputs.getQuery, FULL_CHAIN_QUERY, 'API GET 变量查询参数 query 未原样送达');
  assert.equal(outputs.postApiStatus, 200, 'API POST 请求未返回 200');
  assert.ok(Number(outputs.postBodyLength) > 0, 'API POST 响应正文为空');
  assert.equal(outputs.postProbe, API_ECHO_CONTRACT.postProbe, 'API POST JSON 字段 probe 未原样送达');
  assert.equal(outputs.postMessage, FULL_CHAIN_QUERY, 'API POST JSON 变量字段 message 未原样送达');
  assert.equal(outputs.postCount, API_ECHO_CONTRACT.postCount, 'API POST JSON 数值字段 count 不正确');
  assert.equal(outputs.postNestedOk, 1, 'API POST JSON 嵌套布尔字段 nested.ok 不正确');
  assert.equal(outputs.region, 'CN', 'UI JSON 数组形式的“属于”条件没有收到预期地区值');
  assert.equal(outputs.conditionApiStatus, 200, '普通条件节点没有收到确定的 API 200 状态');
  assert.ok(
    Number(outputs.multiConditionBodyLength) > 0,
    '多条件节点没有收到确定的非空 API 正文长度',
  );
  assert.equal(outputs.imageUrl, 'https://example.com/futureflow-image.png');
  assert.equal(outputs.videoUrl, 'https://example.com/futureflow-video.mp4');
  if (!CONFIG.skipLlm) {
    assert.equal(typeof outputs.modelText, 'string');
    assert.ok(outputs.modelText.trim(), '真实模型输出为空');
  }
  assert.equal(typeof outputs.text, 'string');
  assert.match(outputs.text, /输入：/);
  if (!CONFIG.skipLlm) assert.match(outputs.text, /模型：/);

  const failedNode = nodeEvents.find((event) => event.data?.status !== 'succeeded');
  assert.equal(
    failedNode,
    undefined,
    `存在失败节点：${failedNode?.data?.title || failedNode?.data?.node_id || '未知节点'}`,
  );
  const expectedNodeIds = [
    'start',
    'text',
    'image',
    'video',
    'api_get',
    'api_post',
    'code',
    'variable',
    'condition',
    'condition_success_marker',
    'multi_condition',
    'multi_success_marker',
    'batch_code',
    'end',
  ];
  if (!CONFIG.skipLlm) expectedNodeIds.splice(1, 0, 'model');
  for (const nodeId of expectedNodeIds) {
    const matchingEvents = nodeEvents.filter((event) => event.data?.node_id === nodeId);
    assert.ok(matchingEvents.length > 0, `缺少节点成功事件：${nodeId}`);
    if (nodeId !== 'batch_code') {
      assert.equal(matchingEvents.length, 1, `节点 ${nodeId} 不应重复执行`);
    }
  }
  for (const nodeId of ['condition_else_marker', 'multi_else_marker']) {
    assert.equal(
      nodeEvents.filter((event) => event.data?.node_id === nodeId).length,
      0,
      `未命中的兜底分支仍被执行：${nodeId}`,
    );
  }
  const expectedConditionSelections = {
    condition: 'api_success',
    multi_condition: 'branch.0',
  };
  const conditionSelections = {};
  for (const [nodeId, selectedCaseId] of Object.entries(expectedConditionSelections)) {
    const matchingConditionEvents = nodeEvents.filter((event) => event.data?.node_id === nodeId);
    assert.equal(matchingConditionEvents.length, 1, `${nodeId} 条件节点不应重复执行`);
    const conditionEvent = matchingConditionEvents[0];
    assert.equal(conditionEvent?.data?.node_type, 'if-else', `${nodeId} 没有作为 Dify 条件节点实跑`);
    assert.equal(conditionEvent?.data?.status, 'succeeded', `${nodeId} 条件节点执行失败`);
    assert.equal(
      conditionEvent?.data?.outputs?.selected_case_id,
      selectedCaseId,
      `${nodeId} 没有命中预期条件分支`,
    );
    conditionSelections[nodeId] = conditionEvent.data.outputs.selected_case_id;
  }
  assert.equal(
    nodeEvents.filter((event) => event.data?.node_id === 'batch_code').length,
    3,
    '数组批处理必须且只能执行三项',
  );

  const archiveBytes = await verifyArchive(outputs, nodeEvents, finished);
  const runs = await requestJson(`/workflows/${state.workflowId}/runs`, {
    token: state.adminToken,
  });
  assert.ok(Array.isArray(runs.items), '运行记录响应缺少 items 数组');
  assert.ok(runs.total >= 1, '全链路运行记录未保存');
  assert.equal(runs.page, 1, '运行记录页码不正确');
  assert.equal(runs.pageSize, 30, '运行记录分页大小不正确');
  assert.equal(runs.items[0]?.status, 'succeeded', runs.items[0]?.errorMessage || '运行记录不是成功状态');
  assert.equal(runs.items[0]?.totalSteps, finished.data?.total_steps, '运行记录步骤数与 SSE 不一致');
  assert.equal(runs.items[0]?.totalTokens, finished.data?.total_tokens, '运行记录 Token 数与 SSE 不一致');

  console.log(JSON.stringify({
    status: '通过',
    mode: CONFIG.skipLlm ? '非模型富节点链路' : '完整模型链路',
    workflowStatus: finished.data.status,
    apiStatus: {
      get: outputs.getApiStatus,
      post: outputs.postApiStatus,
    },
    apiEcho: {
      getProbe: outputs.getProbe,
      getQuery: outputs.getQuery,
      postProbe: outputs.postProbe,
      postMessage: outputs.postMessage,
      postCount: outputs.postCount,
      postNestedOk: outputs.postNestedOk,
    },
    conditionSelections,
    batchResult: outputs.result,
    successfulNodeEvents: nodeEvents.length,
    totalSteps: finished.data?.total_steps,
    totalTokens: finished.data?.total_tokens,
    archiveBytes,
  }, null, 2));
}

async function loginDifyConsoleForCleanup() {
  if (!CONFIG.difyAdminPassword) return null;
  const response = await fetchWithTimeout(`${CONFIG.difyConsoleBase}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CONFIG.difyAdminEmail,
      password: CONFIG.difyAdminPassword,
      remember_me: true,
      language: 'zh-Hans',
    }),
  }, 30_000);
  const raw = await response.text();
  let result;
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = {};
  }
  const token = result.data?.access_token;
  if (!response.ok || !token) {
    throw new Error(`Dify Console 登录失败（HTTP ${response.status}）`);
  }
  return token;
}

async function deleteDifyTestApp() {
  let token = CONFIG.difyConsoleToken || await loginDifyConsoleForCleanup();
  if (!token) {
    throw new Error('缺少 DIFY_CONSOLE_TOKEN 或 DIFY_ADMIN_PASSWORD');
  }

  const remove = (authorization) => fetchWithTimeout(
    `${CONFIG.difyConsoleBase}/apps/${encodeURIComponent(state.difyAppId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authorization}` },
    },
    30_000,
  );

  let response = await remove(token);
  if (
    (response.status === 401 || response.status === 403)
    && CONFIG.difyAdminPassword
  ) {
    token = await loginDifyConsoleForCleanup();
    response = await remove(token);
  }
  if (![200, 204, 404].includes(response.status)) {
    const detail = await response.text();
    throw new Error(`返回 ${response.status}：${detail.slice(0, 200)}`);
  }
}

async function assertDifyTestAppDeleted() {
  let token = CONFIG.difyConsoleToken || await loginDifyConsoleForCleanup();
  if (!token) {
    throw new Error('缺少 DIFY_CONSOLE_TOKEN 或 DIFY_ADMIN_PASSWORD');
  }

  const inspect = (authorization) => fetchWithTimeout(
    `${CONFIG.difyConsoleBase}/apps/${encodeURIComponent(state.difyAppId)}`,
    { headers: { Authorization: `Bearer ${authorization}` } },
    30_000,
  );

  let response = await inspect(token);
  if (
    (response.status === 401 || response.status === 403)
    && CONFIG.difyAdminPassword
  ) {
    token = await loginDifyConsoleForCleanup();
    response = await inspect(token);
  }
  if (response.status === 404) return;
  if (response.ok) {
    throw new Error('平台工作流已删除，但对应 Dify 应用仍然存在');
  }
  throw new Error(`检查 Dify 应用清理状态失败（HTTP ${response.status}）`);
}

async function assertPlatformBindingDeleted() {
  const status = await requestJson('/admin/dify/status', { token: state.adminToken });
  const residual = (status.managedWorkflowApps || []).some(
    (binding) => binding.workflowId === state.workflowId,
  );
  assert.equal(residual, false, '平台工作流删除后仍残留活跃 Dify 绑定');
}

async function cleanup() {
  const failures = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}：${error.message}`);
    }
  };

  let workflowDeleted = false;
  if (state.workflowId && state.adminToken) {
    try {
      await requestJson(`/workflows/${state.workflowId}`, {
        method: 'DELETE',
        token: state.adminToken,
      });
      workflowDeleted = true;
    } catch (error) {
      failures.push(`删除平台测试工作流：${error.message}`);
    }
  }
  if (workflowDeleted) {
    await attempt('验证平台 Dify 绑定已清理', assertPlatformBindingDeleted);
  }
  if (state.difyAppId) {
    if (workflowDeleted) {
      try {
        await assertDifyTestAppDeleted();
      } catch (error) {
        failures.push(`验证 Dify 临时应用已清理：${error.message}`);
        await attempt('回退删除 Dify 临时应用', deleteDifyTestApp);
      }
    } else {
      await attempt('回退删除 Dify 临时应用', deleteDifyTestApp);
    }
  }
  if (state.apiKeyId && state.adminToken) {
    await attempt('删除平台 API Key', () => requestJson(`/user/api-keys/${state.apiKeyId}`, {
      method: 'DELETE',
      token: state.adminToken,
    }));
  }
  return failures;
}

async function main() {
  let primaryError;
  try {
    await run();
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = await cleanup();
  if (cleanupFailures.length) {
    console.error(`清理失败：\n- ${cleanupFailures.join('\n- ')}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupFailures.length) throw new Error('全链路通过，但临时资源未完整清理');
}

module.exports = {
  buildWorkflow,
  parseSseEvents,
  validateExecutionEvents,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
