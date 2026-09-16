#!/usr/bin/env node
/**
 * 循环类型（数组 / 指定次数 / 无限循环）+ 中间变量的本地运行时验收。
 *
 * 本地试运行会在执行前做一次归一化（prepareLoopNodesForRuntime）：指定次数与
 * 无限循环会补一个生成 [1..N] 的代码节点，并把循环数组指向它；循环节点的
 * 「中间变量」会注入循环体代码节点的入参。
 *
 * 用法：node scripts/test-loop-types-runtime.cjs
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

const { prepareLoopNodesForRuntime } = require(resolve(__dirname, '../frontend/src/nodes/loop/runtime.ts'));
const { prepareCodeNodesForRuntime } = require(resolve(__dirname, '../frontend/src/nodes/code/runtime.ts'));

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const loopBody = () => ({
  id: 'loop_code_0',
  type: 'code',
  meta: { position: { x: 190, y: 0 } },
  data: {
    title: '逐项处理',
    inputsValues: {
      item: { type: 'ref', content: ['loop_0_locals', 'item'] },
      index: { type: 'ref', content: ['loop_0_locals', 'index'] },
    },
    inputs: {
      type: 'object',
      properties: { item: { type: 'number' }, index: { type: 'number' } },
    },
    script: {
      language: 'javascript',
      // 中间变量 prefix 由循环节点注入，循环体里直接读 params.prefix
      content: 'function main({ params }) {\n  return { result: String(params.prefix || "") + "#" + params.item };\n}',
    },
    outputs: { type: 'object', properties: { result: { type: 'string' } } },
  },
});

const buildSchema = (loopData, startProps = { query: { type: 'string', default: '轮' } }) => ({
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: startProps } },
    },
    {
      id: 'loop_0',
      type: 'loop',
      meta: { position: { x: 400, y: 0 } },
      data: {
        title: '循环',
        loopOutputs: { result: { type: 'ref', content: ['loop_code_0', 'result'] } },
        outputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'string' } } },
        },
        ...loopData,
      },
      blocks: [
        { id: 'loop_block_start', type: 'block-start', meta: { position: { x: 32, y: 0 } }, data: {} },
        loopBody(),
        { id: 'loop_block_end', type: 'block-end', meta: { position: { x: 600, y: 0 } }, data: {} },
      ],
      edges: [
        { sourceNodeID: 'loop_block_start', targetNodeID: 'loop_code_0' },
        { sourceNodeID: 'loop_code_0', targetNodeID: 'loop_block_end' },
      ],
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 900, y: 0 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['loop_0', 'result'] } },
        inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'string' } } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'loop_0' },
    { sourceNodeID: 'loop_0', targetNodeID: 'end_0' },
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
  const prepared = prepareCodeNodesForRuntime(prepareLoopNodesForRuntime(schema));
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

  // 1) 指定次数 3 + 中间变量 prefix
  const countReport = await run(
    buildSchema({
      loopType: 'count',
      loopCount: 3,
      loopMiddleValues: { prefix: { type: 'ref', content: ['start_0', 'query'] } },
    }),
    { query: '轮' },
  );
  assert.equal(countReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(countReport.outputs.result, ['轮#1', '轮#2', '轮#3']);
  console.log('[PASS] 指定次数循环 + 中间变量:', JSON.stringify(countReport.outputs.result));

  // 2) 无限循环（最大轮数 4）
  const infiniteReport = await run(
    buildSchema({
      loopType: 'infinite',
      loopMaxRounds: 4,
      loopMiddleValues: { prefix: { type: 'ref', content: ['start_0', 'query'] } },
    }),
    { query: '无限' },
  );
  assert.equal(infiniteReport.workflowStatus.status, 'succeeded');
  assert.equal(infiniteReport.outputs.result.length, 4);
  assert.deepEqual(infiniteReport.outputs.result[0], '无限#1');
  console.log('[PASS] 无限循环（上限 4 轮）:', JSON.stringify(infiniteReport.outputs.result));

  // 3) 数组循环保持不变（回归）
  const arraySchema = buildSchema({
    loopType: 'array',
    loopFor: { type: 'ref', content: ['start_0', 'items'] },
  }, { items: { type: 'array', items: { type: 'number' } } });
  const arrayReport = await run(arraySchema, { items: [2, 4] });
  assert.equal(arrayReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(arrayReport.outputs.result, ['#2', '#4']);
  console.log('[PASS] 数组循环（回归）:', JSON.stringify(arrayReport.outputs.result));

  // 4) 对象数组：循环体通过 item.<属性> 取字段
  const objectSchema = buildSchema({
    loopType: 'array',
    loopFor: { type: 'ref', content: ['start_0', 'list'] },
  }, { list: { type: 'array', items: { type: 'object' }, title: '对象数组' } });
  const objectLoop = objectSchema.nodes.find((n) => n.id === 'loop_0');
  const body = objectLoop.blocks.find((b) => b.type === 'code');
  body.data.inputs.properties.item = { type: 'object' };
  body.data.script.content = 'function main({ params }) { const name = params.item && params.item.name; return { result: String(name) + "!" }; }';
  const objectReport = await run(objectSchema, { list: [{ name: '甲' }, { name: '乙' }] });
  assert.equal(objectReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(objectReport.outputs.result, ['甲!', '乙!']);
  console.log('[PASS] 对象数组取属性:', JSON.stringify(objectReport.outputs.result));

  // 5) 中间变量缺省时循环体读到空字符串（不再报错）
  const noMiddle = await run(buildSchema({ loopType: 'count', loopCount: 2 }), { query: 'x' });
  assert.deepEqual(noMiddle.outputs.result, ['#1', '#2']);
  console.log('[PASS] 无中间变量:', JSON.stringify(noMiddle.outputs.result));

  console.log('\n循环类型本地运行时验收通过。');
})().catch((error) => {
  console.error('[FAIL]', error.message);
  process.exit(1);
});
