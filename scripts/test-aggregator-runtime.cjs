#!/usr/bin/env node
/**
 * 变量聚合节点（本地运行时）验收。
 *
 * 聚合语义：每个分组返回第一个非空的值；全为空时返回该类型的安全空值。
 * 本地试运行前会把聚合节点编译成等价代码节点（保留原节点 id）。
 *
 * 用法：node scripts/test-aggregator-runtime.cjs
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

const { prepareAggregatorNodesForRuntime } = require(resolve(__dirname, '../frontend/src/nodes/variable-aggregator/runtime.ts'));
const { prepareCodeNodesForRuntime } = require(resolve(__dirname, '../frontend/src/nodes/code/runtime.ts'));

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const startNode = (properties) => ({
  id: 'start_0',
  type: 'start',
  meta: { position: { x: 0, y: 0 } },
  data: { title: '开始', outputs: { type: 'object', properties } },
});

const buildSchema = (
  groups,
  properties,
  endInputs = { result: { type: 'ref', content: ['aggregate_0', 'result'] } },
  endTypes = { result: 'string' },
) => ({
  nodes: [
    startNode(properties),
    {
      id: 'aggregate_0',
      type: 'variable-aggregator',
      meta: { position: { x: 400, y: 0 } },
      data: {
        title: '变量聚合',
        strategy: 'first-non-empty',
        groups,
        outputs: { type: 'object', properties: {} },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 800, y: 0 } },
      data: {
        title: '结束',
        inputsValues: endInputs,
        inputs: { type: 'object', properties: Object.fromEntries(
          Object.entries(endTypes).map(([key, type]) => [key, { type }]),
        ) },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'aggregate_0' },
    { sourceNodeID: 'aggregate_0', targetNodeID: 'end_0' },
  ],
});

const waitForReport = async (taskID) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = await TaskReportAPI({ taskID });
    if (report?.workflowStatus?.terminated) return report;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`本地运行超时: ${taskID}`);
};

const run = async (schema, inputs) => {
  const prepared = prepareCodeNodesForRuntime(prepareAggregatorNodesForRuntime(schema));
  const payload = { schema: JSON.stringify(prepared), inputs };
  const validation = await TaskValidateAPI(payload);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors || []));
  const { taskID } = await TaskRunAPI(payload);
  return waitForReport(taskID);
};

(async () => {
  ({
    TaskReportAPI,
    TaskRunAPI,
    TaskValidateAPI,
  } = await import('../frontend/node_modules/@flowgram.ai/runtime-js/dist/esm/index.js'));

  // 1) 同一分组内跳过空值，取第一个非空
  const first = await run(
    buildSchema(
      [{ key: 'result', values: [
        { type: 'ref', content: ['start_0', 'empty'] },
        { type: 'ref', content: ['start_0', 'filled'] },
      ] }],
      { empty: { type: 'string', default: '' }, filled: { type: 'string', default: '来自第二个变量' } },
    ),
    {},
  );
  assert.equal(first.workflowStatus.status, 'succeeded');
  assert.deepEqual(first.outputs.result, '来自第二个变量');
  console.log('[PASS] 取第一个非空值:', JSON.stringify(first.outputs.result));

  // 2) 全部为空时返回该类型安全空值（字符串 -> ''）
  const emptyCase = await run(
    buildSchema(
      [{ key: 'result', values: [
        { type: 'ref', content: ['start_0', 'empty'] },
        { type: 'ref', content: ['start_0', 'blank'] },
      ] }],
      { empty: { type: 'string', default: '' }, blank: { type: 'string', default: '   ' } },
    ),
    {},
  );
  assert.deepEqual(emptyCase.outputs.result, '');
  console.log('[PASS] 全为空返回安全空值:', JSON.stringify(emptyCase.outputs.result));

  // 3) 多分组：每个分组各出一个输出
  const multi = await run(
    buildSchema(
      [
        { key: 'text', values: [{ type: 'ref', content: ['start_0', 'filled'] }] },
        { key: 'count', values: [{ type: 'ref', content: ['start_0', 'score'] }] },
      ],
      {
        filled: { type: 'string', default: '文本结果' },
        score: { type: 'number', default: 42 },
      },
      {
        text: { type: 'ref', content: ['aggregate_0', 'text'] },
        count: { type: 'ref', content: ['aggregate_0', 'count'] },
      },
      { text: 'string', count: 'number' },
    ),
    {},
  );
  assert.deepEqual(multi.outputs, { text: '文本结果', count: 42 });
  console.log('[PASS] 多分组各自取值:', JSON.stringify(multi.outputs));

  console.log('\n变量聚合本地运行时验收通过。');
})().catch((error) => {
  console.error('[FAIL]', error.message);
  process.exit(1);
});
