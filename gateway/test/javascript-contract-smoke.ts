import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { DifyConverterService } from '../src/converter/dify-converter.service';
import {
  analyzeSynchronousJavaScript as analyzeGatewayJavaScript,
} from '../src/converter/javascript-contract';
import {
  analyzeSynchronousJavaScript as analyzeBrowserJavaScript,
  prepareCodeNodesForRuntime,
} from '../../demo-free-layout/src/nodes/code/runtime';

const converter = new DifyConverterService();
(converter as any).logger = { log() {} };

const outputSchema = {
  type: 'object',
  properties: {
    result: { type: 'string' },
  },
};

const buildCodeFlow = (
  source: string,
  outputs: any = outputSchema,
) => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: {} } },
    },
    {
      id: 'code',
      type: 'code',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: '代码执行',
        inputsValues: {},
        inputs: { type: 'object', properties: {} },
        script: { language: 'javascript', content: source },
        outputs,
      },
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 600, y: 0 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['code', 'result'] } },
        inputs: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'code' },
    { sourceNodeID: 'code', targetNodeID: 'end' },
  ],
}) as any;

const buildBatchFlow = (source: string) => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: {} } },
    },
    {
      id: 'source',
      type: 'code',
      meta: { position: { x: 260, y: 0 } },
      data: {
        title: '生成数组',
        inputsValues: {},
        inputs: { type: 'object', properties: {} },
        script: {
          language: 'javascript',
          content: 'function main({ params }) { return { items: [1, 2, 3] }; }',
        },
        outputs: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'number' } } },
        },
      },
    },
    {
      id: 'batch',
      type: 'loop',
      meta: { position: { x: 560, y: 0 } },
      data: {
        title: '数组批处理',
        loopFor: { type: 'ref', content: ['source', 'items'] },
        loopOutputs: { result: { type: 'ref', content: ['batch_code', 'result'] } },
        outputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'number' } } },
        },
      },
      blocks: [
        { id: 'batch_start', type: 'block-start', data: {}, meta: { position: { x: 0, y: 0 } } },
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
                item: { type: 'number' },
                index: { type: 'number' },
              },
            },
            script: { language: 'javascript', content: source },
            outputs: {
              type: 'object',
              properties: { result: { type: 'number' } },
            },
          },
        },
        { id: 'batch_end', type: 'block-end', data: {}, meta: { position: { x: 520, y: 0 } } },
      ],
      edges: [
        { sourceNodeID: 'batch_start', targetNodeID: 'batch_code' },
        { sourceNodeID: 'batch_code', targetNodeID: 'batch_end' },
      ],
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 1100, y: 0 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['batch', 'result'] } },
        inputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'number' } } },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'source' },
    { sourceNodeID: 'source', targetNodeID: 'batch' },
    { sourceNodeID: 'batch', targetNodeID: 'end' },
  ],
}) as any;

const executeScript = (source: string, args: Record<string, unknown> = {}) => {
  const result = runInNewContext(
    `${source}\n;main(${JSON.stringify(args)});`,
    Object.create(null),
  );
  return JSON.parse(JSON.stringify(result));
};

const gatewayCode = (source: string, outputs: any = outputSchema): string => {
  const dsl = converter.toDifyDSL(buildCodeFlow(source, outputs));
  const code = dsl.workflow.graph.nodes.find((node) => node.id === 'code');
  assert.ok(code, '转换后缺少普通代码节点');
  return String(code.data.code);
};

const browserCode = (source: string, outputs: any = outputSchema): string => {
  const schema = buildCodeFlow(source, outputs);
  const prepared = prepareCodeNodesForRuntime(schema);
  assert.equal(
    schema.nodes[1].data.script.content,
    source,
    '浏览器运行预处理不应修改原画布对象',
  );
  return String(prepared.nodes[1].data.script.content);
};

const fakeMainPrefix = `// function main({ params }) { return { result: '注释伪函数' }; }
const fakeText = "function main({ params }) { return { result: '字符串伪函数' }; }";
const fakePattern = /function\\s+main\\s*\\(/;
function helper() { return fakeText + String(fakePattern); }
function main({ params }) { return { result: '真实结果' }; }`;

for (const analyze of [analyzeGatewayJavaScript, analyzeBrowserJavaScript]) {
  const analysis = analyze(fakeMainPrefix);
  assert.equal(analysis.mainDeclarationCount, 1);
  assert.equal(analysis.forbiddenSyntax, undefined);
  assert.equal(analyze('// Promise async await .then\n"function main("').mainDeclarationCount, 0);
  assert.equal(
    analyze('function outer() { function main({ params }) { return {}; } }').mainDeclarationCount,
    0,
  );
  assert.equal(
    analyze('const named = function main({ params }) { return {}; };').mainDeclarationCount,
    0,
  );
}

const generatedGatewayCode = gatewayCode(fakeMainPrefix);
assert.match(generatedGatewayCode, /注释伪函数/);
assert.match(generatedGatewayCode, /function main\(\{ params \}\)/);
assert.deepEqual(executeScript(generatedGatewayCode), { result: '真实结果' });
assert.deepEqual(executeScript(browserCode(fakeMainPrefix), { params: {} }), { result: '真实结果' });

const collisionSource = `
const __futureFlowUserMain = '用户变量';
const __futureFlowLocalMain = '用户变量';
function main({ params }) { return { result: __futureFlowUserMain + __futureFlowLocalMain }; }`;
assert.deepEqual(executeScript(gatewayCode(collisionSource)), { result: '用户变量用户变量' });
assert.deepEqual(executeScript(browserCode(collisionSource), { params: {} }), {
  result: '用户变量用户变量',
});

const invalidMainSources = [
  '// function main({ params }) {}',
  '/* function main({ params }) {} */',
  'const text = "function main({ params }) {}";',
  'const text = `function main({ params }) {}`;',
  'const pattern = /function\\s+main\\s*\\(/;',
  'const expression = function main({ params }) { return { result: "x" }; };',
  'function outer() { function main({ params }) { return { result: "x" }; } }',
];
for (const source of invalidMainSources) {
  assert.throws(() => converter.toDifyDSL(buildCodeFlow(source)), /必须声明顶层 function main/);
  assert.throws(() => prepareCodeNodesForRuntime(buildCodeFlow(source)), /必须声明顶层 function main/);
}

const forbiddenSources = [
  'async function main({ params }) { return { result: "x" }; }',
  'function main({ params }) { return Promise.resolve({ result: "x" }); }',
  'function main({ params }) { return fetch("/").then(() => ({ result: "x" })); }',
  'function main({ params }) { return { then() {}, result: "x" }; }',
];
for (const source of forbiddenSources) {
  assert.throws(
    () => converter.toDifyDSL(buildCodeFlow(source)),
    /仅支持同步 JavaScript|Promise|thenable/,
  );
  assert.throws(
    () => prepareCodeNodesForRuntime(buildCodeFlow(source)),
    /仅支持同步 JavaScript|Promise|thenable/,
  );
}

const asyncWordsInData = `
const note = 'async await Promise .then function main(';
// async function main() { return Promise.resolve(); }
function main({ params }) { return { result: note.slice(0, 5) }; }`;
assert.deepEqual(executeScript(gatewayCode(asyncWordsInData)), { result: 'async' });
assert.deepEqual(executeScript(browserCode(asyncWordsInData), { params: {} }), { result: 'async' });

const computedThenable = `
function main({ params }) {
  const key = 'th' + 'en';
  return { result: 'x', [key]: function () {} };
}`;
assert.throws(() => executeScript(gatewayCode(computedThenable)), /不能返回 Promise\/thenable/);
assert.throws(
  () => executeScript(browserCode(computedThenable), { params: {} }),
  /不能返回 Promise\/thenable/,
);

const validComplexOutputs = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    active: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    meta: {
      type: 'object',
      properties: { score: { type: 'number' } },
    },
  },
};
const validComplexSource = `function main({ params }) {
  return { title: 'ok', count: 2, active: true, tags: ['a', 'b'], meta: { score: 1.5 } };
}`;
const expectedComplex = {
  title: 'ok',
  count: 2,
  active: true,
  tags: ['a', 'b'],
  meta: { score: 1.5 },
};
assert.deepEqual(executeScript(gatewayCode(validComplexSource, validComplexOutputs)), expectedComplex);
assert.deepEqual(
  executeScript(browserCode(validComplexSource, validComplexOutputs), { params: {} }),
  expectedComplex,
);

const outputFailures: Array<[string, RegExp]> = [
  ['function main({ params }) { return {}; }', /result缺失/],
  ['function main({ params }) { return { result: 1 }; }', /result必须是字符串/],
  ['function main({ params }) { return { result: "ok", extra: 1 }; }', /extra未在输出声明中/],
  ['function main({ params }) { return "ok"; }', /输出必须是对象/],
  ['function main({ params }) { return null; }', /输出必须是对象/],
];
for (const [source, expected] of outputFailures) {
  assert.throws(() => executeScript(gatewayCode(source)), expected);
  assert.throws(() => executeScript(browserCode(source), { params: {} }), expected);
}

for (const numericValue of ['NaN', 'Infinity', '-Infinity']) {
  const source = `function main({ params }) { return { result: ${numericValue} }; }`;
  const outputs = { type: 'object', properties: { result: { type: 'number' } } };
  assert.throws(() => executeScript(gatewayCode(source, outputs)), /result必须是有限数字/);
  assert.throws(
    () => executeScript(browserCode(source, outputs), { params: {} }),
    /result必须是有限数字/,
  );
}

assert.deepEqual(
  executeScript(gatewayCode('function main({ params }) { return { result: null }; }')),
  { result: null },
);
assert.deepEqual(
  executeScript(browserCode('function main({ params }) { return { result: null }; }'), { params: {} }),
  { result: null },
);

const objectOutput = {
  type: 'object',
  properties: { result: { type: 'object', properties: {} } },
};
const nonPlainObjectSource =
  'function main({ params }) { return { result: new Date(0) }; }';
assert.throws(
  () => executeScript(gatewayCode(nonPlainObjectSource, objectOutput)),
  /result必须是对象/,
);
assert.throws(
  () => executeScript(browserCode(nonPlainObjectSource, objectOutput), { params: {} }),
  /result必须是对象/,
);

const unsupportedSchemas = [
  { type: 'object', properties: { result: { type: 'date' } } },
  { type: 'object', properties: { result: { type: 'array' } } },
  {
    type: 'object',
    properties: {
      result: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    },
  },
];
for (const outputs of unsupportedSchemas) {
  const source = 'function main({ params }) { return { result: "x" }; }';
  assert.throws(() => converter.toDifyDSL(buildCodeFlow(source, outputs)), /不支持|不能为空/);
  assert.throws(() => prepareCodeNodesForRuntime(buildCodeFlow(source, outputs)), /不支持|不能为空/);
}

const batchSource = `${fakeMainPrefix.replace("'真实结果'", 'params.item * 2')}`;
const batchDsl = converter.toDifyDSL(buildBatchFlow(batchSource));
const batchCodeNode = batchDsl.workflow.graph.nodes.find((node) => node.id === 'batch_code');
assert.ok(batchCodeNode, '转换后缺少批处理代码节点');
assert.deepEqual(
  executeScript(String(batchCodeNode.data.code), {
    __ff_item_0: 3,
    __ff_index_1: 0,
    __ff_iteration_index: 0,
  }),
  { result: 6 },
);

for (const source of invalidMainSources) {
  assert.throws(() => converter.toDifyDSL(buildBatchFlow(source)), /必须声明顶层 function main/);
}
for (const source of forbiddenSources) {
  assert.throws(
    () => converter.toDifyDSL(buildBatchFlow(source)),
    /仅支持同步 JavaScript|Promise|thenable/,
  );
}
assert.throws(
  () => executeScript(
    String(
      converter.toDifyDSL(buildBatchFlow(computedThenable))
        .workflow.graph.nodes.find((node) => node.id === 'batch_code')?.data.code,
    ),
    { __ff_item_0: 1, __ff_index_1: 0, __ff_iteration_index: 0 },
  ),
  /不能返回 Promise\/thenable/,
);

const nestedBrowserSchema = buildBatchFlow(
  'function main({ params }) { return { result: params.item * 2 }; }',
);
const nestedPrepared = prepareCodeNodesForRuntime(nestedBrowserSchema);
const nestedCode = nestedPrepared.nodes[2].blocks[1].data.script.content;
assert.match(nestedCode, /__futureFlowLocalMain/);
assert.deepEqual(executeScript(nestedCode, { params: { item: 4, index: 0 } }), { result: 8 });

const runQuickJsWorkflow = async (
  runtime: any,
  schema: any,
  silenceExpectedError = false,
): Promise<any> => {
  const originalConsoleError = console.error;
  if (silenceExpectedError) console.error = () => undefined;
  try {
    const input = { schema: JSON.stringify(schema), inputs: {} };
    const validation = await runtime.TaskValidateAPI(input);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors || []));
    const { taskID } = await runtime.TaskRunAPI(input);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const report = await runtime.TaskReportAPI({ taskID });
      if (report?.workflowStatus?.terminated) return report;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(`QuickJS 代码节点运行超时: ${taskID}`);
  } finally {
    console.error = originalConsoleError;
  }
};

const reportErrors = (report: any): string => Object.values(report.messages || {})
  .flat()
  .map((message: any) => String(message?.message || message))
  .join('\n');

const runQuickJsContractChecks = async () => {
  const runtimeUrl = pathToFileURL(resolve(
    __dirname,
    '../../demo-free-layout/node_modules/@flowgram.ai/runtime-js/dist/esm/index.js',
  )).href;
  const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
  const runtime = await nativeImport(runtimeUrl);

  const success = await runQuickJsWorkflow(
    runtime,
    prepareCodeNodesForRuntime(buildCodeFlow(fakeMainPrefix)),
  );
  assert.equal(success.workflowStatus.status, 'succeeded');
  assert.deepEqual(success.outputs, { result: '真实结果' });

  const missing = await runQuickJsWorkflow(
    runtime,
    prepareCodeNodesForRuntime(buildCodeFlow('function main({ params }) { return {}; }')),
    true,
  );
  assert.equal(missing.workflowStatus.status, 'failed');
  assert.match(reportErrors(missing), /result缺失/);

  const thenable = await runQuickJsWorkflow(
    runtime,
    prepareCodeNodesForRuntime(buildCodeFlow(computedThenable)),
    true,
  );
  assert.equal(thenable.workflowStatus.status, 'failed');
  assert.match(reportErrors(thenable), /不能返回 Promise\/thenable/);

  const batch = await runQuickJsWorkflow(
    runtime,
    prepareCodeNodesForRuntime(buildBatchFlow(
      'function main({ params }) { return { result: params.item * 2 }; }',
    )),
  );
  assert.equal(batch.workflowStatus.status, 'succeeded');
  assert.deepEqual(batch.outputs, { result: [2, 4, 6] });
};

runQuickJsContractChecks()
  .then(() => console.log('javascript contract smoke tests passed (Node adapter + QuickJS runtime)'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
