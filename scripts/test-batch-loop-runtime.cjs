const assert = require('node:assert/strict');

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const buildSchema = (items, outputType = 'number') => ({
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
            items: {
              type: 'array',
              items: { type: typeof items[0] === 'string' ? 'string' : 'number' },
            },
          },
        },
      },
    },
    {
      id: 'batch',
      type: 'loop',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: '数组批处理',
        loopFor: { type: 'ref', content: ['start', 'items'] },
        loopOutputs: {
          result: { type: 'ref', content: ['batch_code', 'result'] },
        },
        outputs: {
          type: 'object',
          properties: {
            result: {
              type: 'array',
              items: { type: outputType === 'boolean' ? 'number' : outputType },
            },
          },
        },
      },
      blocks: [
        {
          id: 'batch_start',
          type: 'block-start',
          meta: { position: { x: 0, y: 0 } },
          data: {},
        },
        {
          id: 'batch_code',
          type: 'code',
          meta: { position: { x: 180, y: 0 } },
          data: {
            title: '逐项处理',
            inputsValues: {
              item: { type: 'ref', content: ['batch_locals', 'item'] },
              index: { type: 'ref', content: ['batch_locals', 'index'] },
            },
            inputs: {
              type: 'object',
              properties: {
                item: { type: typeof items[0] === 'string' ? 'string' : 'number' },
                index: { type: 'number' },
              },
            },
            script: {
              language: 'javascript',
              content: outputType === 'boolean'
                ? 'function main({ params }) { return { result: params.item > 1 }; }'
                : 'function main({ params }) { return { result: params.item * 2 }; }',
            },
            outputs: {
              type: 'object',
              properties: { result: { type: outputType } },
            },
          },
        },
        {
          id: 'batch_end',
          type: 'block-end',
          meta: { position: { x: 520, y: 0 } },
          data: {},
        },
      ],
      edges: [
        { sourceNodeID: 'batch_start', targetNodeID: 'batch_code' },
        { sourceNodeID: 'batch_code', targetNodeID: 'batch_end' },
      ],
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 1000, y: 0 } },
      data: {
        title: '结束',
        inputsValues: {
          result: { type: 'ref', content: ['batch', 'result'] },
        },
        inputs: {
          type: 'object',
          properties: {
            result: {
              type: 'array',
              items: { type: outputType === 'boolean' ? 'number' : outputType },
            },
          },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'batch' },
    { sourceNodeID: 'batch', targetNodeID: 'end' },
  ],
});

const waitForReport = async (taskID) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = await TaskReportAPI({ taskID });
    if (report?.workflowStatus?.terminated) return report;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`本地数组批处理运行超时: ${taskID}`);
};

const run = async (items, outputType = 'number') => {
  const schema = buildSchema(items, outputType);
  const input = { schema: JSON.stringify(schema), inputs: { items } };
  const validation = await TaskValidateAPI(input);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors || []));
  const { taskID } = await TaskRunAPI(input);
  return waitForReport(taskID);
};

(async () => {
  ({
    TaskReportAPI,
    TaskRunAPI,
    TaskValidateAPI,
  } = await import('../demo-free-layout/node_modules/@flowgram.ai/runtime-js/dist/esm/index.js'));

  const numberReport = await run([1, 2, 3]);
  assert.equal(numberReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(numberReport.outputs, { result: [2, 4, 6] });

  const emptyReport = await run([]);
  assert.equal(emptyReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(emptyReport.outputs, { result: [] });

  const booleanReport = await run([0, 2, 3], 'boolean');
  assert.equal(booleanReport.workflowStatus.status, 'succeeded');
  assert.deepEqual(booleanReport.outputs, { result: [0, 1, 1] });

  const oversizedReport = await run(Array.from({ length: 21 }, (_, index) => index + 1));
  assert.equal(oversizedReport.workflowStatus.status, 'failed');
  assert.deepEqual(oversizedReport.outputs, {});
  const errorText = Object.values(oversizedReport.messages || {})
    .flat()
    .map((message) => message.message)
    .join('\n');
  assert.match(errorText, /最多支持 20 项/);
  assert.doesNotMatch(errorText, /截取|truncate/i);

  process.stdout.write('batch loop local runtime passed: number=[2,4,6], empty=[], boolean=[0,1,1], 21-items=rejected\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
