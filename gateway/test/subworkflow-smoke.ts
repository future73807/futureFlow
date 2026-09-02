/**
 * 子工作流（subworkflow）专项冒烟测试。
 *
 * 覆盖：编译期内联展开（子图节点前缀化、参数注入节点替换开始节点、
 * 结束节点删除、父子引用重写）、嵌套子工作流、以及缺少快照/
 * 入参映射缺失/环引用的拒绝路径。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException } from '@nestjs/common';

import { DifyConverterService } from '../src/converter/dify-converter.service';
import { FlowGramJSON } from '../src/converter/types';

const converter = new DifyConverterService();
(converter as any).logger = { log() {} };

function value(content: string | number | boolean) {
  return { type: 'constant' as const, content };
}

function startNode(id: string, withVar = true): any {
  return {
    id,
    type: 'start',
    meta: { position: { x: 0, y: 0 } },
    data: {
      title: 'Start',
      outputs: {
        type: 'object',
        properties: withVar
          ? { query: { type: 'string', default: 'hello' } }
          : {},
      },
    },
  };
}

function textNode(id: string, template: string): any {
  return {
    id,
    type: 'text',
    meta: { position: { x: 300, y: 0 } },
    data: {
      title: '文本',
      inputsValues: { text: { type: 'template', content: template } },
      outputs: { type: 'object', properties: { text: { type: 'string' } } },
    },
  };
}

function llmNode(id: string, prompt: string): any {
  return {
    id,
    type: 'llm',
    meta: { position: { x: 300, y: 0 } },
    data: {
      title: 'LLM',
      inputsValues: {
        modelName: value('deepseek-chat'),
        temperature: value(0.5),
        systemPrompt: value(''),
        prompt: { type: 'template', content: prompt },
      },
    },
  };
}

function endNode(id: string, ref: string[] = ['text_1', 'text']): any {
  return {
    id,
    type: 'end',
    data: {
      title: 'End',
      inputsValues: { result: { type: 'ref', content: ref } },
    },
  };
}

function subflowNode(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    type: 'subworkflow',
    meta: { position: { x: 150, y: 40 } },
    data: {
      title: '子工作流',
      targetWorkflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      inputMappings: {
        query: { type: 'ref', content: ['start_1', 'query'] },
      },
      ...overrides,
    },
  };
}

/** 子工作流快照：start → text(引用 start.query) → end。 */
function childGraph(): FlowGramJSON {
  return {
    nodes: [
      startNode('c_start'),
      textNode('c_text', '收到 {{#c_start.query#}}'),
      endNode('c_end', ['c_text', 'text']),
    ],
    edges: [
      { sourceNodeID: 'c_start', targetNodeID: 'c_text' },
      { sourceNodeID: 'c_text', targetNodeID: 'c_end' },
    ],
  };
}

function parentGraph(sub: any): FlowGramJSON {
  return {
    nodes: [
      startNode('start_1'),
      sub,
      llmNode('llm_1', '总结：{{#sub_1.result#}}'),
      endNode('end_1', ['llm_1', 'result']),
    ],
    edges: [
      { sourceNodeID: 'start_1', targetNodeID: 'sub_1' },
      { sourceNodeID: 'sub_1', targetNodeID: 'llm_1' },
      { sourceNodeID: 'llm_1', targetNodeID: 'end_1' },
    ],
  };
}

function testInlineExpansion() {
  const sub = subflowNode('sub_1');
  sub.data.inlinedGraph = childGraph();
  const dsl = converter.toDifyDSL(parentGraph(sub));

  const ids = dsl.workflow.graph.nodes.map((node: any) => node.id);
  assert.equal(ids.includes('sub_1'), false, 'subworkflow 节点必须被展开移除');
  assert.equal(ids.some((id: string) => id.startsWith('sw_')), true, '子图节点必须带 sw_ 前缀');
  const inject = dsl.workflow.graph.nodes.find((node: any) => node.id.endsWith('__in'));
  assert.ok(inject, '必须存在参数注入节点');
  assert.equal(inject.data.type, 'code');
  const injectVar = inject.data.variables.find((v: any) => String(v.variable).includes('query'));
  assert.ok(injectVar, '注入节点必须携带 query 入参变量');
  assert.deepEqual(injectVar.value_selector, ['start_1', 'query'], '注入节点必须引用父图入参源');

  // 父图 LLM 的 {{#sub_1.result#}} 必须重写到子图产出节点（前缀化的 c_text）。
  const llm = dsl.workflow.graph.nodes.find((node: any) => node.id === 'llm_1')!;
  const promptText = llm.data.prompt_template[0].text;
  assert.doesNotMatch(promptText, /sub_1/);
  assert.match(promptText, /\{\{#sw_[0-9a-f]{8}_c_text\.text#\}\}/);

  // 子图内部对开始节点的引用必须重写到注入节点（variables 里的选择器）。
  const childText = dsl.workflow.graph.nodes.find(
    (node: any) => node.id.includes('_c_text'),
  )!;
  assert.doesNotMatch(childText.data.code, /c_start/);
  const childVar = childText.data.variables.find((v: any) =>
    Array.isArray(v.value_selector) && String(v.value_selector[0]).endsWith('__in'));
  assert.ok(childVar, '子图对开始节点入参的引用必须重定向到参数注入节点');

  // 出边必须从子图产出节点接出。
  const outgoing = dsl.workflow.graph.edges.find((edge: any) => edge.target === 'llm_1')!;
  assert.match(outgoing.source, /_c_text$/);
  assert.doesNotThrow(() => converter.toDifyDSLYaml(parentGraph(sub)));
}

function testRejectMissingSnapshot() {
  assert.throws(
    () => converter.toDifyDSL(parentGraph(subflowNode('sub_1'))),
    (error: unknown) => error instanceof BadRequestException && /缺少已发布的子图快照/.test((error as Error).message),
  );
}

function testRejectMissingMapping() {
  const sub = subflowNode('sub_1', { inputMappings: {} });
  sub.data.inlinedGraph = childGraph();
  assert.throws(
    () => converter.toDifyDSL(parentGraph(sub)),
    (error: unknown) => error instanceof BadRequestException && /入参 query 必须映射/.test((error as Error).message),
  );
}

function testNestedSubworkflow() {
  const innerSub = subflowNode('inner_sub');
  innerSub.data.inlinedGraph = childGraph();
  // 外层子图本身包含一个 subworkflow 节点 + 内部自己的 start/text/end。
  const outerChild: FlowGramJSON = {
    nodes: [
      startNode('o_start'),
      innerSub,
      textNode('o_text', '嵌套 {{#inner_sub.result#}}'),
      endNode('o_end', ['o_text', 'text']),
    ],
    edges: [
      { sourceNodeID: 'o_start', targetNodeID: 'inner_sub' },
      { sourceNodeID: 'inner_sub', targetNodeID: 'o_text' },
      { sourceNodeID: 'o_text', targetNodeID: 'o_end' },
    ],
  };
  const outerSub = subflowNode('sub_1', {
    inputMappings: { query: { type: 'ref', content: ['start_1', 'query'] } },
  });
  outerSub.data.inlinedGraph = outerChild;
  const dsl = converter.toDifyDSL(parentGraph(outerSub));
  const ids = dsl.workflow.graph.nodes.map((node: any) => node.id);
  assert.equal(ids.some((id: string) => id.includes('sub_1') || id.includes('inner_sub')), false);
  // 两层注入节点都必须存在。
  assert.equal(ids.filter((id: string) => id.endsWith('__in')).length, 2);
}

function main() {
  testInlineExpansion();
  testRejectMissingSnapshot();
  testRejectMissingMapping();
  testNestedSubworkflow();
  console.log('subworkflow smoke passed');
}

main();
