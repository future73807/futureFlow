import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PermissionChecker } from '../src/auth/auth.module';
import { ApiKeyService } from '../src/auth/api-key.service';
import { AuthMiddleware } from '../src/auth/auth.middleware';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import { DifyIntegrationService } from '../src/dify/dify-integration.service';
import { WorkflowsController } from '../src/workflows/workflows.controller';
import { WorkflowsService } from '../src/workflows/workflows.service';


async function testControllerCompletesGenerator() {
  let finalized = false;
  let ended = false;
  const writes: string[] = [];

  const workflowsService = {
    async *runWorkflow() {
      yield {
        event: 'workflow_finished',
        data: { status: 'succeeded' },
      };
      finalized = true;
    },
  };

  const controller = new WorkflowsController(
    workflowsService as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const response = {
    req: { user: { id: 'user-1', username: 'tester' } },
    setHeader() {},
    flushHeaders() {},
    write(value: string) {
      writes.push(value);
    },
    end() {
      ended = true;
    },
    status() {
      return this;
    },
    json() {},
  };

  await controller.runWorkflow(
    { flowgram: { nodes: [], edges: [] } },
    response as any,
  );

  assert.equal(finalized, true, '控制器必须等待生成器完成结算逻辑');
  assert.equal(ended, true, 'SSE 响应必须正常结束');
  assert.match(writes[0], /workflow_finished/);
}

async function testDifyWorkflowIsolationEncryptsGeneratedKeys() {
  const stored: any[] = [];
  const repository = {
    findOne: async ({ where }: any) => stored.find((item) => Object.entries(where).every(
      ([key, value]) => item[key] === value,
    )) || null,
    find: async ({ where }: any) => stored.filter((item) => Object.entries(where).every(
      ([key, value]) => item[key] === value,
    )),
    create: (value: any) => value,
    save: async (value: any) => {
      const saved = { ...value, id: value.id || `integration-${stored.length + 1}` };
      const index = stored.findIndex((item) => item.id === saved.id || item.name === saved.name);
      if (index >= 0) stored[index] = saved;
      else stored.push(saved);
      return saved;
    },
    update: async (criteria: any, value: any) => {
      const matches = typeof criteria === 'string'
        ? stored.filter((item) => item.id === criteria)
        : stored.filter((item) => Object.entries(criteria).every(([key, expected]) => item[key] === expected));
      matches.forEach((item) => Object.assign(item, value));
    },
  };
  const config = {
    get: (key: string, fallback = '') => {
      if (key === 'DIFY_KEY_ENCRYPTION_SECRET') return 'test-encryption-secret-that-is-long-enough-12345';
      if (key === 'DIFY_CONSOLE_TOKEN') return 'synthetic-console-token';
      if (key === 'DIFY_AUTO_BOOTSTRAP') return 'false';
      return fallback;
    },
  };
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string; authorization: string }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({
      url,
      method,
      authorization: String(new Headers(init?.headers).get('Authorization') || ''),
    });
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', version: '0.15.3' }), { status: 200 });
    }
    if (url.endsWith('/apps') && method === 'GET') {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.endsWith('/apps') && method === 'POST') {
      const appNumber = calls.filter((item) => item.url.endsWith('/apps') && item.method === 'POST').length;
      return new Response(JSON.stringify({ id: `workflow-app-${appNumber}` }), { status: 201 });
    }
    if (url.includes('/api-keys') && method === 'POST') {
      const keyNumber = calls.filter((item) => item.url.includes('/api-keys') && item.method === 'POST').length;
      return new Response(JSON.stringify({
        id: 'dify-service-key-id',
        token: `app-0123456789abcdefghijklmn${keyNumber}`,
      }), { status: 201 });
    }
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof global.fetch;

  try {
    const service = new DifyIntegrationService(repository as any, config as any);
    await service.onModuleInit();
    assert.equal(calls.length, 0, 'Console authorization must not run automatically unless explicitly enabled');

    const preflight = await service.preflight();
    assert.equal(preflight.safe, true);
    assert.equal(preflight.checks.apiHealth.state, 'passed');
    assert.equal(preflight.checks.consoleEndpoint.state, 'passed');
    assert.equal(preflight.checks.provisioning.state, 'not_checked');
    assert.equal(preflight.checks.modelExecution.state, 'not_checked');
    assert.equal(
      calls.some((item) => item.method === 'POST' || item.url.includes('/workflows/run') || item.url.includes('/api-keys')),
      false,
      'safe preflight must not create Dify resources or execute a workflow/model',
    );

    const validation = await service.validateAuthorization({
      consoleToken: 'synthetic-console-token',
      consoleBase: 'http://localhost:5001/console/api',
    });
    assert.equal(validation.authorized, true);
    assert.equal(validation.persisted, false);
    assert.equal(stored.length, 0, 'no-save authorization validation must not persist a credential');
    assert.equal(
      calls.some((item) => item.method === 'GET' && item.url.endsWith('/apps') && item.authorization === 'Bearer synthetic-console-token'),
      true,
      'authorization validation must use a read-only authenticated Console probe',
    );

    const status = await service.bootstrap({
      consoleToken: 'synthetic-console-token',
      consoleBase: 'http://localhost:5001/console/api',
    });
    assert.equal(status.connectionAuthorized, true);
    assert.equal(status.managedWorkflowAppCount, 0);
    assert.equal(
      calls.filter((item) => item.url.endsWith('/apps') && item.method === 'POST').length,
      0,
      'admin authorization must not create one shared execution application',
    );

    const storedPreflightCallStart = calls.length;
    const storedPreflight = await service.preflight();
    const storedPreflightCalls = calls.slice(storedPreflightCallStart);
    assert.equal(storedPreflight.checks.storedAuthorization.state, 'not_checked');
    assert.equal(
      storedPreflightCalls.some((item) => item.authorization),
      false,
      'safe preflight must not decrypt or send a stored Console authorization',
    );
    assert.equal(
      storedPreflightCalls.some((item) => item.method === 'POST'),
      false,
      'safe preflight with a stored authorization must still remain read-only',
    );

    const first = await service.ensureWorkflowIntegration({
      workflowId: '11111111-1111-4111-8111-111111111111',
      workflowVersion: 2,
      workflowName: 'first workflow',
    }, {
      consoleBase: 'http://localhost:5001/console/api',
      token: 'synthetic-console-token',
    });
    await service.activateWorkflowIntegration(first.workflowId!, first.workflowVersion!);
    const second = await service.ensureWorkflowIntegration({
      workflowId: '22222222-2222-4222-8222-222222222222',
      workflowVersion: 2,
      workflowName: 'second workflow',
    }, {
      consoleBase: 'http://localhost:5001/console/api',
      token: 'synthetic-console-token',
    });
    await service.activateWorkflowIntegration(second.workflowId!, second.workflowVersion!);

    assert.notEqual(first.appId, second.appId);
    assert.equal(stored.some((item) => item.encryptedApiKey?.includes('app-0123456789abcdefghijklmn')), false);
    assert.match(first.encryptedApiKey!, /^v1:/);
    assert.equal(
      await service.resolveWorkflowServiceApiKey(first.workflowId!, first.workflowVersion!),
      'app-0123456789abcdefghijklmn1',
    );
    assert.equal(
      await service.resolveWorkflowServiceApiKey(second.workflowId!, second.workflowVersion!),
      'app-0123456789abcdefghijklmn2',
    );
    assert.equal(calls.filter((item) => item.url.endsWith('/apps') && item.method === 'POST').length, 2);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testHashedApiKeyAuthentication() {
  const plaintext = 'ff-0123456789abcdef0123456789abcdef';
  const expectedHash = createHash('sha256').update(plaintext).digest('hex');
  const user = { id: 'user-1', status: 'active' };
  let touched = false;

  const apiKeyService = new ApiKeyService({
    async findOne(options: any) {
      assert.equal(options.where.keyHash, expectedHash);
      return {
        id: 'key-1',
        revoked: false,
        expiresAt: null,
        user,
      };
    },
    async update(id: string, values: any) {
      assert.equal(id, 'key-1');
      assert.ok(values.lastUsedAt instanceof Date);
      touched = true;
    },
  } as any);

  assert.equal(await apiKeyService.authenticate(plaintext), user);
  assert.equal(touched, true, 'API Key 使用时间必须更新');

  let nextCalled = false;
  const middleware = new AuthMiddleware(
    { findOne: async () => null } as any,
    { verify: () => { throw new Error('not jwt'); } } as any,
    apiKeyService,
  );
  const request: any = { headers: { authorization: `Bearer ${plaintext}` } };
  await middleware.use(request, {} as any, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(request.user, user);
}

async function testWorkflowValidationAndDirectModeGuard() {
  const converter = new DifyConverterService();
  const permissions = new PermissionChecker();
  assert.equal(permissions.checkNodePermissions('free', ['condition', 'multi-condition']).allowed, true);
  assert.equal(permissions.checkNodePermissions('free', ['loop']).allowed, false);
  assert.throws(
    () =>
      converter.validateFlowGram({
        nodes: [
          { id: 'same', type: 'start', data: { title: 'Start' } },
          { id: 'same', type: 'llm', data: { title: 'LLM' } },
        ],
        edges: [],
      }),
    /节点 id 重复/,
  );

  const service = new WorkflowsService(
    {} as any,
    converter,
    { isConfigured: () => false } as any,
    {} as any,
    permissions,
    {} as any,
  );
  const stream = service.runWorkflow(
    {
      nodes: [
        { id: 'start', type: 'start', data: { title: 'Start' } },
        { id: 'http', type: 'http', data: { title: 'HTTP' } },
      ],
      edges: [{ sourceNodeID: 'start', targetNodeID: 'http' }],
    },
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
  );

  await assert.rejects(() => stream.next(), /工作流执行需要 Dify 引擎/);
}

async function testExecutionFailuresAlwaysRefund() {
  const converter = new DifyConverterService();
  const flowgram = {
    nodes: [
      { id: 'start', type: 'start', data: { title: 'Start' } },
      {
        id: 'llm',
        type: 'llm',
        data: {
          title: 'LLM',
          inputsValues: {
            modelName: { type: 'constant', content: 'deepseek-chat' },
          },
        },
      },
    ],
    edges: [{ sourceNodeID: 'start', targetNodeID: 'llm' }],
  } as any;

  const updates: any[] = [];
  const runRepo = {
    create: (value: any) => value,
    save: async (value: any) => value,
    update: async (_id: string, value: any) => updates.push(value),
  };
  let refunds = 0;
  let settlements = 0;
  const billing = {
    freezeBalance: async () => 0.01,
    refund: async () => { refunds += 1; },
    settleBilling: async () => { settlements += 1; },
    calculateCost: () => 0.001,
  };

  const difyFailureService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream() {
        throw new Error('Dify execution failed');
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined, release: async () => undefined } as any,
  );

  const importEvents: any[] = [];
  for await (const event of difyFailureService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1 },
  )) {
    importEvents.push(event);
  }
  assert.equal(importEvents.some((event) => event.event === 'error'), true);
  assert.equal(refunds, 1, 'Dify 执行异常后必须解冻退款');
  assert.equal(settlements, 0);

  refunds = 0;
  settlements = 0;
  const interruptedService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream() {
        // 模拟执行流中断：不 yield 任何事件就返回
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined, release: async () => undefined } as any,
  );

  for await (const _event of interruptedService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1 },
  )) {
    // consume stream
  }
  assert.equal(refunds, 1, '执行流意外中断后必须解冻退款');
  assert.equal(settlements, 0);
  assert.equal(updates.some((update) => update.status === 'failed'), true);
}



async function testConditionBranchConversionAndDirectExecution() {
  const converter = new DifyConverterService();
  const flowgram = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: {
          title: 'Start',
          outputs: { type: 'object', properties: { approved: { type: 'boolean', default: true } } },
        },
      },
      {
        id: 'condition',
        type: 'condition',
        data: {
          title: 'Approval',
          conditions: [{
            key: 'approved',
            value: {
              left: { type: 'ref', content: ['start', 'approved'] },
              operator: 'is',
              right: { type: 'constant', content: true },
            },
          }],
        },
      },
      {
        id: 'approved_llm',
        type: 'llm',
        data: { title: 'Approved', inputsValues: { prompt: { type: 'constant', content: 'approved path' } } },
      },
      {
        id: 'rejected_llm',
        type: 'llm',
        data: { title: 'Rejected', inputsValues: { prompt: { type: 'constant', content: 'rejected path' } } },
      },
      { id: 'approved_end', type: 'end', data: { title: 'Approved End' } },
      { id: 'rejected_end', type: 'end', data: { title: 'Rejected End' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'condition' },
      { sourceNodeID: 'condition', targetNodeID: 'approved_llm', sourcePortID: 'approved' },
      { sourceNodeID: 'condition', targetNodeID: 'rejected_llm', sourcePortID: 'else' },
      { sourceNodeID: 'approved_llm', targetNodeID: 'approved_end' },
      { sourceNodeID: 'rejected_llm', targetNodeID: 'rejected_end' },
    ],
  } as any;

  const dsl = converter.toDifyDSL(flowgram);
  const conditionNode = dsl.workflow.graph.nodes.find((node) => node.id === 'condition');
  assert.equal(conditionNode?.data.type, 'if-else');
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.target === 'approved_llm')?.sourceHandle,
    'approved',
  );
  assert.deepEqual(
    dsl.workflow.graph.nodes.find((node) => node.id === 'approved_end')?.data.outputs,
    [{ variable: 'result', value_selector: ['approved_llm', 'text'] }],
  );
}

async function testDify015NodeSchemas() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      { id: 'start', type: 'start', data: { title: 'Start' } },
      {
        id: 'http',
        type: 'http',
        data: {
          title: 'HTTP',
          inputsValues: {
            method: { type: 'constant', content: 'post' },
            url: { type: 'constant', content: 'https://example.test' },
            body: { type: 'constant', content: '{"ok":true}' },
          },
        },
      },
      {
        id: 'code',
        type: 'code',
        data: {
          title: 'Code',
          outputs: { properties: { score: { type: 'number' } } },
        },
      },
      { id: 'end', type: 'end', data: { title: 'End' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'http' },
      { sourceNodeID: 'http', targetNodeID: 'code' },
      { sourceNodeID: 'code', targetNodeID: 'end' },
    ],
  } as any);

  const http = dsl.workflow.graph.nodes.find((node) => node.id === 'http')?.data;
  assert.deepEqual(http?.authorization, { type: 'no-auth' });
  assert.deepEqual(http?.body, {
    type: 'raw-text',
    data: [{ key: '', type: 'text', value: '{"ok":true}' }],
  });
  assert.deepEqual(http?.timeout, { connect: 30, read: 30, write: 30 });
  assert.deepEqual(
    dsl.workflow.graph.nodes.find((node) => node.id === 'code')?.data.outputs,
    { score: { type: 'number' } },
  );
  assert.deepEqual(
    dsl.workflow.graph.nodes.find((node) => node.id === 'end')?.data.outputs,
    [{ variable: 'result', value_selector: ['code', 'score'] }],
  );
}

async function testDifyRejectsAmbiguousMergedEnd() {
  const converter = new DifyConverterService();
  assert.throws(
    () => converter.toDifyDSL({
      nodes: [
        { id: 'start', type: 'start', data: { title: 'Start' } },
        { id: 'first', type: 'llm', data: { title: 'First' } },
        { id: 'second', type: 'llm', data: { title: 'Second' } },
        { id: 'end', type: 'end', data: { title: 'End' } },
      ],
      edges: [
        { sourceNodeID: 'start', targetNodeID: 'first' },
        { sourceNodeID: 'start', targetNodeID: 'second' },
        { sourceNodeID: 'first', targetNodeID: 'end' },
        { sourceNodeID: 'second', targetNodeID: 'end' },
      ],
    } as any),
    /End \u8282\u70b9 end \u4e0d\u80fd\u5408\u5e76\u591a\u4e2a\u5206\u652f\u8f93\u51fa/,
  );
}

async function main() {
  await testControllerCompletesGenerator();
  await testDifyWorkflowIsolationEncryptsGeneratedKeys();
  await testHashedApiKeyAuthentication();
  await testWorkflowValidationAndDirectModeGuard();
  await testExecutionFailuresAlwaysRefund();
  await testConditionBranchConversionAndDirectExecution();
  await testDify015NodeSchemas();
  await testDifyRejectsAmbiguousMergedEnd();
  console.log('platform smoke tests passed');
}

void main();
