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
    throw new Error('数据库代理返回了无法解析的内容: ' + String(params.body || '').slice(0, 120));
  }
  if (parsed && typeof parsed.statusCode === 'number' && parsed.statusCode >= 400) {
    throw new Error(String(parsed.message || '数据库查询失败'));
  }
  return {
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    rowCount: Number(parsed.rowCount || 0),
    truncated: Boolean(parsed.truncated),
  };
}`;

/**
 * SQL 查询节点本地试运行链路:
 * 浏览器无法直连数据库, 转换为「网关 HTTP 代理 + 结果解析」执行。
 * 解析节点沿用原节点 id, 下游 {{node_id.rows}} 引用保持不变。
 */
export const prepareDatabaseNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(schema: T): T =>
  replaceNodesWithProxyChain(schema, 'database', (node) => {
    const conn = node?.data?.connection || {};
    return buildProxyChain({
      node,
      gatewayPath: 'db/query',
      payload: {
        host: String(conn.host ?? ''),
        port: Number(conn.port ?? 5432),
        username: String(conn.username ?? ''),
        password: String(conn.password ?? ''),
        database: String(conn.database ?? ''),
        sql: String(node?.data?.sqlValue?.content ?? ''),
      },
      parseScript: PARSE_SCRIPT,
    });
  });
