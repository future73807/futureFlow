/**
 * 失败分支（fail-branch）专项冒烟测试。
 *
 * 覆盖：LLM/API 请求/代码执行节点开启 failBranchEnabled 后导出 Dify
 * error_strategy=fail-branch；onError 连线映射为 fail-branch 输出柄；
 * 未开启节点、不支持类型、非布尔开关的拒绝路径。
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

function startNode(id: string) {
  return {
    id,
    type: 'start',
    meta: { position: { x: 0, y: 0 } },
    data: {
      title: 'Start',
      outputs: {
        type: 'object',
        properties: {
          query: { type: 'string', default: 'hello' },
        },
      },
    },
  };
}

function llmNode(id: string, options: { failBranchEnabled?: boolean } = {}) {
  return {
    id,
    type: 'llm',
    meta: { position: { x: 300, y: 0 } },
    data: {
      title: 'LLM',
      ...(options.failBranchEnabled === undefined ? {} : { failBranchEnabled: options.failBranchEnabled }),
      inputsValues: {
        modelName: value('deepseek-chat'),
        temperature: value(0.5),
        systemPrompt: value(''),
        prompt: { type: 'template' as const, content: 'hi' },
      },
    },
  };
}

function httpNode(id: string, options: { failBranchEnabled?: boolean } = {}) {
  return {
    id,
    type: 'http',
    meta: { position: { x: 320, y: 40 } },
    data: {
      title: 'HTTP',
      ...(options.failBranchEnabled === undefined ? {} : { failBranchEnabled: options.failBranchEnabled }),
      api: {
        method: 'GET',
        url: { type: 'constant' as const, content: 'https://example.com/ping' },
      },
      timeout: { timeout: 30000, retryTimes: 0 },
    },
  };
}

function codeNode(id: string, options: { failBranchEnabled?: boolean } = {}) {
  return {
    id,
    type: 'code',
    meta: { position: { x: 340, y: 80 } },
    data: {
      title: 'Code',
      ...(options.failBranchEnabled === undefined ? {} : { failBranchEnabled: options.failBranchEnabled }),
      script: { language: 'javascript', content: 'function main({ params }) { return { result: 1 }; }' },
      inputsValues: { input: value('1') },
      outputs: { type: 'object', properties: { result: { type: 'number' } } },
    },
  };
}

function endNode(id: string, variable: string, ref: string) {
  return {
    id,
    type: 'end',
    data: {
      title: 'End',
      inputsValues: {
        [variable]: { type: 'ref' as const, content: ref.split('.') },
      },
    },
  };
}

function edge(source: string, target: string, sourcePortID?: string) {
  return {
    sourceNodeID: source,
    targetNodeID: target,
    ...(sourcePortID ? { sourcePortID } : {}),
  };
}

function failBranchGraph(): FlowGramJSON {
  return {
    nodes: [
      startNode('start_1'),
      llmNode('llm_1', { failBranchEnabled: true }),
      endNode('end_main', 'result', 'llm_1.result'),
      endNode('end_fail', 'result', 'llm_1.result'),
    ],
    edges: [
      edge('start_1', 'llm_1'),
      edge('llm_1', 'end_main'),
      edge('llm_1', 'end_fail', 'onError'),
    ],
  };
}

function nodeData(dsl: any, id: string): any {
  const node = dsl.workflow.graph.nodes.find((candidate: any) => candidate.id === id);
  assert.ok(node, `Dify DSL 必须包含节点 ${id}`);
  return node.data;
}

function edgeOf(dsl: any, source: string, sourceHandle: string): any {
  const found = dsl.workflow.graph.edges.filter(
    (candidate: any) => candidate.source === source && candidate.sourceHandle === sourceHandle,
  );
  return found;
}

function testLlmFailBranchExport() {
  const dsl = converter.toDifyDSL(failBranchGraph());
  assert.equal(nodeData(dsl, 'llm_1').error_strategy, 'fail-branch');
  assert.equal(edgeOf(dsl, 'llm_1', 'fail-branch').length, 1, 'onError 连线必须导出 fail-branch 输出柄');
  assert.equal(edgeOf(dsl, 'llm_1', 'source').length, 1, '主出口连线必须保持 source 输出柄');
  assert.doesNotThrow(() => converter.toDifyDSLYaml(failBranchGraph()));
}

function testHttpAndCodeFailBranchExport() {
  const graph: FlowGramJSON = {
    nodes: [
      startNode('start_1'),
      httpNode('http_1', { failBranchEnabled: true }),
      endNode('end_main', 'result', 'http_1.body'),
      endNode('end_fail', 'result', 'http_1.body'),
    ],
    edges: [
      edge('start_1', 'http_1'),
      edge('http_1', 'end_main'),
      edge('http_1', 'end_fail', 'onError'),
    ],
  };
  const dsl = converter.toDifyDSL(graph);
  assert.equal(nodeData(dsl, 'http_1').error_strategy, 'fail-branch');
  assert.equal(edgeOf(dsl, 'http_1', 'fail-branch').length, 1);

  const codeGraph: FlowGramJSON = {
    nodes: [
      startNode('start_1'),
      codeNode('code_1', { failBranchEnabled: true }),
      endNode('end_main', 'result', 'code_1.result'),
      endNode('end_fail', 'result', 'code_1.result'),
    ],
    edges: [
      edge('start_1', 'code_1'),
      edge('code_1', 'end_main'),
      edge('code_1', 'end_fail', 'onError'),
    ],
  };
  const codeDsl = converter.toDifyDSL(codeGraph);
  assert.equal(nodeData(codeDsl, 'code_1').error_strategy, 'fail-branch');
  assert.equal(edgeOf(codeDsl, 'code_1', 'fail-branch').length, 1);
}

function testDisabledNodesStayUnchanged() {
  const graph: FlowGramJSON = {
    nodes: [
      startNode('start_1'),
      llmNode('llm_1'),
      endNode('end_main', 'result', 'llm_1.result'),
    ],
    edges: [edge('start_1', 'llm_1'), edge('llm_1', 'end_main')],
  };
  const dsl = converter.toDifyDSL(graph);
  assert.equal(
    'error_strategy' in nodeData(dsl, 'llm_1'),
    false,
    '未开启失败分支的节点不得导出 error_strategy',
  );
}

function testRejectOnErrorWithoutEnabledFlag() {
  const graph: FlowGramJSON = {
    nodes: [
      startNode('start_1'),
      llmNode('llm_1'),
      endNode('end_main', 'result', 'llm_1.result'),
      endNode('end_fail', 'result', 'llm_1.result'),
    ],
    edges: [
      edge('start_1', 'llm_1'),
      edge('llm_1', 'end_main'),
      edge('llm_1', 'end_fail', 'onError'),
    ],
  };
  assert.throws(
    () => converter.toDifyDSL(graph),
    (error: unknown) => error instanceof BadRequestException && /未开启失败分支/.test((error as Error).message),
  );
}

function testRejectUnsupportedNodeType() {
  const graph: FlowGramJSON = {
    nodes: [
      startNode('start_1'),
      {
        id: 'text_1',
        type: 'text',
        data: {
          title: '文本',
          failBranchEnabled: true,
          inputsValues: { text: { type: 'constant', content: 'hi' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      endNode('end_main', 'text', 'text_1.text'),
    ],
    edges: [edge('start_1', 'text_1'), edge('text_1', 'end_main')],
  };
  assert.throws(
    () => converter.toDifyDSL(graph),
    (error: unknown) => error instanceof BadRequestException && /类型不支持失败分支/.test((error as Error).message),
  );
}

function testRejectNonBooleanFlag() {
  const graph = failBranchGraph();
  (graph.nodes[1].data as any).failBranchEnabled = 'yes';
  assert.throws(
    () => converter.toDifyDSL(graph),
    (error: unknown) => error instanceof BadRequestException && /必须是布尔值/.test((error as Error).message),
  );
}

function main() {
  testLlmFailBranchExport();
  testHttpAndCodeFailBranchExport();
  testDisabledNodesStayUnchanged();
  testRejectOnErrorWithoutEnabledFlag();
  testRejectUnsupportedNodeType();
  testRejectNonBooleanFlag();
  console.log('fail-branch smoke passed');
}

main();
