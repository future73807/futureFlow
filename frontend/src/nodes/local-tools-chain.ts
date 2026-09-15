/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { getToken } from '../utils/auth';
import { GATEWAY_URL } from '../utils/config';

/**
 * 本地扩展节点（SQL 查询 / Python 执行）的试运行链路:
 *
 *   [原节点] --prepare--> [HTTP 代理节点] --> [结果解析节点(沿用原节点 id)]
 *
 * 浏览器 runtime-js 没有数据库驱动和 Python 解释器，但可以把请求交给网关
 * (JWT 随 prepare 注入、仅存在于本次浏览器执行)。结果解析节点沿用原节点
 * id 与 outputs，下游 {{node_id.rows}} 等引用保持不变。
 */

export interface ProxyChainSpec {
  /** 原始节点(将被替换为链路) */
  node: any;
  /** 网关路径, 如 db/query */
  gatewayPath: string;
  /** 请求体(普通对象; 字符串值保留 {{引用}} 模板语法) */
  payload: Record<string, unknown>;
  /** 结果解析节点脚本(main({params}) 契约; params.body 为网关响应文本) */
  parseScript: string;
}

export function buildProxyChain(spec: ProxyChainSpec): { httpNode: any; codeNode: any } {
  const { node, gatewayPath, payload, parseScript } = spec;
  const token = getToken() || '';
  const title = String(node?.data?.title || '网关节点');

  const httpNode = {
    id: `${node.id}_gw`,
    type: 'http',
    meta: {
      position: {
        x: Number(node?.meta?.position?.x ?? 0) - 300,
        y: Number(node?.meta?.position?.y ?? 0),
      },
    },
    data: {
      title: `${title} · 网关代理`,
      api: {
        method: 'POST',
        url: { type: 'template', content: `${GATEWAY_URL}/${gatewayPath.replace(/^\/+/, '')}` },
      },
      headersValues: {
        'Content-Type': { type: 'template', content: 'application/json' },
        Authorization: { type: 'template', content: `Bearer ${token}` },
      },
      headers: {
        type: 'object',
        properties: {
          'Content-Type': { type: 'string' },
          Authorization: { type: 'string' },
        },
      },
      params: { type: 'object', properties: {} },
      paramsValues: {},
      body: {
        bodyType: 'JSON',
        json: { type: 'template', content: JSON.stringify(payload) },
      },
      timeout: { timeout: 30000, retryTimes: 0 },
      outputs: {
        type: 'object',
        properties: {
          body: { type: 'string', title: '响应内容' },
          headers: { type: 'object', title: '响应头' },
          statusCode: { type: 'integer', title: '状态码' },
        },
      },
    },
  };

  const codeNode = {
    ...node,
    type: 'code',
    data: {
      ...(node.data || {}),
      title: `${title} · 结果解析`,
      script: {
        language: 'javascript',
        content: parseScript,
      },
      inputs: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', title: '网关响应' },
        },
      },
      inputsValues: {
        body: { type: 'ref', content: [httpNode.id, 'body'] },
      },
    },
  };

  return { httpNode, codeNode };
}

/** 把 schema 中指定类型的节点替换为代理链路, 并同步改写边连接。 */
export function replaceNodesWithProxyChain<T extends { nodes?: any[]; edges?: any[] }>(
  schema: T,
  nodeType: string,
  build: (node: any) => { httpNode: any; codeNode: any },
): T {
  if (!Array.isArray(schema.nodes)) return schema;
  const nodes: any[] = [];
  const edges: any[] = Array.isArray(schema.edges) ? [...schema.edges] : [];

  for (const node of schema.nodes) {
    if (node?.type !== nodeType) {
      nodes.push(node);
      continue;
    }
    const { httpNode, codeNode } = build(node);
    nodes.push(httpNode, codeNode);

    // 原节点入边 → 代理节点; 原节点出边 ← 解析节点
    for (let i = edges.length - 1; i >= 0; i--) {
      const edge = edges[i];
      if (edge.targetNodeID === node.id) {
        edges.splice(i, 1);
        edges.push({ ...edge, targetNodeID: httpNode.id });
      } else if (edge.sourceNodeID === node.id) {
        edges.splice(i, 1);
        edges.push({ ...edge, sourceNodeID: codeNode.id });
      }
    }
    edges.push({ sourceNodeID: httpNode.id, targetNodeID: codeNode.id });
  }

  return { ...schema, nodes, edges };
}