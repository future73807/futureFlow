#!/usr/bin/env node
/**
 * 退出节点的本地试运行回归：
 *   1. 退出范围 = 跳出当前循环：放进循环体后，本地运行时立刻结束循环（runtime-js 的 break 语义）；
 *   2. 退出范围 = 退出整个工作流：归一化成等价的代码节点，把退出时声明的输出交给下游/结束节点。
 *
 * 用法：node scripts/test-exit-runtime.cjs
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

const { prepareExitNodesForRuntime } = require(resolve(
  __dirname,
  '../frontend/src/nodes/exit/runtime.ts',
));
const { prepareConditionNodesForRuntime } = require(resolve(
  __dirname,
  '../frontend/src/nodes/condition/runtime.ts',
));

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const codeNode = (id, script, outputs, inputs = {}) => ({
  id,
  type: 'code',
  meta: { position: { x: 0, y: 0 } },
  data: {
    title: id,
    inputsValues: {},
    inputs: { type: 'object', properties: {} },
    script: { language: 'javascript', content: script },
    outputs: { type: 'object', properties: outputs },
    ...inputs,
  },
});

/** 循环体里放一个「退出节点（跳出当前循环）」 */
const loopBreakSchema = () => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: { items: { type: 'array', items: { type: 'number' } } } } },
    },
    {
      id: 'batch',
      type: 'loop',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: '数组批处理',
        loopFor: { type: 'ref', content: ['start', 'items'] },
        loopOutputs: { result: { type: 'ref', content: ['batch_code', 'result'] } },
        outputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
      },
      blocks: [
        { id: 'batch_start', type: 'block-start', meta: { position: { x: 0, y: 0 } }, data: {} },
        {
          ...codeNode(
            'batch_code',
            'function main({ params }) { return { result: params.item * 2 }; }',
            { result: { type: 'number' } },
          ),
          data: {
            ...codeNode('batch_code', '', {}).data,
            title: '逐项处理',
            inputsValues: {
              item: { type: 'ref', content: ['batch_locals', 'item'] },
              index: { type: 'ref', content: ['batch_locals', 'index'] },
            },
            inputs: { type: 'object', properties: { item: { type: 'number' }, index: { type: 'number' } } },
            script: { language: 'javascript', content: 'function main({ params }) { return { result: params.item * 2 }; }' },
            outputs: { type: 'object', properties: { result: { type: 'number' } } },
          },
        },
        {
          id: 'batch_exit',
          type: 'exit',
          meta: { position: { x: 360, y: 0 } },
          data: { title: '退出循环', scope: 'loop' },
        },
        { id: 'batch_end', type: 'block-end', meta: { position: { x: 540, y: 0 } }, data: {} },
      ],
      edges: [
        { sourceNodeID: 'batch_start', targetNodeID: 'batch_code' },
        { sourceNodeID: 'batch_code', targetNodeID: 'batch_exit' },
        { sourceNodeID: 'batch_exit', targetNodeID: 'batch_end' },
      ],
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 1000, y: 0 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['batch', 'result'] } },
        inputs: { type: 'object', properties: { result: { type: 'array', items: { type: 'number' } } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'batch' },
    { sourceNodeID: 'batch', targetNodeID: 'end' },
  ],
});

/** 「退出节点（退出整个工作流）」→ 结束节点读取它声明的输出 */
const workflowExitSchema = () => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string' } } } },
    },
    {
      id: 'prepare',
      type: 'code',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: 'prepare',
        inputsValues: { query: { type: 'ref', content: ['start', 'query'] } },
        inputs: { type: 'object', properties: { query: { type: 'string' } } },
        script: { language: 'javascript', content: 'function main({ params }) { return { text: params.query + "-ok" }; }' },
        outputs: { type: 'object', properties: { text: { type: 'string' } } },
      },
    },
    {
      id: 'exit_1',
      type: 'exit',
      meta: { position: { x: 620, y: 0 } },
      data: {
        title: '退出节点',
        scope: 'workflow',
        inputsValues: { summary: { type: 'ref', content: ['prepare', 'text'] } },
      },
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 940, y: 0 } },
      data: {
        title: '结束',
        inputsValues: { summary: { type: 'ref', content: ['exit_1', 'summary'] } },
        inputs: { type: 'object', properties: { summary: { type: 'string' } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'prepare' },
    { sourceNodeID: 'prepare', targetNodeID: 'exit_1' },
    { sourceNodeID: 'exit_1', targetNodeID: 'end' },
  ],
});

const waitForReport = async (taskID) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = await TaskReportAPI({ taskID });
    if (report?.workflowStatus?.terminated) return report;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`本地运行超时: ${taskID}`);
};

const runPreparedSchema = async (schema, inputs) => {
  const payload = { schema: JSON.stringify(schema), inputs };
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

  // 1) 跳出循环：归一化成 runtime 的 break 节点
  const loopPrepared = prepareExitNodesForRuntime(loopBreakSchema());
  const breakBlock = loopPrepared.nodes
    .find((node) => node.id === 'batch')
    .blocks.find((block) => block.id === 'batch_exit');
  assert.equal(breakBlock.type, 'break', '循环体内的退出节点应归一化为 break');

  const loopReport = await runPreparedSchema(loopPrepared, { items: [1, 2, 3, 4, 5] });
  assert.equal(loopReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(
    loopReport.outputs,
    { result: [] },
    '第一轮就退出时循环结果应为空（break 命中后不再收集当前轮）',
  );

  // 2) 退出整个工作流：归一化成代码节点，退出时声明的输出可被下游引用
  const exitPrepared = prepareExitNodesForRuntime(workflowExitSchema());
  const exitNode = exitPrepared.nodes.find((node) => node.id === 'exit_1');
  assert.equal(exitNode.type, 'code', '退出整个工作流的节点应归一化为代码节点');
  assert.deepEqual(
    Object.keys(exitNode.data.outputs.properties),
    ['summary'],
    '退出节点声明的输出要保留下来',
  );

  const exitReport = await runPreparedSchema(exitPrepared, { query: 'hello' });
  assert.equal(exitReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(exitReport.outputs, { summary: 'hello-ok' });

  // 3) 退出分支被选中时（结束节点本身没被执行）运行必须仍然成功，并且结果里带退出时的返回值
  const branchSchema = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string' } } } },
      },
      {
        id: 'prepare',
        type: 'code',
        meta: { position: { x: 300, y: 0 } },
        data: {
          title: '准备',
          inputsValues: { query: { type: 'ref', content: ['start', 'query'] } },
          inputs: { type: 'object', properties: { query: { type: 'string' } } },
          script: {
            language: 'javascript',
            content: 'function main({ params }) { return { text: "prepared:" + String(params.query || ""), shouldExit: params.query === "退出" }; }',
          },
          outputs: { type: 'object', properties: { text: { type: 'string' }, shouldExit: { type: 'boolean' } } },
        },
      },
      {
        id: 'cond',
        type: 'condition',
        meta: { position: { x: 600, y: 0 } },
        data: {
          title: '条件分支',
          conditions: [{ key: 'if_exit', value: { left: { type: 'ref', content: ['prepare', 'shouldExit'] }, operator: 'is_true' } }],
        },
      },
      {
        id: 'exit_branch',
        type: 'exit',
        meta: { position: { x: 900, y: 120 } },
        data: { title: '提前退出', scope: 'workflow', inputsValues: { summary: { type: 'ref', content: ['prepare', 'text'] } } },
      },
      codeNode('normal', 'function main() { return { result: "normal-path" }; }', { result: { type: 'string' } }),
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 1200, y: 240 } },
        data: {
          title: '结束',
          inputsValues: { result: { type: 'ref', content: ['normal', 'result'] } },
          inputs: { type: 'object', properties: { result: { type: 'string' } } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'prepare' },
      { sourceNodeID: 'prepare', targetNodeID: 'cond' },
      { sourceNodeID: 'cond', sourcePortID: 'if_exit', targetNodeID: 'exit_branch' },
      { sourceNodeID: 'cond', sourcePortID: 'else', targetNodeID: 'normal' },
      { sourceNodeID: 'normal', targetNodeID: 'end' },
    ],
  };
  // 条件分支的端口映射由条件节点的归一化负责（与画布试运行的 prepare 顺序一致）
  const branchPrepared = prepareConditionNodesForRuntime(prepareExitNodesForRuntime(branchSchema));
  assert.equal(
    branchPrepared.edges.some((edge) => edge.sourceNodeID === 'exit_branch' && edge.targetNodeID === 'end'),
    true,
    '退出分支要补一条到结束节点的边，保证本地运行成功',
  );
  const exitBranchReport = await runPreparedSchema(branchPrepared, { query: '退出' });
  assert.equal(exitBranchReport.workflowStatus.status, 'succeeded');
  assert.equal(
    exitBranchReport.outputs.summary,
    'prepared:退出',
    '退出分支被选中时，结果里应带退出节点声明的输出',
  );
  assert.equal(exitBranchReport.reports.normal, undefined, '退出分支被选中时正常分支不应执行');

  const normalBranchReport = await runPreparedSchema(branchPrepared, { query: '' });
  assert.equal(normalBranchReport.workflowStatus.status, 'succeeded');
  assert.equal(normalBranchReport.outputs.result, 'normal-path');
  assert.equal(normalBranchReport.reports.exit_branch, undefined, '正常分支被选中时退出节点不应执行');

  process.stdout.write(
    'exit local runtime passed: loop break stops iteration + workflow exit yields declared outputs\n',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
