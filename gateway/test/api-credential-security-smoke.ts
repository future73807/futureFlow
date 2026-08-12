import 'reflect-metadata';

import assert from 'node:assert/strict';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import { DifyClientService } from '../src/dify/dify-client.service';
import { PermissionChecker } from '../src/auth/auth.module';
import { WorkflowsService } from '../src/workflows/workflows.service';

const MARKER = 'ff-sensitive-marker-8f3d2c';
const REDACTED = '[已隐藏]';

function apiFlow() {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: {
              foo: { type: 'string' },
              query: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'api',
        type: 'http',
        data: {
          title: 'API 请求',
          api: { method: 'GET', url: { type: 'constant', content: 'https://8.8.8.8/resolve' } },
          authorization: {
            type: 'bearer',
            token: { type: 'ref', content: ['start', 'foo'] },
          },
          paramsValues: { name: { type: 'ref', content: ['start', 'query'] } },
          body: { bodyType: 'none' },
          timeout: { timeout: 30000, retryTimes: 0 },
        },
      },
      { id: 'end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'api' },
      { sourceNodeID: 'api', targetNodeID: 'end' },
    ],
  } as any;
}

function testNativeDifyAuthorization() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL(apiFlow());
  const api = dsl.workflow.graph.nodes.find((node) => node.id === 'api')?.data;
  assert.deepEqual(api?.authorization, {
    type: 'api-key',
    config: {
      type: 'bearer',
      api_key: '{{#start.foo#}}',
      header: 'Authorization',
    },
  });
  assert.doesNotMatch(api?.headers || '', /Authorization|start\.foo|ff-sensitive-marker/);

  const basicFlow = apiFlow();
  basicFlow.nodes[1].data.authorization = {
    type: 'basic',
    username: { type: 'constant', content: 'futureflow' },
    password: { type: 'constant', content: MARKER },
  };
  const basic = converter.toDifyDSL(basicFlow).workflow.graph.nodes
    .find((node) => node.id === 'api')?.data;
  assert.equal(basic?.authorization?.type, 'api-key');
  assert.equal(basic?.authorization?.config?.type, 'basic');
  assert.equal(basic?.authorization?.config?.header, 'Authorization');
  assert.equal(
    Buffer.from(basic?.authorization?.config?.api_key || '', 'base64').toString('utf8'),
    `futureflow:${MARKER}`,
  );
  assert.doesNotMatch(basic?.headers || '', new RegExp(MARKER));
}

function testSseRedaction() {
  const client = new DifyClientService({} as any, {} as any);
  const event = {
    event: 'node_finished',
    data: {
      status: 'succeeded',
      inputs: {
        foo: MARKER,
        query: '保留业务输入',
        headers: {
          Authorization: `Bearer ${MARKER}`,
          'X-API-Key': MARKER,
          'X-Business': 'keep-header',
        },
      },
      process_data: {
        request: [
          `POST /submit?token=${MARKER}&page=1 HTTP/1.1`,
          'Host: example.com',
          `Authorization: Bearer ${MARKER}`,
          `X-API-Key: ${MARKER}`,
          'X-Business: keep-header',
          'Content-Type: application/json',
          '',
          JSON.stringify({ password: MARKER, message: 'keep-body' }),
        ].join('\r\n'),
        nested: { client_secret: MARKER, business: 'keep-nested' },
      },
      outputs: { result: 'keep-output', headers: { 'X-Business': 'keep-output-header' } },
    },
  };
  const sanitized = (client as any).localizeExecutionEvent(event);
  assert.doesNotMatch(JSON.stringify({
    inputs: sanitized.data.inputs,
    process_data: sanitized.data.process_data,
  }), new RegExp(MARKER));
  assert.equal(sanitized.data.inputs.foo, REDACTED);
  assert.equal(sanitized.data.inputs.query, REDACTED);
  assert.equal(sanitized.data.inputs.headers.Authorization, REDACTED);
  assert.equal(sanitized.data.inputs.headers['X-API-Key'], REDACTED);
  assert.equal(sanitized.data.inputs.headers['X-Business'], REDACTED);
  assert.match(sanitized.data.process_data.request, /token=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D/);
  assert.match(sanitized.data.process_data.request, /X-Business: keep-header/);
  assert.match(sanitized.data.process_data.request, /"message": "keep-body"/);
  assert.deepEqual(sanitized.data.outputs, event.data.outputs, '业务 outputs 不得被脱敏器改写');

  for (const eventName of ['workflow_started', 'node_started', 'node_retry']) {
    const phaseEvent = {
      event: eventName,
      data: {
        inputs: { foo: MARKER, query: '保留业务输入' },
        process_data: { headers: { Authorization: `Bearer ${MARKER}` } },
        outputs: { result: MARKER },
      },
    };
    const safePhase = (client as any).localizeExecutionEvent(phaseEvent);
    assert.doesNotMatch(
      JSON.stringify({
        inputs: safePhase.data.inputs,
        process_data: safePhase.data.process_data,
      }),
      new RegExp(MARKER),
      `${eventName} 的执行详情不得泄漏 marker`,
    );
    assert.equal(safePhase.data.inputs.foo, REDACTED);
    assert.equal(safePhase.data.inputs.query, REDACTED);
    assert.deepEqual(safePhase.data.outputs, phaseEvent.data.outputs, '显式业务 outputs 不得被改写');
  }

  const startFinished = (client as any).localizeExecutionEvent({
    event: 'node_finished',
    data: {
      node_type: 'start',
      status: 'succeeded',
      outputs: { foo: MARKER, query: '开始节点输入回显' },
    },
  });
  assert.deepEqual(startFinished.data.outputs, {
    foo: REDACTED,
    query: REDACTED,
  }, '开始节点 outputs 是运行输入回显，必须全部隐藏');

  const echoedCredential = (client as any).localizeExecutionEvent({
    event: 'node_finished',
    data: {
      node_type: 'http-request',
      status: 'succeeded',
      outputs: {
        body: JSON.stringify({ Authorization: `Bearer ${MARKER}`, result: 'keep-output' }),
      },
    },
  }, [MARKER]);
  assert.doesNotMatch(JSON.stringify(echoedCredential), new RegExp(MARKER));
  assert.match(echoedCredential.data.outputs.body, /Bearer \[已隐藏\]/);
  assert.match(echoedCredential.data.outputs.body, /keep-output/);
}

function serviceDependencies() {
  const persisted: any[] = [];
  const difyInputs: any[] = [];
  const difySensitiveValues: string[][] = [];
  const runRepo = {
    create: (value: any) => value,
    save: async (value: any) => {
      persisted.push(value);
      return value;
    },
    update: async () => undefined,
  };
  const difyClient = {
    isConfigured: async () => true,
    runWorkflowStream: async function* (
      inputs: Record<string, unknown>,
      _user: string,
      _target: unknown,
      sensitiveValues: string[] = [],
    ) {
      difyInputs.push(inputs);
      difySensitiveValues.push(sensitiveValues);
      yield { event: 'workflow_started', workflow_run_id: 'dify-run', task_id: 'task', data: { id: 'dify-run' } };
      yield {
        event: 'workflow_finished',
        workflow_run_id: 'dify-run',
        task_id: 'task',
        data: { status: 'succeeded', outputs: { body: 'ok' }, total_tokens: 0, total_steps: 3, elapsed_time: 0.1 },
      };
    },
  };
  const billing = {
    freezeBalance: async () => 0,
    refund: async () => undefined,
    calculateCost: () => 0,
    settleBilling: async () => undefined,
  };
  return { persisted, difyInputs, difySensitiveValues, runRepo, difyClient, billing };
}

async function exhaust(service: WorkflowsService) {
  for await (const _event of service.runWorkflow(
    apiFlow(),
    { id: 'user', username: 'tester', vipLevel: 'pro' } as any,
    { foo: MARKER, query: '保留业务输入' },
    '11111111-1111-1111-1111-111111111111',
    { workflowVersion: 1 },
  )) {
    // Exhaust the stream so both execution and persistence paths finish.
  }
}

function assertSafeSnapshot(snapshot: any) {
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, new RegExp(MARKER));
  const start = snapshot.nodes.find((node: any) => node.id === 'start');
  assert.equal(start.data.inputsValues.foo.type, 'constant');
  assert.equal(start.data.inputsValues.foo.content, REDACTED);
  assert.equal(start.data.inputsValues.query.type, 'constant');
  assert.equal(start.data.inputsValues.query.content, REDACTED);
}

async function testRunSnapshotRedaction() {
  const guarded = serviceDependencies();
  let guardedSnapshot: any;
  const executionGuard = {
    reserve: async (options: any) => {
      guardedSnapshot = options.flowgramJson;
      return options;
    },
  };
  await exhaust(new WorkflowsService(
    guarded.runRepo as any,
    new DifyConverterService(),
    guarded.difyClient as any,
    guarded.billing as any,
    new PermissionChecker(),
    executionGuard as any,
  ));
  assertSafeSnapshot(guardedSnapshot);
  assert.equal(guarded.difyInputs[0].foo, MARKER, '脱敏不得影响本次真实执行输入');
  assert.equal(guarded.difyInputs[0].query, '保留业务输入');
  assert.ok(
    guarded.difySensitiveValues[0].includes(MARKER),
    '普通字段名一旦被 API 认证引用，也必须进入 SSE 凭据值脱敏集合',
  );
  assert.equal(
    guarded.difySensitiveValues[0].includes('保留业务输入'),
    false,
    '未进入凭据位置的业务输入不得被值级脱敏',
  );

  const fallback = serviceDependencies();
  await exhaust(new WorkflowsService(
    fallback.runRepo as any,
    new DifyConverterService(),
    fallback.difyClient as any,
    fallback.billing as any,
    new PermissionChecker(),
    undefined,
  ));
  assert.ok(fallback.persisted.length > 0, 'fallback 分支必须创建运行记录');
  assertSafeSnapshot(fallback.persisted[0].flowgramJson);
  assert.equal(fallback.difyInputs[0].foo, MARKER);
  assert.equal(fallback.difyInputs[0].query, '保留业务输入');
}

async function main() {
  testNativeDifyAuthorization();
  testSseRedaction();
  await testRunSnapshotRedaction();
  console.log('API 凭据安全测试通过：原生认证、SSE 脱敏、两条运行快照持久化路径均无 marker');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

