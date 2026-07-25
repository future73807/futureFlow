import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException } from '@nestjs/common';

import { DifyConverterService } from '../src/converter/dify-converter.service';
import { FlowGramJSON } from '../src/converter/types';

/**
 * Deterministic graph and conversion regression suite. The fixed seed makes
 * every failing generated workflow reproducible in CI and on a workstation.
 */
const SEED = 0x5eedc0de;
const requestedCaseCount = Number.parseInt(process.env.FUTUREFLOW_FUZZ_CASES || '10000', 10);
const CASES_PER_CLASS = Number.isSafeInteger(requestedCaseCount) && requestedCaseCount > 0
  ? Math.min(requestedCaseCount, 100_000)
  : 10_000;
const VALID_CASES = CASES_PER_CLASS;
const INVALID_CASES = CASES_PER_CLASS;

class Random {
  private state = SEED;

  next() {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(max: number) {
    return Math.floor(this.next() * max);
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)];
  }
}

const random = new Random();
const converter = new DifyConverterService();

// The converter logs each successful export in production. Suppress that
// observability stream here so 20,000 regression cases measure behavior, not
// terminal throughput.
(converter as any).logger = { log() {} };

function value(content: string | number | boolean) {
  return { type: 'constant' as const, content };
}

function startNode(id: string, index: number) {
  return {
    id,
    type: 'start',
    meta: { position: { x: index % 997, y: index % 313 } },
    data: {
      title: 'Start',
      outputs: {
        type: 'object',
        properties: {
          query: { type: 'string', default: `query-${index}` },
          score: { type: 'number', default: index % 101 },
          approved: { type: 'boolean', default: index % 2 === 0 },
        },
      },
    },
  };
}

function llmNode(id: string, index: number, prompt: string) {
  return {
    id,
    type: 'llm',
    meta: { position: { x: index % 541, y: index % 887 } },
    data: {
      title: 'LLM',
      inputsValues: {
        modelName: value(random.pick(['deepseek-chat', 'gpt-4o-mini', 'qwen-plus', 'custom-model'])),
        temperature: value(Number((random.next() * 2).toFixed(3))),
        systemPrompt: value(index % 3 === 0 ? 'System {{start.query}}' : ''),
        prompt: { type: 'template' as const, content: prompt },
      },
    },
  };
}

function endNode(id: string, output = 'result') {
  return {
    id,
    type: 'end',
    data: {
      title: 'End',
      outputs: { type: 'object', properties: { [output]: { type: 'string' } } },
    },
  };
}

function validFlow(index: number): FlowGramJSON {
  const kind = index % 3;
  const start = startNode(`start_${index}`, index);
  if (kind === 0) {
    const llm = llmNode(
      `llm_${index}`,
      index,
      index % 2 ? `{{${start.id}.query}}` : '{{#start.query#}}',
    );
    const end = endNode(`end_${index}`);
    return {
      nodes: [start, llm, end] as any,
      edges: [
        { sourceNodeID: start.id, targetNodeID: llm.id },
        { sourceNodeID: llm.id, targetNodeID: end.id },
      ],
    };
  }

  if (kind === 1) {
    const conditionId = `condition_${index}`;
    const conditionKey = `approved_${index}`;
    const accepted = llmNode(`accepted_${index}`, index, `accepted {{${start.id}.query}}`);
    const rejected = llmNode(`rejected_${index}`, index, `rejected {{${start.id}.query}}`);
    const acceptedEnd = endNode(`accepted_end_${index}`);
    const rejectedEnd = endNode(`rejected_end_${index}`);
    return {
      nodes: [
        start,
        {
          id: conditionId,
          type: 'condition',
          data: {
            title: 'Condition',
            conditions: [{
              key: conditionKey,
              value: {
                left: { type: 'ref', content: [start.id, 'approved'] },
                operator: 'is',
                right: value(index % 2 === 0),
              },
            }],
          },
        },
        accepted,
        rejected,
        acceptedEnd,
        rejectedEnd,
      ] as any,
      edges: [
        { sourceNodeID: start.id, targetNodeID: conditionId },
        { sourceNodeID: conditionId, targetNodeID: accepted.id, sourcePortID: conditionKey },
        { sourceNodeID: conditionId, targetNodeID: rejected.id, sourcePortID: 'else' },
        { sourceNodeID: accepted.id, targetNodeID: acceptedEnd.id },
        { sourceNodeID: rejected.id, targetNodeID: rejectedEnd.id },
      ],
    };
  }

  const httpId = `http_${index}`;
  const codeId = `code_${index}`;
  const end = endNode(`end_${index}`, 'score');
  return {
    nodes: [
      start,
      {
        id: httpId,
        type: 'http',
        data: {
          title: 'HTTP',
          inputsValues: {
            method: value(random.pick(['get', 'post', 'patch'])),
            url: value(`https://example.test/${index}?q={{${start.id}.query}}`),
            headers: value('{"x-test":"futureflow"}'),
            body: value(`{"score":"{{${start.id}.score}}"}`),
          },
        },
      },
      {
        id: codeId,
        type: 'code',
        data: {
          title: 'Code',
          inputsValues: { codeLanguage: value(index % 2 ? 'python3' : 'javascript') },
          outputs: { type: 'object', properties: { score: { type: 'number' } } },
        },
      },
      end,
    ] as any,
    edges: [
      { sourceNodeID: start.id, targetNodeID: httpId },
      { sourceNodeID: httpId, targetNodeID: codeId },
      { sourceNodeID: codeId, targetNodeID: end.id },
    ],
  };
}

function invalidFlow(index: number): FlowGramJSON {
  const flow = validFlow(index) as any;
  switch (index % 12) {
    case 0:
      flow.nodes = [];
      break;
    case 1:
      flow.nodes[1].id = flow.nodes[0].id;
      break;
    case 2:
      flow.nodes[0].type = 'llm';
      break;
    case 3:
      flow.nodes = 'not-an-array';
      break;
    case 4:
      flow.edges[0].targetNodeID = 'missing-node';
      break;
    case 5:
      if (flow.nodes.some((node: any) => node.type === 'condition')) {
        flow.edges[1].sourcePortID = 'missing-port';
      } else {
        flow.nodes[1].type = 'loop';
      }
      break;
    case 6:
      flow.nodes.push({ id: `orphan_${index}`, type: 'llm', data: { title: 'Orphan' } });
      break;
    case 7:
      flow.edges.push({ sourceNodeID: flow.nodes[flow.nodes.length - 1].id, targetNodeID: flow.nodes[0].id });
      break;
    case 8:
      flow.edges.push({ ...flow.edges[0] });
      break;
    case 9:
      flow.nodes[0].data = null;
      break;
    case 10:
      flow.nodes.push({ id: `second_start_${index}`, type: 'start', data: { title: 'Second start' } });
      flow.edges.push({ sourceNodeID: flow.nodes[0].id, targetNodeID: `second_start_${index}` });
      break;
    case 11:
      flow.nodes = [startNode(`start_${index}`, index), endNode(`end_${index}`)];
      flow.edges = [{ sourceNodeID: `start_${index}`, targetNodeID: `end_${index}` }];
      break;
  }
  return flow;
}

function assertDslIntegrity(flow: FlowGramJSON, caseId: number) {
  const dsl = converter.toDifyDSL(flow);
  const exportedIds = new Set(dsl.workflow.graph.nodes.map((node) => node.id));
  assert.equal(exportedIds.size, flow.nodes.length, `case ${caseId}: every node must be exported once`);
  assert.equal(dsl.workflow.graph.edges.length, flow.edges.length, `case ${caseId}: every edge must be exported`);
  for (const edge of dsl.workflow.graph.edges) {
    assert.equal(exportedIds.has(edge.source), true, `case ${caseId}: edge source must exist`);
    assert.equal(exportedIds.has(edge.target), true, `case ${caseId}: edge target must exist`);
  }
  const inputs = converter.extractInputs(flow);
  assert.equal(typeof inputs.query, 'string', `case ${caseId}: start input defaults must survive conversion`);
  assert.equal(typeof inputs.score, 'number', `case ${caseId}: numeric input defaults must survive conversion`);
  assert.equal(Number.isFinite(converter.estimateCost(flow)), true, `case ${caseId}: estimated cost must be finite`);
  assert.doesNotThrow(() => JSON.stringify(dsl), `case ${caseId}: generated DSL must be serializable`);
}

function assertRejected(flow: FlowGramJSON, caseId: number) {
  let error: unknown;
  try {
    converter.toDifyDSL(flow);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof BadRequestException, `case ${caseId}: invalid graph must receive a 400-level rejection`);
}

function main() {
  for (let index = 0; index < VALID_CASES; index += 1) {
    assertDslIntegrity(validFlow(index), index);
  }
  for (let index = 0; index < INVALID_CASES; index += 1) {
    assertRejected(invalidFlow(index), index);
  }
  process.stdout.write(
    `platform fuzz passed: seed=0x${SEED.toString(16)}, valid=${VALID_CASES}, invalid=${INVALID_CASES}, total=${VALID_CASES + INVALID_CASES}\n`,
  );
}

void Promise.resolve().then(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
