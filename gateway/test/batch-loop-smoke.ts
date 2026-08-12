import assert from 'node:assert/strict';

import { PermissionChecker } from '../src/auth/auth.module';
import { DifyConverterService } from '../src/converter/dify-converter.service';

const buildFlow = (options: {
  inputType?: 'string' | 'number';
  outputType?: 'string' | 'number' | 'boolean';
} = {}) => {
  const inputType = options.inputType || 'number';
  const outputType = options.outputType || 'number';
  const values = inputType === 'string' ? "['a', 'b']" : '[1, 2, 3]';
  const expression = outputType === 'string'
    ? "String(params.item) + '!'"
    : outputType === 'boolean'
      ? 'params.item > 1'
      : 'params.item * 2';
  return {
    nodes: [
      { id: 'start', type: 'start', meta: { position: { x: 0, y: 0 } }, data: { title: '开始' } },
      {
        id: 'source',
        type: 'code',
        meta: { position: { x: 300, y: 0 } },
        data: {
          title: '生成数组',
          inputsValues: {},
          script: {
            language: 'javascript',
            content: `function main({ params }) { return { items: ${values} }; }`,
          },
          outputs: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: inputType } } },
          },
        },
      },
      {
        id: 'batch',
        type: 'loop',
        meta: { position: { x: 600, y: 0 } },
        data: {
          title: '数组批处理',
          loopFor: { type: 'ref', content: ['source', 'items'] },
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
          { id: 'batch_start', type: 'block-start', meta: { position: { x: 0, y: 0 } }, data: {} },
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
              script: {
                language: 'javascript',
                content: `function main({ params }) { return { result: ${expression} }; }`,
              },
              outputs: {
                type: 'object',
                properties: { result: { type: outputType } },
              },
            },
          },
          { id: 'batch_end', type: 'block-end', meta: { position: { x: 520, y: 0 } }, data: {} },
        ],
        edges: [
          { sourceNodeID: 'batch_start', targetNodeID: 'batch_code' },
          { sourceNodeID: 'batch_code', targetNodeID: 'batch_end' },
        ],
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 1300, y: 0 } },
        data: {
          title: '结束',
          inputsValues: { result: { type: 'ref', content: ['batch', 'result'] } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'source' },
      { sourceNodeID: 'source', targetNodeID: 'batch' },
      { sourceNodeID: 'batch', targetNodeID: 'end' },
    ],
  } as any;
};

const converter = new DifyConverterService();
(converter as any).logger = { log() {} };

const permissions = new PermissionChecker();
assert.equal(permissions.checkNodePermissions('free', ['loop']).allowed, false);
assert.equal(permissions.checkNodePermissions('pro', ['loop']).allowed, true);
assert.equal(permissions.checkNodePermissions('enterprise', ['loop']).allowed, true);

for (const outputType of ['number', 'string', 'boolean'] as const) {
  const flow = buildFlow({
    inputType: outputType === 'string' ? 'string' : 'number',
    outputType,
  });
  const dsl = converter.toDifyDSL(flow);
  const node = (id: string) => dsl.workflow.graph.nodes.find((candidate) => candidate.id === id);
  const iteration = node('batch');
  const iterationStart = node('batch_start');
  const code = node('batch_code');

  assert.equal(dsl.workflow.graph.nodes.length, 6);
  assert.equal(iteration?.data.type, 'iteration');
  assert.deepEqual(iteration?.data.iterator_selector, ['source', 'items']);
  assert.deepEqual(iteration?.data.output_selector, ['batch_code', 'result']);
  assert.equal(
    iteration?.data.output_type,
    outputType === 'string' ? 'array[string]' : 'array[number]',
  );
  assert.equal(iteration?.data.is_parallel, false);
  assert.equal(iteration?.data.parallel_nums, 1);
  assert.equal(iterationStart?.data.type, 'iteration-start');
  assert.equal(iterationStart?.data.iteration_id, 'batch');
  assert.equal(code?.data.isInIteration, true);
  assert.deepEqual(code?.data.variables, [
    { variable: '__ff_item_0', value_selector: ['batch', 'item'] },
    { variable: '__ff_index_1', value_selector: ['batch', 'index'] },
    { variable: '__ff_iteration_index', value_selector: ['batch', 'index'] },
  ]);
  assert.match(code?.data.code, /__ffIndex >= 20/);
  assert.doesNotMatch(code?.data.code, /\.slice\s*\(/);
  assert.deepEqual(node('end')?.data.outputs, [
    { variable: 'result', value_selector: ['batch', 'output'] },
  ]);
  if (outputType === 'boolean') {
    assert.equal(code?.data.outputs.result.type, 'number');
    assert.match(code?.data.code, /Number\(Boolean\(__ffValue\)\)/);
  }

  const internal = dsl.workflow.graph.edges.find(
    (edge) => edge.source === 'batch_start' && edge.target === 'batch_code',
  );
  assert.equal(internal?.data.isInIteration, true);
  assert.equal(internal?.data.iteration_id, 'batch');
  assert.equal(internal?.data.sourceType, 'iteration-start');
  assert.equal(internal?.data.targetType, 'code');
}

const invalid = (mutate: (draft: any) => void, expected: RegExp) => {
  const draft = buildFlow();
  mutate(draft);
  assert.throws(() => converter.toDifyDSL(draft), expected);
};

invalid((flow) => { flow.nodes[2].blocks.pop(); }, /子画布必须固定/);
invalid((flow) => { flow.nodes[2].edges.pop(); }, /内部连线必须且只能有两条/);
invalid((flow) => { flow.nodes[2].blocks[1].type = 'http'; }, /仅允许一个同步 JavaScript/);
invalid((flow) => {
  flow.nodes[2].blocks[1].data.script.content =
    'async function main({ params }) { return { result: params.item }; }';
}, /暂不支持 async|必须同步执行/);
invalid((flow) => {
  flow.nodes[2].blocks[1].data.outputs.properties.extra = { type: 'number' };
}, /必须且只能声明一个输出/);
invalid((flow) => { flow.nodes[1].data.outputs.properties.items.items.type = 'object'; }, /输入仅支持/);
invalid((flow) => { flow.nodes[2].blocks[1].data.outputs.properties.result.type = 'object'; }, /逐项输出仅支持/);
invalid((flow) => { flow.nodes[2].data.outputs.properties.result.items.type = 'string'; }, /输出声明与批处理结果不一致/);
invalid((flow) => { flow.nodes[2].data.loopOutputs.result.content[1] = 'missing'; }, /唯一输出/);
invalid((flow) => {
  flow.nodes[2].blocks[1].data.inputsValues.item.content = ['source', 'items'];
}, /只能引用当前项 item 或序号 index/);
invalid((flow) => {
  flow.edges.push({ sourceNodeID: 'start', targetNodeID: 'batch' });
}, /必须来自所有执行路径都会经过的上游节点/);
invalid((flow) => {
  const second = structuredClone(flow.nodes[2]);
  second.id = 'batch_two';
  flow.nodes.push(second);
}, /最多只能使用一个节点/);

console.log('batch loop smoke tests passed');
