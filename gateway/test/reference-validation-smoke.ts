import assert from 'node:assert/strict';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import { validateWorkflowReferences } from '../src/converter/workflow-reference-validator';
import { WorkflowsService } from '../src/workflows/workflows.service';

const baseFlow = () => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    },
    {
      id: 'producer',
      type: 'code',
      data: {
        title: '生成结果',
        inputsValues: { query: { type: 'ref', content: ['start', 'query'] } },
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string' },
            meta: {
              type: 'object',
              properties: { title: { type: 'string' } },
            },
          },
        },
      },
    },
    {
      id: 'consumer',
      type: 'text',
      data: {
        title: '读取结果',
        inputsValues: {
          text: { type: 'template', content: '{{producer.meta.title}}' },
        },
      },
    },
    {
      id: 'end',
      type: 'end',
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['consumer', 'text'] } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'producer' },
    { sourceNodeID: 'producer', targetNodeID: 'consumer' },
    { sourceNodeID: 'consumer', targetNodeID: 'end' },
  ],
});

const invalid = (mutate: (flow: ReturnType<typeof baseFlow>) => void, pattern: RegExp) => {
  const flow = baseFlow();
  mutate(flow);
  assert.throws(() => validateWorkflowReferences(flow as any), pattern);
};

validateWorkflowReferences(baseFlow() as any);

invalid((flow) => {
  (flow.nodes[2].data as any).inputsValues.text = {
    type: 'template',
    content: '{{ghost.result}}',
  };
}, /不存在或无效的节点 ghost/);

invalid((flow) => {
  (flow.nodes[2].data as any).inputsValues.text = {
    type: 'ref',
    content: ['producer', 'missing'],
  };
}, /不存在的输出 missing/);

invalid((flow) => {
  (flow.nodes[2].data as any).inputsValues.text = {
    type: 'ref',
    content: ['producer', 'meta', 'missing'],
  };
}, /不存在的输出路径 producer\.meta\.missing/);

invalid((flow) => {
  (flow.nodes[1].data as any).inputsValues.query = {
    type: 'ref',
    content: ['consumer', 'text'],
  };
}, /必须来自所有执行路径都会经过的上游节点/);

invalid((flow) => {
  flow.edges.push({ sourceNodeID: 'start', targetNodeID: 'consumer' });
}, /必须来自所有执行路径都会经过的上游节点/);

invalid((flow) => {
  (flow.nodes[2].data as any).inputsValues.text = {
    type: 'ref',
    content: ['global', 'userId'],
  };
}, /不支持 global 全局变量引用/);

invalid((flow) => {
  (flow.nodes[2].data as any).inputsValues.text = {
    type: 'template',
    content: '{{producer}}',
  };
}, /模板引用.*格式无效/);

const constantBraces = baseFlow();
(constantBraces.nodes[2].data as any).inputsValues.text = {
  type: 'constant',
  content: '{{这只是普通文本}}',
};
validateWorkflowReferences(constantBraces as any);

const startContractFlow = {
  nodes: [
    {
      id: 'typed_start',
      type: 'start',
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          required: ['count'],
          properties: {
            query: { type: 'string', title: '问题' },
            count: { type: 'integer', title: '数量' },
          },
        },
      },
    },
    {
      id: 'typed_code',
      type: 'code',
      data: {
        title: '代码',
        script: {
          language: 'javascript',
          content: 'function main({ params }) { return { result: 1 }; }',
        },
        outputs: { type: 'object', properties: { result: { type: 'number' } } },
      },
    },
    {
      id: 'typed_end',
      type: 'end',
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['typed_code', 'result'] } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'typed_start', targetNodeID: 'typed_code' },
    { sourceNodeID: 'typed_code', targetNodeID: 'typed_end' },
  ],
} as any;

const converter = new DifyConverterService();
const typedDsl = converter.toDifyDSL(startContractFlow);
assert.deepEqual(
  typedDsl.workflow.graph.nodes.find((node) => node.id === 'typed_start')?.data.variables,
  [
    {
      variable: 'query',
      label: '问题',
      type: 'paragraph',
      required: false,
      max_length: 50000,
      options: [],
    },
    {
      variable: 'count',
      label: '数量',
      type: 'number',
      required: true,
      max_length: 48,
      options: [],
    },
  ],
);

const workflowService = new WorkflowsService(
  {} as any,
  converter,
  {} as any,
  {} as any,
  {} as any,
  undefined,
);
assert.throws(
  () => (workflowService as any).applyInputOverrides(startContractFlow, {}),
  /缺少必填工作流输入参数: count/,
);
assert.throws(
  () => (workflowService as any).applyInputOverrides(startContractFlow, { count: 1.5 }),
  /必须是整数类型/,
);
assert.equal(
  (workflowService as any).applyInputOverrides(startContractFlow, { count: 2 })
    .nodes[0].data.inputsValues.count.content,
  2,
);

const booleanStart = JSON.parse(JSON.stringify(startContractFlow));
booleanStart.nodes[0].data.outputs.properties.count.type = 'boolean';
assert.throws(
  () => converter.toDifyDSL(booleanStart),
  /Dify 0\.15\.3 没有布尔输入类型/,
);

const legacyIdFlow = baseFlow() as any;
const legacyProducerId = 'producer-with-old-nanoid';
legacyIdFlow.nodes[1].id = legacyProducerId;
legacyIdFlow.nodes[1].data.script = {
  language: 'javascript',
  content: "function main({ params }) { return { result: params.query, meta: { title: '标题' } }; }",
};
legacyIdFlow.nodes[2].data.inputsValues.text.content = `{{${legacyProducerId}.meta.title}}`;
legacyIdFlow.edges = legacyIdFlow.edges.map((edge: any) => ({
  ...edge,
  sourceNodeID: edge.sourceNodeID === 'producer' ? legacyProducerId : edge.sourceNodeID,
  targetNodeID: edge.targetNodeID === 'producer' ? legacyProducerId : edge.targetNodeID,
}));
const legacyIdSnapshot = JSON.stringify(legacyIdFlow);
assert.doesNotThrow(() => converter.validateFlowGram(legacyIdFlow));
const legacyDsl = converter.toDifyDSL(legacyIdFlow);
const repeatedLegacyDsl = converter.toDifyDSL(legacyIdFlow);
const remappedProducer = legacyDsl.workflow.graph.nodes.find(
  (node) => node.data.title === '生成结果',
)!;
assert.match(remappedProducer.id, /^[A-Za-z0-9_]{1,50}$/);
assert.notEqual(remappedProducer.id, legacyProducerId);
assert.equal(remappedProducer.id.length, 47);
assert.deepEqual(
  repeatedLegacyDsl.workflow.graph.nodes.map((node) => node.id),
  legacyDsl.workflow.graph.nodes.map((node) => node.id),
  '同一个旧草稿每次发布必须得到稳定的 Dify 节点 ID',
);
assert.equal(JSON.stringify(legacyIdFlow), legacyIdSnapshot, '导出不得修改保存的旧草稿');
assert.doesNotMatch(JSON.stringify(legacyDsl), /producer-with-old-nanoid/);
const remappedConsumer = legacyDsl.workflow.graph.nodes.find(
  (node) => node.data.title === '读取结果',
)!;
assert.deepEqual(
  remappedConsumer.data.variables,
  [{ variable: '__ff_text_0', value_selector: [remappedProducer.id, 'meta', 'title'] }],
);
assert.equal(
  legacyDsl.workflow.graph.edges.some((edge) => (
    edge.source === remappedProducer.id && edge.target === remappedConsumer.id
  )),
  true,
  '旧 ID 的边与模板引用必须使用同一映射',
);

// Some old HTTP drafts stored template headers as bare strings rather than a
// FlowInputValue object. They are still parsed by the converter, so the
// export-only remap must rewrite them too.
const legacyRawHeaderFlow = JSON.parse(JSON.stringify(legacyIdFlow));
legacyRawHeaderFlow.nodes[2] = {
  id: 'consumer',
  type: 'http',
  data: {
    title: '旧版裸模板请求',
    api: {
      method: 'GET',
      url: { type: 'constant', content: 'https://example.com/probe' },
    },
    inputsValues: {
      headers: `X-Legacy: {{${legacyProducerId}.result}}`,
    },
    outputs: {
      type: 'object',
      properties: { body: { type: 'string' } },
    },
  },
};
legacyRawHeaderFlow.nodes[3].data.inputsValues = {
  result: { type: 'ref', content: ['consumer', 'body'] },
};
const legacyRawHeaderSnapshot = JSON.stringify(legacyRawHeaderFlow);
const legacyRawHeaderDsl = converter.toDifyDSL(legacyRawHeaderFlow);
const remappedRawHeaderNode = legacyRawHeaderDsl.workflow.graph.nodes.find(
  (node) => node.data.title === '旧版裸模板请求',
)!;
assert.equal(
  remappedRawHeaderNode.data.headers,
  `X-Legacy: {{#${remappedProducer.id}.result#}}`,
  '旧版裸字符串模板必须跟随节点 ID 映射',
);
assert.equal(JSON.stringify(legacyRawHeaderFlow), legacyRawHeaderSnapshot);
assert.equal(JSON.stringify(legacyRawHeaderDsl).includes(legacyProducerId), false);

const fiftyCharacterId = 'n'.repeat(50);
const fiftyCharacterFlow = JSON.parse(JSON.stringify(legacyIdFlow));
fiftyCharacterFlow.nodes[1].id = fiftyCharacterId;
fiftyCharacterFlow.nodes[2].data.inputsValues.text.content = `{{${fiftyCharacterId}.meta.title}}`;
fiftyCharacterFlow.edges = fiftyCharacterFlow.edges.map((edge: any) => ({
  ...edge,
  sourceNodeID: edge.sourceNodeID === legacyProducerId ? fiftyCharacterId : edge.sourceNodeID,
  targetNodeID: edge.targetNodeID === legacyProducerId ? fiftyCharacterId : edge.targetNodeID,
}));
assert.equal(
  converter.toDifyDSL(fiftyCharacterFlow).workflow.graph.nodes.find(
    (node) => node.data.title === '生成结果',
  )?.id,
  fiftyCharacterId,
  '50 位安全 ID 不应被改写',
);

const fiftyOneCharacterId = 'n'.repeat(51);
const fiftyOneCharacterFlow = JSON.parse(JSON.stringify(fiftyCharacterFlow));
fiftyOneCharacterFlow.nodes[1].id = fiftyOneCharacterId;
fiftyOneCharacterFlow.nodes[2].data.inputsValues.text.content = `{{${fiftyOneCharacterId}.meta.title}}`;
fiftyOneCharacterFlow.edges = fiftyOneCharacterFlow.edges.map((edge: any) => ({
  ...edge,
  sourceNodeID: edge.sourceNodeID === fiftyCharacterId ? fiftyOneCharacterId : edge.sourceNodeID,
  targetNodeID: edge.targetNodeID === fiftyCharacterId ? fiftyOneCharacterId : edge.targetNodeID,
}));
assert.match(
  converter.toDifyDSL(fiftyOneCharacterFlow).workflow.graph.nodes.find(
    (node) => node.data.title === '生成结果',
  )!.id,
  /^[A-Za-z0-9_]{1,50}$/,
  '超过模板边界但仍是合法画布长度的 ID 应稳定映射',
);

const overlongNodeIdFlow = JSON.parse(JSON.stringify(fiftyOneCharacterFlow));
overlongNodeIdFlow.nodes[1].id = 'n'.repeat(256);
assert.throws(
  () => converter.validateFlowGram(overlongNodeIdFlow),
  /节点 id 长度不能超过 255 位/,
);

const firstCollisionCandidate = (converter as any).remapDifyNodeIds({
  nodes: [{ id: 'legacy-collision', type: 'code', data: {} }],
  edges: [],
}).nodes[0].id;
const collisionGraph = {
  nodes: [
    { id: 'legacy-collision', type: 'code', data: {} },
    { id: firstCollisionCandidate, type: 'code', data: {} },
  ],
  edges: [{ sourceNodeID: 'legacy-collision', targetNodeID: firstCollisionCandidate }],
};
const collisionRemap = (converter as any).remapDifyNodeIds(collisionGraph);
assert.equal(collisionRemap.nodes[1].id, firstCollisionCandidate);
assert.notEqual(collisionRemap.nodes[0].id, firstCollisionCandidate);
assert.equal(new Set(collisionRemap.nodes.map((node: any) => node.id)).size, 2);
assert.deepEqual(
  (converter as any).remapDifyNodeIds(collisionGraph),
  collisionRemap,
  '安全 ID 冲突时的加盐映射也必须稳定',
);

const legacyLoopId = 'loop-with-old-nanoid';
const legacyLoopFlow = {
  nodes: [
    {
      id: 'loop-start-old',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: { title: '开始', outputs: { type: 'object', properties: {} } },
    },
    {
      id: 'array-source-old',
      type: 'code',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: '数组源',
        inputsValues: {},
        script: {
          language: 'javascript',
          content: "function main({ params }) { return { items: ['a', 'b'] }; }",
        },
        outputs: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    {
      id: legacyLoopId,
      type: 'loop',
      meta: { position: { x: 600, y: 0 } },
      data: {
        title: '旧草稿数组批处理',
        loopFor: { type: 'ref', content: ['array-source-old', 'items'] },
        loopOutputs: {
          result: { type: 'ref', content: ['batch-code-old', 'result'] },
        },
        outputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'string' } } },
        },
      },
      blocks: [
        {
          id: 'block-start-old',
          type: 'block-start',
          meta: { position: { x: 0, y: 0 } },
          data: {},
        },
        {
          id: 'batch-code-old',
          type: 'code',
          meta: { position: { x: 180, y: 0 } },
          data: {
            title: '逐项处理',
            inputsValues: {
              item: { type: 'ref', content: [`${legacyLoopId}_locals`, 'item'] },
              index: { type: 'ref', content: [`${legacyLoopId}_locals`, 'index'] },
            },
            script: {
              language: 'javascript',
              content: 'function main({ params }) { return { result: params.item + params.index }; }',
            },
            outputs: {
              type: 'object',
              properties: { result: { type: 'string' } },
            },
          },
        },
        {
          id: 'block-end-old',
          type: 'block-end',
          meta: { position: { x: 520, y: 0 } },
          data: {},
        },
      ],
      edges: [
        { sourceNodeID: 'block-start-old', targetNodeID: 'batch-code-old' },
        { sourceNodeID: 'batch-code-old', targetNodeID: 'block-end-old' },
      ],
    },
    {
      id: 'loop-end-old',
      type: 'end',
      meta: { position: { x: 1000, y: 0 } },
      data: {
        title: '结束',
        inputsValues: {
          result: { type: 'ref', content: [legacyLoopId, 'result'] },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'loop-start-old', targetNodeID: 'array-source-old' },
    { sourceNodeID: 'array-source-old', targetNodeID: legacyLoopId },
    { sourceNodeID: legacyLoopId, targetNodeID: 'loop-end-old' },
  ],
} as any;
const legacyLoopSnapshot = JSON.stringify(legacyLoopFlow);
const legacyLoopDsl = converter.toDifyDSL(legacyLoopFlow);
const legacyLoopNodes = legacyLoopDsl.workflow.graph.nodes;
assert.equal(
  legacyLoopNodes.every((node) => /^[A-Za-z0-9_]{1,50}$/.test(node.id)),
  true,
);
const remappedLoop = legacyLoopNodes.find((node) => node.data.type === 'iteration')!;
const remappedLoopStart = legacyLoopNodes.find((node) => node.data.type === 'iteration-start')!;
const remappedLoopCode = legacyLoopNodes.find((node) => node.data.title === '逐项处理')!;
const remappedLoopEnd = legacyLoopNodes.find((node) => node.data.type === 'end')!;
assert.equal(remappedLoop.data.start_node_id, remappedLoopStart.id);
assert.deepEqual(remappedLoop.data.output_selector, [remappedLoopCode.id, 'result']);
assert.equal(remappedLoopStart.parentId, remappedLoop.id);
assert.equal(remappedLoopStart.data.iteration_id, remappedLoop.id);
assert.equal(remappedLoopCode.parentId, remappedLoop.id);
assert.equal(remappedLoopCode.data.iteration_id, remappedLoop.id);
assert.deepEqual(remappedLoopCode.data.variables, [
  { variable: '__ff_item_0', value_selector: [remappedLoop.id, 'item'] },
  { variable: '__ff_index_1', value_selector: [remappedLoop.id, 'index'] },
  { variable: '__ff_iteration_index', value_selector: [remappedLoop.id, 'index'] },
]);
assert.deepEqual(remappedLoopEnd.data.outputs, [
  { variable: 'result', value_selector: [remappedLoop.id, 'output'] },
]);
const remappedInnerEdge = legacyLoopDsl.workflow.graph.edges.find(
  (edge) => edge.source === remappedLoopStart.id && edge.target === remappedLoopCode.id,
)!;
assert.equal(remappedInnerEdge.data.iteration_id, remappedLoop.id);
assert.doesNotMatch(JSON.stringify(legacyLoopDsl), /(?:loop|array|batch|block)-(?:with-|start|source|code|end|old)/);
assert.equal(JSON.stringify(legacyLoopFlow), legacyLoopSnapshot);

const chineseStartInput = JSON.parse(JSON.stringify(startContractFlow));
chineseStartInput.nodes[0].data.outputs.properties['中文变量'] = { type: 'string' };
assert.throws(
  () => converter.toDifyDSL(chineseStartInput),
  /开始节点输入 中文变量 的变量名不兼容 Dify/,
);

const overlongStartInput = JSON.parse(JSON.stringify(startContractFlow));
const thirtyOneCharacters = `a${'b'.repeat(30)}`;
overlongStartInput.nodes[0].data.outputs.properties[thirtyOneCharacters] = { type: 'string' };
assert.throws(
  () => converter.toDifyDSL(overlongStartInput),
  /开始节点输入 .*变量名不兼容 Dify/,
);

const thirtyCharacters = `a${'b'.repeat(29)}`;
const legalStartInput = JSON.parse(JSON.stringify(startContractFlow));
legalStartInput.nodes[0].data.outputs.properties[thirtyCharacters] = { type: 'string' };
legalStartInput.nodes[1].data.inputsValues = {
  value: { type: 'ref', content: ['typed_start', thirtyCharacters] },
};
legalStartInput.nodes[1].data.inputs = {
  type: 'object',
  properties: { value: { type: 'string' } },
};
const legalDsl = converter.toDifyDSL(legalStartInput);
assert.deepEqual(
  legalDsl.workflow.graph.nodes.find((node) => node.id === 'typed_code')?.data.variables,
  [{ variable: '__ff_value_0', value_selector: ['typed_start', thirtyCharacters] }],
);

assert.doesNotThrow(
  () => (converter as any).normalizeDifyTemplateSelector(
    ['typed_code', 'result', ...Array.from({ length: 9 }, (_, index) => `field${index}`)],
    [],
  ),
  '模板 selector 恰好 10 个属性段时应合法',
);
assert.throws(
  () => (converter as any).normalizeDifyTemplateSelector(
    ['typed_code', 'result', ...Array.from({ length: 10 }, (_, index) => `field${index}`)],
    [],
  ),
  /属性层级超过 Dify 支持的 10 层/,
);
const nativeArraySelector = [
  'iteration-1',
  'result-with-hyphen',
  ...Array.from({ length: 12 }, (_, index) => `field-${index}`),
];
assert.deepEqual(
  (converter as any).normalizeDifySelector(nativeArraySelector, []),
  nativeArraySelector,
  'Dify 原生数组 selector 不应误套模板字符串的字符与层级限制',
);

process.stdout.write(
  'reference validation passed: selectors, dominance, Start contracts, Dify selector limits\n',
);
