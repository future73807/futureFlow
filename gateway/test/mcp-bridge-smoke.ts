/**
 * MCP 工具节点（mcp-bridge）专项冒烟测试。
 *
 * 覆盖：mcp 语义节点到网关代理 HTTP 节点的展开契约
 * （URL / bearer 令牌引用 / 请求体 serverId+tool+arguments）、
 * start 节点的短令牌输入注入、参数 JSON 校验、拒绝路径。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException } from '@nestjs/common';

import { DifyConverterService } from '../src/converter/dify-converter.service';
import { FlowGramJSON } from '../src/converter/types';

const converter = new DifyConverterService();
(converter as any).logger = { log() {} };

const SERVER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function value(content: string | number | boolean) {
  return { type: 'constant' as const, content };
}

function startNode(id: string) {
  return {
    id,
    type: 'start',
    meta: { position: { x: 0, y: 0 } },
    data: {
      title: 'Start',
      outputs: {
        type: 'object',
        properties: {
          query: { type: 'string', default: 'hello' },
        },
      },
    },
  };
}

function mcpNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'mcp',
    meta: { position: { x: 300, y: 0 } },
    data: {
      title: 'MCP 工具',
      serverId: SERVER_ID,
      tool: 'search_docs',
      argumentsValue: '{"query": "{{#start_1.query#}}"}',
      outputs: {
        type: 'object',
        properties: {
          result: { type: 'string', title: '工具结果' },
        },
      },
      ...overrides,
    },
  };
}

function endNode(id: string, ref = ['mcp_1', 'result']) {
  return {
    id,
    type: 'end',
    data: {
      title: 'End',
      inputsValues: { result: { type: 'ref', content: ref } },
    },
  };
}

function graph(node: any): FlowGramJSON {
  return {
    nodes: [startNode('start_1'), node, endNode('end_1')],
    edges: [
      { sourceNodeID: 'start_1', targetNodeID: 'mcp_1' },
      { sourceNodeID: 'mcp_1', targetNodeID: 'end_1' },
    ],
  };
}

function testMcpExpansion() {
  const dsl = converter.toDifyDSL(graph(mcpNode('mcp_1')));
  const ids = dsl.workflow.graph.nodes.map((n: any) => n.id);
  const semanticGone = dsl.workflow.graph.nodes.every(
    (n: any) => n.id !== 'mcp_1' || n.data.type === 'code',
  );
  assert.equal(semanticGone, true, 'mcp 语义节点必须被展开为解析节点');
  const proxy = dsl.workflow.graph.nodes.find((n: any) => n.id.startsWith('__futureflow_mcp_proxy_'));
  assert.ok(proxy, '必须存在网关代理 HTTP 节点');
  assert.equal(proxy.data.type, 'http-request');
  assert.equal(proxy.data.method, 'post');
  assert.match(proxy.data.url, /\/mcp\/proxy$/);
  assert.equal(proxy.data.authorization.type, 'api-key');
  assert.equal(proxy.data.authorization.config.type, 'bearer');
  assert.equal(
    proxy.data.authorization.config.api_key,
    '{{#start_1.__futureflow_mcp_token#}}',
    '代理调用必须使用 start 注入的短令牌',
  );
  const bodyData = proxy.data.body.data[0].value;
  const parsed = JSON.parse(bodyData.replace('{{#start_1.query#}}', 'hello'));
  assert.equal(parsed.serverId, SERVER_ID);
  assert.equal(parsed.tool, 'search_docs');
  assert.deepEqual(parsed.arguments, { query: 'hello' });

  // 解析节点输出 result 供 End 引用。
  const parser = dsl.workflow.graph.nodes.find((n: any) => n.id === 'mcp_1')!;
  assert.equal(parser.data.type, 'code');
  assert.ok(parser.data.outputs.result, '解析节点必须声明 result 输出');
  assert.doesNotThrow(() => converter.toDifyDSLYaml(graph(mcpNode('mcp_1'))));
}

function testRejectMissingServer() {
  assert.throws(
    () => converter.toDifyDSL(graph(mcpNode('mcp_1', { serverId: '' }))),
    (error: unknown) => error instanceof BadRequestException && /尚未选择 MCP 服务器/.test((error as Error).message),
  );
}

function testRejectMissingTool() {
  assert.throws(
    () => converter.toDifyDSL(graph(mcpNode('mcp_1', { tool: '' }))),
    (error: unknown) => error instanceof BadRequestException && /尚未选择要调用的工具/.test((error as Error).message),
  );
}

function testRejectBadArguments() {
  assert.throws(
    () => converter.toDifyDSL(graph(mcpNode('mcp_1', { argumentsValue: '{invalid' }))),
    (error: unknown) => error instanceof BadRequestException && /参数 JSON 格式无效/.test((error as Error).message),
  );
}

function main() {
  testMcpExpansion();
  testRejectMissingServer();
  testRejectMissingTool();
  testRejectBadArguments();
  console.log('mcp bridge smoke passed');
}

main();
