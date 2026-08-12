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

const { prepareConditionNodesForRuntime } = require(resolve(
  __dirname,
  '../demo-free-layout/src/nodes/condition/runtime.ts',
));

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const markerNode = (id, result) => ({
  id,
  type: 'code',
  meta: { position: { x: 0, y: 0 } },
  data: {
    title: id,
    inputsValues: {},
    inputs: { type: 'object', properties: {} },
    script: {
      language: 'javascript',
      content: `function main() { return { result: ${JSON.stringify(result)} }; }`,
    },
    outputs: { type: 'object', properties: { result: { type: 'string' } } },
  },
});

const buildSchema = () => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: {
            score: { type: 'integer' },
            region: { type: 'string' },
          },
        },
      },
    },
    {
      id: 'string_condition',
      type: 'condition',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: '字符串不为空',
        conditions: [{
          key: 'region_not_empty',
          value: {
            left: { type: 'ref', content: ['start', 'region'] },
            operator: 'is_not_empty',
          },
        }],
      },
    },
    {
      id: 'multi',
      type: 'multi-condition',
      meta: { position: { x: 600, y: 0 } },
      data: {
        title: '本地多条件',
        branch: [
          {
            logic: 'and',
            conditions: [
              {
                key: 'score_positive',
                value: {
                  left: { type: 'ref', content: ['start', 'score'] },
                  operator: 'gt',
                  right: { type: 'constant', content: 5 },
                },
              },
              {
                key: 'score_below_twenty',
                value: {
                  left: { type: 'ref', content: ['start', 'score'] },
                  operator: 'lt',
                  right: { type: 'constant', content: 20 },
                },
              },
            ],
          },
          {
            logic: 'or',
            conditions: [
              {
                key: 'region_us',
                value: {
                  left: { type: 'ref', content: ['start', 'region'] },
                  operator: 'eq',
                  right: { type: 'constant', content: 'US' },
                },
              },
              {
                key: 'region_cn',
                value: {
                  left: { type: 'ref', content: ['start', 'region'] },
                  operator: 'eq',
                  right: { type: 'constant', content: 'CN' },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: 'string_empty_condition',
      type: 'condition',
      meta: { position: { x: 600, y: 300 } },
      data: {
        title: '字符串为空',
        conditions: [{
          key: 'region_empty',
          value: {
            left: { type: 'ref', content: ['start', 'region'] },
            operator: 'is_empty',
          },
        }],
      },
    },
    markerNode('and_hit', 'and'),
    markerNode('region_hit', 'region'),
    markerNode('else_hit', 'else'),
    markerNode('empty_hit', 'empty'),
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 1200, y: 0 } },
      data: { title: '结束' },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'string_condition' },
    {
      sourceNodeID: 'string_condition',
      targetNodeID: 'multi',
      sourcePortID: 'region_not_empty',
    },
    {
      sourceNodeID: 'string_condition',
      targetNodeID: 'string_empty_condition',
      sourcePortID: 'else',
    },
    {
      sourceNodeID: 'string_empty_condition',
      targetNodeID: 'empty_hit',
      sourcePortID: 'region_empty',
    },
    {
      sourceNodeID: 'string_empty_condition',
      targetNodeID: 'else_hit',
      sourcePortID: 'else',
    },
    { sourceNodeID: 'multi', targetNodeID: 'and_hit', sourcePortID: 'branch.0' },
    { sourceNodeID: 'multi', targetNodeID: 'region_hit', sourcePortID: 'branch.1' },
    { sourceNodeID: 'multi', targetNodeID: 'else_hit', sourcePortID: 'else' },
    { sourceNodeID: 'and_hit', targetNodeID: 'end' },
    { sourceNodeID: 'region_hit', targetNodeID: 'end' },
    { sourceNodeID: 'else_hit', targetNodeID: 'end' },
    { sourceNodeID: 'empty_hit', targetNodeID: 'end' },
  ],
});

const waitForReport = async (taskID) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = await TaskReportAPI({ taskID });
    if (report?.workflowStatus?.terminated) return report;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`本地条件运行超时: ${taskID}`);
};

const runPreparedSchema = async (schema, inputs) => {
  const payload = { schema: JSON.stringify(schema), inputs };
  const validation = await TaskValidateAPI(payload);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors || []));
  const { taskID } = await TaskRunAPI(payload);
  const report = await waitForReport(taskID);
  assert.equal(report.workflowStatus.status, 'succeeded');
  return report;
};

(async () => {
  ({
    TaskReportAPI,
    TaskRunAPI,
    TaskValidateAPI,
  } = await import('../demo-free-layout/node_modules/@flowgram.ai/runtime-js/dist/esm/index.js'));

  const reservedOrdinary = buildSchema();
  reservedOrdinary.nodes.find((node) => node.id === 'string_condition')
    .data.conditions[0].key = 'else';
  assert.throws(
    () => prepareConditionNodesForRuntime(reservedOrdinary),
    /分支不能使用保留端口 else/,
  );
  const reservedMultiBranch = buildSchema();
  reservedMultiBranch.nodes.find((node) => node.id === 'multi').data.branch[0].key = 'false';
  assert.throws(
    () => prepareConditionNodesForRuntime(reservedMultiBranch),
    /分支不能使用保留端口 false/,
  );
  const duplicateMultiBranch = buildSchema();
  duplicateMultiBranch.nodes.find((node) => node.id === 'multi').data.branch[0].key = 'same';
  duplicateMultiBranch.nodes.find((node) => node.id === 'multi').data.branch[1].key = 'same';
  assert.throws(
    () => prepareConditionNodesForRuntime(duplicateMultiBranch),
    /包含重复的分支 key: same/,
  );
  const whitespaceMultiBranch = buildSchema();
  whitespaceMultiBranch.nodes.find((node) => node.id === 'multi').data.branch[0].key = '   ';
  assert.throws(
    () => prepareConditionNodesForRuntime(whitespaceMultiBranch),
    /包含无效分支 key/,
  );

  const original = buildSchema();
  const prepared = prepareConditionNodesForRuntime(original);
  assert.equal(original.nodes.some((node) => node.type === 'multi-condition'), true);
  assert.equal(prepared.nodes.some((node) => node.type === 'multi-condition'), false);
  assert.equal(
    prepared.nodes.find((node) => node.id === 'string_condition')
      .data.conditions[0].value.right.content,
    '',
  );
  assert.equal(
    prepared.nodes.find((node) => node.id === 'string_empty_condition')
      .data.conditions[0].value.right.content,
    '',
  );
  assert.equal(
    prepared.nodes.filter((node) => node.type === 'condition').length,
    6,
    '两个普通条件加四个多条件原子应编译为六个条件节点',
  );

  // Old drafts can contain an atom with no key.  Verify against the real
  // runtime-js executor that its synthesized key is written into both the
  // condition entry and the generated true edge: a true atom must not also
  // fan out to the ELSE edge.
  const missingAtomKeyOriginal = buildSchema();
  missingAtomKeyOriginal.nodes.find((node) => node.id === 'multi').data.branch = [{
    logic: 'and',
    conditions: [{
      value: {
        left: { type: 'ref', content: ['start', 'score'] },
        operator: 'gt',
        right: { type: 'constant', content: 5 },
      },
    }],
  }];
  const missingAtomKeyPrepared = prepareConditionNodesForRuntime(missingAtomKeyOriginal);
  const missingAtomRuntimeNode = missingAtomKeyPrepared.nodes.find((node) => node.id === 'multi');
  const missingAtomKey = missingAtomRuntimeNode.data.conditions[0].key;
  assert.equal(missingAtomKey, 'condition_0_0');
  assert.equal(
    missingAtomKeyPrepared.edges.some((edge) => (
      edge.sourceNodeID === 'multi'
      && edge.sourcePortID === missingAtomKey
      && edge.targetNodeID === 'and_hit'
    )),
    true,
    '缺失原子 key 时，归一化 key 必须同时写入条件 entry 和真分支边',
  );
  assert.equal(
    missingAtomKeyPrepared.edges.some((edge) => (
      edge.sourceNodeID === 'multi'
      && edge.sourcePortID === 'else'
      && edge.targetNodeID === 'else_hit'
    )),
    true,
  );
  for (const testCase of [
    { score: 10, expected: 'and_hit', absent: 'else_hit', label: '真' },
    { score: 0, expected: 'else_hit', absent: 'and_hit', label: '假' },
  ]) {
    const missingKeyReport = await runPreparedSchema(
      missingAtomKeyPrepared,
      { score: testCase.score, region: 'CN' },
    );
    assert.equal(
      missingKeyReport.reports[testCase.expected]?.status,
      'succeeded',
      `缺 key 原子为${testCase.label}时必须只执行预期出口`,
    );
    assert.equal(
      missingKeyReport.reports[testCase.absent],
      undefined,
      `缺 key 原子为${testCase.label}时不得同时执行另一出口`,
    );
  }

  const report = await runPreparedSchema(prepared, { score: 25, region: 'CN' });
  assert.equal(report.reports.region_hit?.status, 'succeeded');
  assert.equal(report.reports.and_hit, undefined, 'AND 分支部分命中时不应执行成功出口');
  assert.equal(report.reports.else_hit, undefined, 'OR 分支命中后不应执行兜底出口');
  assert.equal(report.reports.empty_hit, undefined, '非空字符串不应进入空值兜底出口');

  const emptyReport = await runPreparedSchema(prepared, { score: 25 });
  assert.equal(emptyReport.reports.empty_hit?.status, 'succeeded');
  assert.equal(emptyReport.reports.region_hit, undefined, '缺失字符串不应进入多条件分支');
  assert.equal(emptyReport.reports.and_hit, undefined, '缺失字符串不应进入多条件 AND 分支');
  assert.equal(emptyReport.reports.else_hit, undefined, '缺失字符串应命中 is_empty 而非兜底出口');

  const andReport = await runPreparedSchema(prepared, { score: 10, region: 'CN' });
  assert.equal(andReport.reports.and_hit?.status, 'succeeded');
  assert.equal(andReport.reports.region_hit, undefined, 'AND 全真后不应继续执行后续 OR 分支');
  assert.equal(andReport.reports.else_hit, undefined, 'AND 全真后不应执行兜底出口');

  const firstOrReport = await runPreparedSchema(prepared, { score: 25, region: 'US' });
  assert.equal(firstOrReport.reports.region_hit?.status, 'succeeded');
  assert.equal(
    firstOrReport.reports.multi__ff_1_1,
    undefined,
    'OR 首项命中后不应再执行第二个原子',
  );
  assert.equal(firstOrReport.reports.else_hit, undefined, 'OR 首项命中后不应执行兜底出口');

  const elseReport = await runPreparedSchema(prepared, { score: 25, region: 'DE' });
  assert.equal(elseReport.reports.else_hit?.status, 'succeeded');
  assert.equal(elseReport.reports.and_hit, undefined, 'AND 未全真时不应执行成功出口');
  assert.equal(elseReport.reports.region_hit, undefined, 'OR 全假时不应执行成功出口');

  const explicitEmptyStringReport = await runPreparedSchema(
    prepared,
    { score: 25, region: '' },
  );
  assert.equal(explicitEmptyStringReport.reports.else_hit?.status, 'succeeded');
  assert.equal(
    explicitEmptyStringReport.reports.empty_hit,
    undefined,
    '与 Dify null/not-null 对齐：空字符串不是 null，应由 is_not_empty 分支继续执行',
  );

  const legacyOriginal = buildSchema();
  legacyOriginal.nodes.find((node) => node.id === 'multi').type = 'condition';
  delete legacyOriginal.nodes.find((node) => node.id === 'multi')
    .data.branch[1].conditions[0].key;
  legacyOriginal.nodes.find((node) => node.id === 'multi')
    .data.branch[1].conditions[1].key = 'else';
  const legacyPrepared = prepareConditionNodesForRuntime(legacyOriginal);
  assert.equal(
    legacyPrepared.nodes.some((node) => Array.isArray(node.data?.branch)),
    false,
    '旧版 type=condition + branch 草稿也应编译为 runtime 普通条件节点',
  );
  assert.equal(
    legacyPrepared.nodes.find((node) => node.id === 'multi').data.conditions.length,
    1,
  );
  const synthesizedKeyNode = legacyPrepared.nodes.find((node) => (
    node.data?.conditions?.[0]?.value?.operator === 'eq'
    && node.data.conditions[0].value.right?.content === 'CN'
  ));
  assert.equal(synthesizedKeyNode.data.conditions[0].key, 'condition_1_1');
  const missingKeyNode = legacyPrepared.nodes.find((node) => (
    node.data?.conditions?.[0]?.value?.operator === 'eq'
    && node.data.conditions[0].value.right?.content === 'US'
  ));
  assert.equal(missingKeyNode.data.conditions[0].key, 'condition_1_0');
  assert.equal(
    legacyPrepared.edges.some((edge) => (
      edge.sourceNodeID === synthesizedKeyNode.id
      && edge.sourcePortID === 'condition_1_1'
      && edge.targetNodeID === 'region_hit'
    )),
    true,
    '缺失或使用 else 保留字时，节点分支 key 与生成边端口必须一致',
  );
  const legacyReport = await runPreparedSchema(legacyPrepared, { score: 25, region: 'CN' });
  assert.equal(legacyReport.reports.region_hit?.status, 'succeeded');
  assert.equal(legacyReport.reports.and_hit, undefined, '旧草稿 AND 部分命中时不应执行成功出口');
  assert.equal(
    legacyReport.reports.else_hit,
    undefined,
    '缺失/保留原子 key 的旧草稿命中真分支后不应同时执行兜底出口',
  );

  process.stdout.write('condition local runtime passed: string nil semantics + current/legacy multi-condition truth table\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
