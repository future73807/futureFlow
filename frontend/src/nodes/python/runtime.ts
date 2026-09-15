/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { buildProxyChain, replaceNodesWithProxyChain } from '../local-tools-chain';

const PARSE_SCRIPT = `function main({ params }) {
  let parsed;
  try {
    parsed = JSON.parse(params.body);
  } catch (e) {
    throw new Error('Python 代理返回了无法解析的内容: ' + String(params.body || '').slice(0, 120));
  }
  if (parsed && typeof parsed.statusCode === 'number' && parsed.statusCode >= 400) {
    throw new Error(String(parsed.message || 'Python 执行失败'));
  }
  return { result: parsed.result === undefined ? null : parsed.result };
}`;

/**
 * Python 执行节点本地试运行链路:
 * 浏览器没有 Python 解释器, 转换为「网关 HTTP 代理(本机 Python) + 结果解析」。
 * 解析节点沿用原节点 id, 下游 {{node_id.result}} 引用保持不变。
 */
export const preparePythonNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(schema: T): T =>
  replaceNodesWithProxyChain(schema, 'python', (node) =>
    buildProxyChain({
      node,
      gatewayPath: 'python/exec',
      payload: {
        code: String(node?.data?.codeValue?.content ?? ''),
        params: {},
      },
      parseScript: PARSE_SCRIPT,
    }));