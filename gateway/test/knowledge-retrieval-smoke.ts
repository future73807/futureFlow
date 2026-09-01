/**
 * 知识检索（knowledge-retrieval）专项冒烟测试。
 *
 * 覆盖：knowledge 节点到 Dify knowledge-retrieval 的导出契约
 * （dataset_ids / query_variable_selector / retrieval_mode / top_k）、
 * End 节点引用 knowledge 输出、以及未选库/未选查询/非法 topK 的拒绝路径。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException } from '@nestjs/common';

import { DifyConverterService } from '../src/converter/dify-converter.service';
import { FlowGramJSON } from '../src/converter/types';

const converter = new DifyConverterService();
(converter as any).logger = { log() {} };

const DATASET_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

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
          query: { type: 'string', default: 'futureFlow 支持哪些模型？' },
        },
      },
    },
  };
}

function knowledgeNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'knowledge',
    meta: { position: { x: 300, y: 0 } },
    data: {
      title: '知识检索',
      datasetId: DATASET_ID,
      queryValue: { type: 'ref', content: ['start_1', 'query'] },
      topK: 4,
      outputs: {
        type: 'object',
        properties: {
          result: { type: 'array', items: { type: 'object' }, title: '检索结果' },
        },
      },
      ...overrides,
    },
  };
}

function endNode(id: string) {
  return {
    id,
    type: 'end',
    data: {
      title: 'End',
      inputsValues: {
        result: { type: 'ref', content: ['kb_1', 'result'] },
      },
    },
  };
}

function graph(node: any): FlowGramJSON {
  return {
    nodes: [startNode('start_1'), node, endNode('end_1')],
    edges: [
      { sourceNodeID: 'start_1', targetNodeID: 'kb_1' },
      { sourceNodeID: 'kb_1', targetNodeID: 'end_1' },
    ],
  };
}

function testKnowledgeExport() {
  const dsl = converter.toDifyDSL(graph(knowledgeNode('kb_1')));
  const node = dsl.workflow.graph.nodes.find((candidate: any) => candidate.id === 'kb_1');
  assert.ok(node, 'Dify DSL 必须包含知识检索节点');
  assert.equal(node.data.type, 'knowledge-retrieval');
  assert.deepEqual(node.data.dataset_ids, [DATASET_ID]);
  assert.deepEqual(node.data.query_variable_selector, ['start_1', 'query']);
  assert.equal(node.data.retrieval_mode, 'single');
  assert.equal(node.data.multiple_retrieval_config.top_k, 4);
  const edge = dsl.workflow.graph.edges.find((candidate: any) => candidate.source === 'kb_1');
  assert.ok(edge, '知识检索节点必须存在出口连线');
  assert.equal(edge.data.sourceType, 'knowledge-retrieval');
  assert.doesNotThrow(() => converter.toDifyDSLYaml(graph(knowledgeNode('kb_1'))));
}

function testRejectMissingDataset() {
  assert.throws(
    () => converter.toDifyDSL(graph(knowledgeNode('kb_1', { datasetId: '' }))),
    (error: unknown) => error instanceof BadRequestException && /尚未选择知识库/.test((error as Error).message),
  );
}

function testRejectInvalidDatasetId() {
  assert.throws(
    () => converter.toDifyDSL(graph(knowledgeNode('kb_1', { datasetId: 'not-a-uuid' }))),
    (error: unknown) => error instanceof BadRequestException && /ID 格式无效/.test((error as Error).message),
  );
}

function testRejectMissingQuery() {
  assert.throws(
    () => converter.toDifyDSL(graph(knowledgeNode('kb_1', { queryValue: { type: 'ref', content: [] } }))),
    (error: unknown) => error instanceof BadRequestException && /检索语句/.test((error as Error).message),
  );
}

function testRejectBadTopK() {
  assert.throws(
    () => converter.toDifyDSL(graph(knowledgeNode('kb_1', { topK: 11 }))),
    (error: unknown) => error instanceof BadRequestException && /1 到 10/.test((error as Error).message),
  );
}

function main() {
  testKnowledgeExport();
  testRejectMissingDataset();
  testRejectInvalidDatasetId();
  testRejectMissingQuery();
  testRejectBadTopK();
  console.log('knowledge-retrieval smoke passed');
}

main();
