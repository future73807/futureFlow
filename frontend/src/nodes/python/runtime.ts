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
export const preparePythonNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(schema: T): T => {
  // params 就是「工作流输入」：把开始节点声明的每个输入展开成
  // `{{<开始节点id>.<字段名>}}` 模板，由运行时代入本次试运行的真实取值。
  // 这里不能取快照值——试运行输入是运行时才确定的；payload 里的字符串值保留
  // {{引用}} 语法是 local-tools-chain 的既定契约（与 SQL 节点的 sql 一致）。
  const startNode = (schema.nodes || []).find((item: any) => item?.type === 'start');
  const startProperties = (startNode?.data?.outputs?.properties || {}) as Record<string, unknown>;
  const params = startNode
    ? Object.fromEntries(
      Object.keys(startProperties).map((key) => [key, `{{${startNode.id}.${key}}}`]),
    )
    : {};

  return replaceNodesWithProxyChain(schema, 'python', (node) =>
    buildProxyChain({
      node,
      gatewayPath: 'python/exec',
      payload: {
        code: String(node?.data?.codeValue?.content ?? ''),
        params,
      },
      parseScript: PARSE_SCRIPT,
    }));
};