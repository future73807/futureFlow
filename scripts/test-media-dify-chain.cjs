#!/usr/bin/env node

/**
 * 发布态媒体桥验收（受控失败路径）。
 *
 * 使用临时、无效的 OpenAI 凭据发布并运行一个原生图片节点。HTTP 网关节点应
 * 成功收到 Dify 的短期令牌并返回受控 failed job，随后解析节点按设计失败。
 * 因此它不会生成媒体或消耗供应商额度，但能真实覆盖：
 * futureFlow 发布 → Dify HTTP 节点 → SSRF 代理 → 媒体网关 → 凭据解密 →
 * 供应商失败归一化 → Dify 解析节点。
 */

const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseSseEvents } = require('./full-chain-test.cjs');

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

const CONFIG = {
  gatewayUrl: (process.env.GATEWAY_URL
    || `http://127.0.0.1:${process.env.GATEWAY_PORT || '3001'}`).replace(/\/+$/, ''),
  adminAccount: process.env.GATEWAY_BOOTSTRAP_ADMIN_USERNAME,
  adminPassword: process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD,
  difyConsoleBase: (process.env.DIFY_CONSOLE_BASE || 'http://127.0.0.1:5001/console/api')
    .replace(/\/+$/, ''),
  difyConsoleToken: process.env.DIFY_CONSOLE_TOKEN,
  difyAdminEmail: process.env.DIFY_ADMIN_EMAIL || 'admin@futureflow.local',
  difyAdminPassword: process.env.DIFY_ADMIN_PASSWORD,
};

const state = {
  adminToken: '',
  workflowId: '',
  credentialId: '',
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    expected = [200],
    timeoutMs,
  } = options;
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
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!expected.includes(response.status)) {
    const message = typeof payload?.message === 'string'
      ? payload.message.slice(0, 180)
      : `HTTP ${response.status}`;
    throw new Error(`${method} ${path} 失败：${message}`);
  }
  return payload;
}

function nativeImageFlow(credentialId) {
  const outputs = {
    jobId: { type: 'string', title: '媒体任务 ID' },
    assetId: { type: 'string', title: '媒体资产 ID' },
    url: { type: 'string', title: '资源地址' },
    provider: { type: 'string', title: '生成服务' },
    model: { type: 'string', title: '模型' },
    taskId: { type: 'string', title: '供应商任务 ID' },
    status: { type: 'string', title: '生成状态' },
  };
  return {
    nodes: [
      {
        id: 'media_start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: {
          title: '开始',
          inputsValues: {
            prompt: { type: 'constant', content: '用于验证受控媒体网关的测试图片' },
          },
          outputs: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string', title: '生成提示词' } },
          },
        },
      },
      {
        id: 'media_image',
        type: 'image',
        meta: { position: { x: 320, y: 0 } },
        data: {
          title: '原生图片生成（受控验收）',
          media: {
            mode: 'generate',
            operation: 'generate',
            provider: 'openai',
            credentialId,
            model: 'gpt-image-1',
            size: '1024x1024',
            aspectRatio: '1:1',
          },
          inputsValues: {
            prompt: { type: 'ref', content: ['media_start', 'prompt'] },
            caption: { type: 'constant', content: '受控验收输出' },
          },
          inputs: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              caption: { type: 'string' },
            },
          },
          outputs: { type: 'object', properties: outputs },
        },
      },
      {
        id: 'media_end',
        type: 'end',
        meta: { position: { x: 640, y: 0 } },
        data: {
          title: '结束',
          inputsValues: {
            status: { type: 'ref', content: ['media_image', 'status'] },
            jobId: { type: 'ref', content: ['media_image', 'jobId'] },
          },
          inputs: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              jobId: { type: 'string' },
            },
          },
          outputs: { type: 'object', properties: {} },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'media_start', targetNodeID: 'media_image' },
      { sourceNodeID: 'media_image', targetNodeID: 'media_end' },
    ],
  };
}

function findNodeEvent(events, nodeId) {
  return events.find((event) => event.event === 'node_finished' && event.data?.node_id === nodeId);
}

function httpDiagnostic(node, keyMarker) {
  const outputs = node?.data?.outputs || {};
  let body = outputs.body;
  if (typeof body !== 'string') {
    try {
      body = JSON.stringify(body ?? '');
    } catch {
      body = '';
    }
  }
  const safeBody = String(body)
    .replaceAll(keyMarker, '[已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [已隐藏]')
    .slice(0, 360);
  return `HTTP ${outputs.statusCode ?? outputs.status_code ?? '未知'}，响应：${safeBody || '（空）'}`;
}

async function cleanup() {
  const failures = [];
  const attempt = async (label, work) => {
    try {
      await work();
    } catch (error) {
      failures.push(`${label}：${error.message}`);
    }
  };

  if (state.workflowId) {
    await attempt('删除临时媒体工作流', () => requestJson(`/workflows/${state.workflowId}`, {
      method: 'DELETE', token: state.adminToken, expected: [200], timeoutMs: 90_000,
    }));
  }
  if (state.credentialId) {
    await attempt('删除临时媒体凭据', () => requestJson(`/media/credentials/${state.credentialId}`, {
      method: 'DELETE', token: state.adminToken, expected: [200],
    }));
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

async function main() {
  if (!CONFIG.adminAccount || !CONFIG.adminPassword) {
    throw new Error('缺少网关管理员账号配置，无法执行媒体发布态验收');
  }

  const login = await requestJson('/auth/login', {
    method: 'POST',
    body: { account: CONFIG.adminAccount, password: CONFIG.adminPassword },
    expected: [201],
  });
  state.adminToken = login.accessToken;
  assert.ok(state.adminToken, '管理员登录未返回访问令牌');

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
    throw new Error('缺少 Dify 管理员密码或 Console Token，无法验证发布态媒体桥');
  }
  const validated = await requestJson('/admin/dify/validate-authorization', {
    method: 'POST', token: state.adminToken, body: difyAuthorization, expected: [201], timeoutMs: 60_000,
  });
  assert.equal(validated.authorized, true, 'Dify Console 授权校验失败');
  const bootstrapped = await requestJson('/admin/dify/bootstrap', {
    method: 'POST', token: state.adminToken, body: difyAuthorization, expected: [201], timeoutMs: 60_000,
  });
  assert.equal(bootstrapped.connectionAuthorized, true, 'Dify Console 授权保存失败');

  const dify = await requestJson('/admin/dify/status', { token: state.adminToken });
  assert.equal(dify.connectionAuthorized, true, 'Dify Console 连接未授权');

  // 这是专门用于拒绝路径的随机字符串，不是任何真实供应商 Key。
  const invalidKey = `futureflow-invalid-media-probe-${randomUUID()}`;
  const credential = await requestJson('/media/credentials', {
    method: 'POST',
    token: state.adminToken,
    body: {
      provider: 'openai',
      label: `Dify 媒体桥受控验收 ${Date.now()}`,
      apiKey: invalidKey,
    },
    expected: [201],
  });
  state.credentialId = credential.id;
  assert.match(state.credentialId, /^[0-9a-f-]{36}$/i, '媒体凭据未返回 UUID');
  assert.equal(JSON.stringify(credential).includes(invalidKey), false, '媒体凭据响应泄漏了访问密钥');

  const workflow = await requestJson('/workflows', {
    method: 'POST',
    token: state.adminToken,
    body: {
      name: `Dify 原生媒体桥验收-${Date.now()}`,
      description: '受控失败路径：验证 Dify 到媒体网关的真实调用，不生成媒体。',
      flowgram: JSON.stringify(nativeImageFlow(state.credentialId)),
    },
    expected: [201],
  });
  state.workflowId = workflow.id;
  assert.match(state.workflowId, /^[0-9a-f-]{36}$/i, '工作流未返回 UUID');

  const published = await requestJson(`/workflows/${state.workflowId}/publish`, {
    method: 'POST',
    token: state.adminToken,
    body: {},
    expected: [201],
    timeoutMs: 180_000,
  });
  const publishedVersion = published.workflow?.publishedVersion;
  assert.ok(Number.isInteger(publishedVersion) && publishedVersion >= 1, '媒体工作流未成功发布');
  assert.equal(published.dify?.status, 'synced', published.dify?.message || 'Dify 导入失败');

  const execution = await fetchWithTimeout(
    `${CONFIG.gatewayUrl}/workflows/${state.workflowId}/execute`,
    {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.adminToken}`,
        'Idempotency-Key': `media-dify-probe-${randomUUID()}`,
      },
      body: JSON.stringify({
        inputs: { prompt: '用于验证受控媒体网关的测试图片' },
        publishedVersion,
      }),
    },
    240_000,
  );
  const stream = await execution.text();
  assert.equal(execution.status, 200, `媒体工作流未返回 SSE：${execution.status}`);
  assert.equal(stream.includes(invalidKey), false, '媒体访问密钥泄漏到了执行事件');
  const events = parseSseEvents(stream);
  const httpNode = events.find((event) => (
    event.event === 'node_finished'
    && String(event.data?.node_id || '').startsWith('__futureflow_media_request_')
  ));
  assert.equal(httpNode?.data?.status, 'succeeded', 'Dify 未成功访问受控媒体网关');
  assert.equal(
    Number(httpNode?.data?.outputs?.statusCode ?? httpNode?.data?.outputs?.status_code),
    201,
    `媒体网关没有接收到有效生成请求：${httpDiagnostic(httpNode, invalidKey)}`,
  );
  const mediaResponse = httpNode?.data?.outputs?.body;
  const mediaResponseText = typeof mediaResponse === 'string'
    ? mediaResponse
    : JSON.stringify(mediaResponse ?? '');
  assert.match(
    mediaResponseText,
    /"status"\s*:\s*"failed"/,
    `网关未将供应商拒绝归一化为 failed：${httpDiagnostic(httpNode, invalidKey)}`,
  );
  assert.equal(mediaResponseText.includes(invalidKey), false, '媒体网关响应泄漏了访问密钥');

  const parserNode = findNodeEvent(events, 'media_image');
  assert.equal(parserNode?.data?.status, 'failed', '受控的供应商拒绝应由媒体解析节点失败呈现');
  assert.match(
    String(parserNode?.data?.error || parserNode?.data?.error_message || ''),
    /媒体生成任务失败|媒体网关请求失败|模型|服务额度|节点执行失败/,
    '解析节点未将网关返回的 failed 状态呈现为失败',
  );
  const finished = events.find((event) => event.event === 'workflow_finished');
  assert.equal(finished?.data?.status, 'failed', '受控失败路径不应被误报为生成成功');

  console.log(JSON.stringify({
    status: '通过',
    coverage: [
      '发布态 Dify 导入',
      'Dify HTTP 节点到受控媒体网关',
      '短期媒体令牌认证',
      '加密凭据读取与供应商拒绝归一化',
      'Dify 解析节点失败传播',
    ],
    generatedMedia: false,
    expectedProviderResult: 'provider_rejected',
  }, null, 2));
}

let primaryError;
main().catch((error) => {
  primaryError = error;
}).finally(async () => {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!primaryError) primaryError = cleanupError;
    else console.error(`清理失败：${cleanupError.message}`);
  }
  if (primaryError) {
    console.error(primaryError);
    process.exitCode = 1;
  }
});
