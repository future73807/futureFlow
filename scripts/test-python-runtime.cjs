#!/usr/bin/env node
/**
 * Python 执行节点「前端链路」契约回归。
 *
 * 背景：该节点曾经存在一处**静默**缺陷 —— 前端把 payload.params 硬编码为 {}，
 * 网关运行器又用 `main({'params': params})` 多包了一层。结果是官方默认模板
 *   def main(params): text = str(params.get("query", "")); ...
 * 永远拿到空字符串，节点「执行成功」但结果是错的，不报任何错。
 *
 * 本脚本守住前端这一半：preparePythonNodesForRuntime 必须把开始节点声明的输入
 * 展开成 {{<startId>.<字段>}} 模板（而不是空对象）。网关那一半由
 * gateway/test/python-runner-smoke.ts 用真实 Python 守住。
 *
 * 这里刻意不 import 任何 gateway 源码：网关模块会连带加载 TypeORM 实体，
 * 在 transpile-only 下缺少装饰器元数据会直接抛错。
 *
 * 用法：node scripts/test-python-runtime.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const { resolve } = require('node:path');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'CommonJS',
  moduleResolution: 'Node',
  esModuleInterop: true,
  target: 'ES2022',
  lib: ['ES2022', 'DOM'],
});
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require(resolve(__dirname, '../gateway/node_modules/ts-node/register/transpile-only'));

// utils/config.ts 里的 __GATEWAY_URL__ 由 rsbuild 在构建期注入。
global.__GATEWAY_URL__ = 'http://localhost:3001';

const { preparePythonNodesForRuntime } = require(resolve(
  __dirname,
  '../frontend/src/nodes/python/runtime.ts',
));

/** 前端默认模板（frontend/src/nodes/python/index.ts 的 onAdd），一字不改。 */
const DEFAULT_TEMPLATE =
  'def main(params):\n    text = str(params.get("query", ""))\n    return {"length": len(text), "upper": text.upper()}';

const schema = {
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: {
            query: { type: 'string', title: '用户输入' },
            count: { type: 'integer', title: '数量' },
          },
        },
      },
    },
    {
      id: 'python_0',
      type: 'python',
      data: {
        title: 'Python 执行 1',
        codeValue: { type: 'template', content: DEFAULT_TEMPLATE },
        outputs: { type: 'object', properties: { result: { type: 'object', title: '返回结果' } } },
      },
    },
    { id: 'end_0', type: 'end', data: { title: '结束' } },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'python_0' },
    { sourceNodeID: 'python_0', targetNodeID: 'end_0' },
  ],
};

const prepared = preparePythonNodesForRuntime(schema);
const httpNode = prepared.nodes.find((node) => node.id === 'python_0_gw');
assert.ok(httpNode, '应生成 python_0_gw 网关代理节点');
assert.equal(
  prepared.nodes.find((node) => node.id === 'python_0')?.type,
  'code',
  '解析节点应沿用原节点 id（下游 {{python_0.result}} 引用不能失效）',
);
assert.ok(
  String(httpNode.data.api.url.content).endsWith('/python/exec'),
  '代理节点应指向网关 python/exec',
);

const payload = JSON.parse(String(httpNode.data.body.json.content));
assert.equal(payload.code, DEFAULT_TEMPLATE, '代码应原样传递');
assert.deepEqual(
  payload.params,
  { query: '{{start_0.query}}', count: '{{start_0.count}}' },
  'params 必须把开始节点声明的输入展开成 {{引用}} 模板，不能是空对象',
);

// 没有开始节点时不应抛异常。
const withoutStart = preparePythonNodesForRuntime({
  nodes: [{ id: 'python_1', type: 'python', data: { codeValue: { type: 'template', content: DEFAULT_TEMPLATE } } }],
  edges: [],
});
const withoutStartPayload = JSON.parse(
  String(withoutStart.nodes.find((node) => node.id === 'python_1_gw').data.body.json.content),
);
assert.deepEqual(withoutStartPayload.params, {}, '缺少开始节点时 params 应退化为空对象');

console.log('python runtime contract passed (frontend payload)');
