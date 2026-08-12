import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { FlowGramJSON, FlowInputValue, FlowNodeJSON } from './types';

export const MEDIA_RUN_TOKEN_INPUT = '__futureflow_media_token';

export const NATIVE_MEDIA_OUTPUTS = {
  jobId: { type: 'string', title: '媒体任务 ID' },
  assetId: { type: 'string', title: '媒体资产 ID' },
  url: { type: 'string', title: '内部资源地址' },
  poster: { type: 'string', title: '视频封面' },
  caption: { type: 'string', title: '说明文字' },
  mediaType: { type: 'string', title: '媒体类型' },
  provider: { type: 'string', title: '生成服务' },
  model: { type: 'string', title: '模型' },
  taskId: { type: 'string', title: '供应商任务 ID' },
  status: { type: 'string', title: '任务状态' },
  mimeType: { type: 'string', title: '文件类型' },
  byteSize: { type: 'number', title: '文件大小' },
  sha256: { type: 'string', title: '文件校验值' },
} as const;

const PROVIDERS = new Set(['openai', 'google', 'doubao', 'minimax']);
const MEDIA_MODES = new Set(['passthrough', 'generate']);
const VIDEO_OPERATIONS = new Set(['create', 'query']);
const CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isNativeMediaNode(node: FlowNodeJSON): boolean {
  return (node.type === 'image' || node.type === 'video')
    && node.data?.media?.mode === 'generate';
}

export function mediaIdempotencyInputName(nodeId: string): string {
  const digest = createHash('sha256').update(nodeId, 'utf8').digest('hex').slice(0, 16);
  // Dify 0.15.x limits every template variable segment to 30 characters.
  // Keep this internal start-node input below that boundary so the
  // Idempotency-Key header is interpolated rather than sent literally.
  return `__ffmi_${digest}`;
}

export function collectNativeMediaCredentialIds(flowgram: FlowGramJSON): string[] {
  return Array.from(new Set(
    flowgram.nodes
      .filter(isNativeMediaNode)
      .map((node) => String(node.data.media?.credentialId || '').trim())
      .filter(Boolean),
  ));
}

export function validateNativeMediaNode(node: FlowNodeJSON): void {
  if (node.type !== 'image' && node.type !== 'video') return;
  const media = node.data.media || { mode: 'passthrough' };
  const mode = String(media.mode || 'passthrough');
  if (!MEDIA_MODES.has(mode)) {
    throw new BadRequestException(`媒体节点 ${node.id} 的运行模式无效`);
  }
  if (mode !== 'generate') return;

  const provider = String(media.provider || '');
  if (!PROVIDERS.has(provider)) {
    throw new BadRequestException(`媒体节点 ${node.id} 请选择支持的生成服务`);
  }
  const credentialId = String(media.credentialId || '').trim();
  if (!CREDENTIAL_ID.test(credentialId)) {
    throw new BadRequestException(`媒体节点 ${node.id} 请选择有效的服务凭据`);
  }
  if (!String(media.model || '').trim()) {
    throw new BadRequestException(`媒体节点 ${node.id} 的模型不能为空`);
  }

  const operation = node.type === 'video' ? String(media.operation || 'create') : 'create';
  if (node.type === 'video' && !VIDEO_OPERATIONS.has(operation)) {
    throw new BadRequestException(`视频节点 ${node.id} 的任务动作无效`);
  }
  const requiredInput = operation === 'query' ? 'taskId' : 'prompt';
  if (!hasFlowValue(node.data.inputsValues?.[requiredInput])) {
    throw new BadRequestException(
      `媒体节点 ${node.id} 的${requiredInput === 'taskId' ? '媒体任务 ID' : '生成提示词'}不能为空`,
    );
  }
}

function hasFlowValue(value: any): boolean {
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value).trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'ref') {
    return Array.isArray(value.content)
      && value.content.length >= 2
      && value.content.every((part: unknown) => String(part).trim().length > 0);
  }
  return value.content !== undefined
    && value.content !== null
    && String(value.content).trim().length > 0;
}

function flowValueTemplate(value: FlowInputValue | undefined): string {
  if (!value) return '';
  if (value.type === 'ref' && Array.isArray(value.content)) {
    return `{{${value.content.map(String).join('.')}}}`;
  }
  return String(value.content ?? '');
}

function optionalMediaSetting(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized && normalized.toLowerCase() !== 'auto' ? normalized : undefined;
}

function gatewayBaseUrl(): string {
  const explicit = String(process.env.DIFY_MEDIA_GATEWAY_URL || '').trim();
  const port = String(
    process.env.DIFY_MEDIA_GATEWAY_PORT
      || process.env.GATEWAY_PORT
      || '3001',
  ).trim();
  const fallback = `http://host.docker.internal:${port}`;
  const raw = (explicit || fallback).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException('DIFY_MEDIA_GATEWAY_URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BadRequestException('DIFY_MEDIA_GATEWAY_URL 必须是无内嵌凭据的 HTTP(S) 地址');
  }
  return raw;
}

function buildRequestBody(node: FlowNodeJSON): string {
  const media = node.data.media || {};
  const values = node.data.inputsValues || {};
  const body: Record<string, unknown> = {
    credentialId: String(media.credentialId || ''),
    model: String(media.model || ''),
    prompt: flowValueTemplate(values.prompt),
  };
  const size = optionalMediaSetting(media.size);
  const aspectRatio = optionalMediaSetting(media.aspectRatio);
  const resolution = optionalMediaSetting(media.resolution);
  if (size) body.size = size;
  if (aspectRatio) body.aspectRatio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (media.durationSeconds !== undefined && media.durationSeconds !== null) {
    body.durationSeconds = Number(media.durationSeconds);
  }
  if (media.quality) body.quality = String(media.quality);
  return JSON.stringify(body);
}

function parserScript(mediaType: 'image' | 'video'): string {
  return `function main({ params }) {
  const httpStatus = Number(params.statusCode || 0);
  let payload = params.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error('媒体网关返回了无法解析的结果');
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('媒体网关返回了空结果');
  }
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    throw new Error('媒体网关请求失败（HTTP ' + (Number.isFinite(httpStatus) ? httpStatus : '未知状态') + '）');
  }
  const status = String(payload.status || '').toLowerCase();
  if (!['queued', 'processing', 'succeeded', 'failed'].includes(status)) {
    throw new Error('媒体网关返回缺少有效任务状态');
  }
  if (status === 'failed') {
    throw new Error('媒体生成任务失败，请检查模型、提示词或服务额度');
  }
  return {
    jobId: String(payload.id || payload.jobId || ''),
    assetId: String(payload.assetId || ''),
    url: String(payload.assetUrl || payload.url || ''),
    poster: String(payload.poster || ''),
    caption: String(params.caption || ''),
    mediaType: ${JSON.stringify(mediaType)},
    provider: String(payload.provider || params.provider || ''),
    model: String(payload.model || params.model || ''),
    taskId: String(payload.taskId || ''),
    status,
    mimeType: String(payload.mimeType || ''),
    byteSize: Number(payload.byteSize || payload.sizeBytes || 0),
    sha256: String(payload.sha256 || '')
  };
}`;
}

function uniqueInternalNodeId(nodeId: string, existingIds: Set<string>): string {
  const digest = createHash('sha256').update(nodeId, 'utf8').digest('hex').slice(0, 16);
  const base = `__futureflow_media_request_${digest}`;
  let candidate = base;
  let suffix = 1;
  while (existingIds.has(candidate)) candidate = `${base}_${suffix++}`;
  existingIds.add(candidate);
  return candidate;
}

/**
 * Native media is represented in the saved canvas as one semantic node. For
 * Dify 0.15.3 it expands to a trusted Gateway HTTP call plus a synchronous
 * parser node. Provider credentials stay encrypted in Gateway storage; Dify
 * only receives a short-lived execution token at invocation time.
 */
export function prepareNativeMediaNodes(flowgram: FlowGramJSON): FlowGramJSON {
  const mediaNodes = flowgram.nodes.filter(isNativeMediaNode);
  if (mediaNodes.length === 0) return flowgram;
  const start = flowgram.nodes.find((node) => node.type === 'start');
  if (!start) throw new BadRequestException('原生媒体节点需要开始节点');

  const copied = JSON.parse(JSON.stringify(flowgram)) as FlowGramJSON;
  const copiedStart = copied.nodes.find((node) => node.id === start.id)!;
  copiedStart.data.outputs = copiedStart.data.outputs || { type: 'object', properties: {} };
  copiedStart.data.outputs.properties = { ...(copiedStart.data.outputs.properties || {}) };
  copiedStart.data.outputs.required = Array.from(new Set([
    ...(copiedStart.data.outputs.required || []),
    MEDIA_RUN_TOKEN_INPUT,
    ...mediaNodes
      .filter((node) => node.type !== 'video' || String(node.data.media?.operation || 'create') === 'create')
      .map((node) => mediaIdempotencyInputName(node.id)),
  ]));
  copiedStart.data.outputs.properties[MEDIA_RUN_TOKEN_INPUT] = {
    type: 'string',
    title: '媒体执行令牌',
  };

  const existingIds = new Set(copied.nodes.map((node) => node.id));
  const requestIds = new Map<string, string>();
  for (const original of mediaNodes) {
    const requestId = uniqueInternalNodeId(original.id, existingIds);
    requestIds.set(original.id, requestId);
    if (original.type !== 'video' || String(original.data.media?.operation || 'create') === 'create') {
      const idemName = mediaIdempotencyInputName(original.id);
      copiedStart.data.outputs.properties[idemName] = {
        type: 'string',
        title: '媒体幂等标识',
      };
    }
  }

  const expandedNodes: FlowNodeJSON[] = [];
  for (const node of copied.nodes) {
    if (!isNativeMediaNode(node)) {
      expandedNodes.push(node);
      continue;
    }
    const mediaType = node.type as 'image' | 'video';
    const media = node.data.media || {};
    const operation = mediaType === 'video' ? String(media.operation || 'create') : 'create';
    const requestId = requestIds.get(node.id)!;
    const taskId = flowValueTemplate(node.data.inputsValues?.taskId);
    const baseUrl = gatewayBaseUrl();
    const isQuery = operation === 'query';
    const requestUrl = isQuery
      ? `${baseUrl}/media/jobs/${taskId}`
      : `${baseUrl}/media/${mediaType === 'image' ? 'images' : 'videos'}/generate`;
    const headersValues: Record<string, FlowInputValue> = {};
    if (!isQuery) {
      headersValues['Idempotency-Key'] = {
        type: 'ref',
        content: [start.id, mediaIdempotencyInputName(node.id)],
      };
    }
    const x = Number(node.meta?.position?.x || 0);
    const y = Number(node.meta?.position?.y || 0);
    expandedNodes.push({
      id: requestId,
      type: 'http',
      meta: { ...(node.meta || {}), position: { x: x - 260, y } },
      data: {
        title: `${node.data.title || (mediaType === 'image' ? '图片生成' : '视频生成')} · 媒体网关`,
        api: {
          method: isQuery ? 'GET' : 'POST',
          url: { type: 'template', content: requestUrl },
        },
        authorization: {
          type: 'bearer',
          token: { type: 'ref', content: [start.id, MEDIA_RUN_TOKEN_INPUT] },
        },
        headers: {
          type: 'object',
          properties: Object.fromEntries(
            Object.keys(headersValues).map((key) => [key, { type: 'string' }]),
          ),
        },
        headersValues,
        params: { type: 'object', properties: {} },
        paramsValues: {},
        body: isQuery
          ? { bodyType: 'none', json: { type: 'template', content: '' } }
          : {
              bodyType: 'JSON',
              json: { type: 'template', content: buildRequestBody(node) },
            },
        timeout: { timeout: 120000, retryTimes: 0 },
        outputs: {
          type: 'object',
          properties: {
            body: { type: 'string', title: '响应内容' },
            headers: { type: 'object', title: '响应头' },
            statusCode: { type: 'integer', title: '状态码' },
          },
        },
      },
    });
    expandedNodes.push({
      ...node,
      type: 'code',
      data: {
        ...node.data,
        inputsValues: {
          body: { type: 'ref', content: [requestId, 'body'] },
          statusCode: { type: 'ref', content: [requestId, 'statusCode'] },
          caption: node.data.inputsValues?.caption || { type: 'constant', content: '' },
          provider: { type: 'constant', content: String(media.provider || '') },
          model: { type: 'constant', content: String(media.model || '') },
        },
        inputs: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            statusCode: { type: 'integer' },
            caption: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
          },
        },
        script: { language: 'javascript', content: parserScript(mediaType) },
        outputs: { type: 'object', properties: { ...NATIVE_MEDIA_OUTPUTS } },
      },
    });
  }

  const edges = copied.edges.map((edge) => ({
    ...edge,
    targetNodeID: requestIds.get(edge.targetNodeID) || edge.targetNodeID,
  }));
  for (const [mediaNodeId, requestId] of requestIds) {
    edges.push({ sourceNodeID: requestId, targetNodeID: mediaNodeId });
  }

  return { ...copied, nodes: expandedNodes, edges };
}
