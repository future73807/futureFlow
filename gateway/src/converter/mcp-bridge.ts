/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { FlowGramJSON, FlowNodeJSON, FlowInputValue } from './types';

/** 运行时注入 start 节点的 MCP 执行短令牌输入名。 */
export const MCP_RUN_TOKEN_INPUT = '__futureflow_mcp_token';

export const MCP_OUTPUTS: Record<string, { type: string; title: string }> = {
  body: { type: 'string', title: '工具响应内容' },
  statusCode: { type: 'integer', title: '状态码' },
};

export function isMcpNode(node: FlowNodeJSON | undefined): boolean {
  return node?.type === 'mcp';
}

export function collectMcpServerIds(flowgram: FlowGramJSON): string[] {
  const ids = new Set<string>();
  for (const node of flowgram.nodes) {
    if (!isMcpNode(node)) continue;
    const serverId = String(node.data.serverId || '').trim();
    if (serverId) ids.add(serverId);
  }
  return [...ids];
}

function mcpProxyBody(node: FlowNodeJSON): string {
  const serverId = String(node.data.serverId || '');
  const tool = String(node.data.tool || '');
  const rawArguments = node.data.argumentsValue;
  let argumentsExpression = '{}';
  if (typeof rawArguments === 'string' && rawArguments.trim()) {
    // 用户在画布上编辑的 JSON 模板字符串原样嵌入请求体（支持 {{#node.var#}} 引用）。
    argumentsExpression = rawArguments;
  } else if (rawArguments && typeof rawArguments === 'object') {
    argumentsExpression = JSON.stringify(rawArguments);
  }
  return `{"serverId":${JSON.stringify(serverId)},"tool":${JSON.stringify(tool)},"arguments":${argumentsExpression}}`;
}

function gatewayBaseUrl(): string {
  const explicit = String(process.env.DIFY_MEDIA_GATEWAY_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env.DIFY_MEDIA_GATEWAY_PORT || process.env.GATEWAY_PORT || '3001';
  return `http://futureflow-gateway:${port}`;
}

function uniqueProxyNodeId(nodeId: string, existingIds: Set<string>): string {
  const digest = createHash('sha256').update(nodeId, 'utf8').digest('hex').slice(0, 16);
  const base = `__futureflow_mcp_proxy_${digest}`;
  let candidate = base;
  let suffix = 1;
  while (existingIds.has(candidate)) candidate = `${base}_${suffix++}`;
  existingIds.add(candidate);
  return candidate;
}

/**
 * MCP 工具节点在画布上是语义节点；对 Dify 0.15.3 展开为一个受信的
 * 网关代理 HTTP 调用。MCP 服务器地址与 Bearer 令牌只保存在网关的
 * 加密存储里，Dify 运行时仅拿到一次性的短时执行令牌。
 */
export function prepareMcpNodes(flowgram: FlowGramJSON): FlowGramJSON {
  const mcpNodes = flowgram.nodes.filter(isMcpNode);
  if (mcpNodes.length === 0) return flowgram;
  const start = flowgram.nodes.find((node) => node.type === 'start');
  if (!start) throw new BadRequestException('MCP 工具节点需要开始节点');

  for (const node of mcpNodes) {
    const serverId = String(node.data.serverId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serverId)) {
      throw new BadRequestException(`MCP 工具节点 ${node.id} 尚未选择 MCP 服务器`);
    }
    if (!String(node.data.tool || '').trim()) {
      throw new BadRequestException(`MCP 工具节点 ${node.id} 尚未选择要调用的工具`);
    }
    const rawArguments = node.data.argumentsValue;
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        JSON.parse(rawArguments.replace(/\{\{#[^{}#]+#\}\}/g, '0'));
      } catch {
        throw new BadRequestException(`MCP 工具节点 ${node.id} 的参数 JSON 格式无效`);
      }
    }
  }

  const copied = JSON.parse(JSON.stringify(flowgram)) as FlowGramJSON;
  const copiedStart = copied.nodes.find((node) => node.id === start.id)!;
  copiedStart.data.outputs = copiedStart.data.outputs || { type: 'object', properties: {} };
  copiedStart.data.outputs.properties = { ...(copiedStart.data.outputs.properties || {}) };
  copiedStart.data.outputs.required = Array.from(new Set([
    ...(copiedStart.data.outputs.required || []),
    MCP_RUN_TOKEN_INPUT,
  ]));
  copiedStart.data.outputs.properties[MCP_RUN_TOKEN_INPUT] = {
    type: 'string',
    title: 'MCP 执行令牌',
  };

  const existingIds = new Set(copied.nodes.map((node) => node.id));
  const proxyIds = new Map<string, string>();
  for (const original of mcpNodes) {
    proxyIds.set(original.id, uniqueProxyNodeId(original.id, existingIds));
  }

  const expandedNodes: FlowNodeJSON[] = [];
  for (const node of copied.nodes) {
    if (!isMcpNode(node)) {
      expandedNodes.push(node);
      continue;
    }
    const proxyId = proxyIds.get(node.id)!;
    const x = Number(node.meta?.position?.x || 0);
    const y = Number(node.meta?.position?.y || 0);
    expandedNodes.push({
      id: proxyId,
      type: 'http',
      meta: { ...(node.meta || {}), position: { x: x - 260, y } },
      data: {
        title: `${node.data.title || 'MCP 工具'} · 工具代理`,
        api: {
          method: 'POST',
          url: { type: 'template', content: `${gatewayBaseUrl()}/mcp/proxy` },
        },
        authorization: {
          type: 'bearer',
          token: { type: 'ref', content: [start.id, MCP_RUN_TOKEN_INPUT] },
        },
        headers: { type: 'object', properties: {} },
        headersValues: {},
        params: { type: 'object', properties: {} },
        paramsValues: {},
        body: {
          bodyType: 'JSON',
          json: { type: 'template', content: mcpProxyBody(node) },
        },
        timeout: { timeout: 120000, retryTimes: 0 },
        outputs: {
          type: 'object',
          properties: { ...MCP_OUTPUTS },
        },
      },
    });
    expandedNodes.push({
      ...node,
      type: 'code',
      data: {
        ...node.data,
        inputsValues: {
          body: { type: 'ref', content: [proxyId, 'body'] },
          statusCode: { type: 'ref', content: [proxyId, 'statusCode'] },
        },
        inputs: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            statusCode: { type: 'integer' },
          },
        },
        script: {
          language: 'javascript',
          content: [
            'function main({ params }) {',
            '  if (params.statusCode >= 400) {',
            `    throw new Error('MCP 工具调用失败（HTTP ' + params.statusCode + '）');`,
            '  }',
            '  return { result: String(params.body ?? "") };',
            '}',
          ].join('\n'),
        },
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string', title: '工具结果' },
          },
        },
      },
    });
  }

  const edges = copied.edges.map((edge) => ({
    ...edge,
    targetNodeID: proxyIds.get(edge.targetNodeID) || edge.targetNodeID,
  }));
  for (const [mcpNodeId, proxyId] of proxyIds) {
    edges.push({ sourceNodeID: proxyId, targetNodeID: mcpNodeId });
  }

  return { ...copied, nodes: expandedNodes, edges };
}
