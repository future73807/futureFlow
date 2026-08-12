import assert from 'node:assert/strict';
import { DifyClientService } from '../src/dify/dify-client.service';
import { DifyConsoleService } from '../src/dify/dify-console.service';
import { DifyIntegrationService } from '../src/dify/dify-integration.service';

const SECRET = 'futureflow-localization-test-secret-32';
const AUTHORIZATION = {
  consoleBase: 'http://dify.test/console/api',
  token: 'console-token',
};

function createRepository(findOneResult: unknown = null) {
  return {
    findOne: async () => findOneResult,
    find: async () => [],
    create: (value: unknown) => value,
    save: async (value: unknown) => value,
    update: async () => undefined,
  };
}

function createConfig(secret = SECRET) {
  const values: Record<string, string> = {
    DIFY_KEY_ENCRYPTION_SECRET: secret,
    DIFY_CONSOLE_BASE: AUTHORIZATION.consoleBase,
  };
  return {
    get: (key: string, fallback = '') => values[key] ?? fallback,
  };
}

function createIntegration(secret = SECRET, findOneResult: unknown = null) {
  return new DifyIntegrationService(
    createRepository(findOneResult) as any,
    createConfig(secret) as any,
  );
}

async function rejectedMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('预期操作失败，但实际成功');
}

function assertChineseMessage(message: string) {
  assert.match(message, /[\u3400-\u9fff]/u);
  assert.doesNotMatch(
    message,
    /workflow publish failed|application .* accepted|DSL import failed|publish synchronization failed|unknown error/i,
  );
}

async function testIntegrationErrorsAreLocalized() {
  const weakEncryption = createIntegration('short');
  assertChineseMessage(await rejectedMessage(() => weakEncryption.bootstrap({
    consoleToken: 'token',
  })));

  const integration = createIntegration();
  assertChineseMessage(await rejectedMessage(() => integration.ensureWorkflowIntegration({
    workflowId: 'workflow-id',
    workflowVersion: 0,
    workflowName: '测试工作流',
  }, AUTHORIZATION)));
  assertChineseMessage(await rejectedMessage(() => integration.rotateServiceApiKey()));
  assertChineseMessage(await rejectedMessage(() => integration.validateAuthorization({
    consoleToken: 'token',
    consoleBase: 'ftp://dify.test',
  })));

  assert.throws(
    () => (integration as any).decrypt('broken'),
    (error: unknown) => error instanceof Error && /[\u3400-\u9fff]/u.test(error.message),
  );
  assert.equal((integration as any).safeError({}), '未知错误');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    assertChineseMessage(await rejectedMessage(() => (
      integration as any
    ).loginConsole(AUTHORIZATION.consoleBase, 'admin@example.test', 'wrong')));
    assertChineseMessage(await rejectedMessage(() => (
      integration as any
    ).consoleFetch(`${AUTHORIZATION.consoleBase}/apps`, AUTHORIZATION.token)));

    globalThis.fetch = async () => new Response('{}', { status: 503 });
    assertChineseMessage(await rejectedMessage(() => (
      integration as any
    ).consoleFetch(`${AUTHORIZATION.consoleBase}/apps`, AUTHORIZATION.token)));

    globalThis.fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    assertChineseMessage(await rejectedMessage(() => (
      integration as any
    ).createWorkflowApp(
      AUTHORIZATION.consoleBase,
      AUTHORIZATION.token,
      '测试工作流',
      1,
    )));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createConsoleService(integrationOverrides: Record<string, unknown> = {}) {
  const integration = {
    resolveConsoleAuthorization: async () => AUTHORIZATION,
    ensureWorkflowIntegration: async () => ({ appId: 'managed-app-id' }),
    refreshConsoleAuthorization: async () => null,
    activateWorkflowIntegration: async () => undefined,
    markConsoleAuthorizationExpired: async () => undefined,
    ...integrationOverrides,
  };
  return new DifyConsoleService(
    createConfig() as any,
    { toDifyDSLYaml: () => 'app: {}' } as any,
    integration as any,
  );
}

const SYNC_INPUT = {
  workflowId: 'workflow-id',
  workflowVersion: 3,
  workflowName: '测试工作流',
  flowgram: { nodes: [], edges: [] } as any,
};

async function testSyncResultMessagesAreLocalized() {
  const originalFetch = globalThis.fetch;
  try {
    const responses = [
      new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('upstream publish failed', { status: 503 }),
    ];
    globalThis.fetch = async () => responses.shift()!;
    const publishFailure = await createConsoleService().syncPublishedWorkflow(SYNC_INPUT);
    assert.equal(publishFailure.status, 'failed');
    assertChineseMessage(publishFailure.message);

    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid graph' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
    const importFailure = await createConsoleService().syncPublishedWorkflow(SYNC_INPUT);
    assert.equal(importFailure.status, 'failed');
    assertChineseMessage(importFailure.message);
    assert.doesNotMatch(importFailure.message, /invalid graph/i);

    const successResponses = [
      new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('', { status: 200 }),
    ];
    globalThis.fetch = async () => successResponses.shift()!;
    const success = await createConsoleService().syncPublishedWorkflow(SYNC_INPUT);
    assert.equal(success.status, 'synced');
    assertChineseMessage(success.message);

    const unexpectedFailure = await createConsoleService({
      ensureWorkflowIntegration: async () => {
        throw new Error('fetch failed');
      },
    }).syncPublishedWorkflow(SYNC_INPUT);
    assert.equal(unexpectedFailure.status, 'failed');
    assertChineseMessage(unexpectedFailure.message);
    assert.doesNotMatch(unexpectedFailure.message, /fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createDifyClient() {
  const config = {
    getApiBase: () => 'http://dify.test/v1',
    getApiKey: () => 'app-1234567890abcdef',
    getValidation: () => ({ message: '配置错误', suggestion: '请检查配置' }),
    isValidApiKey: (value: string) => /^app-[a-zA-Z0-9]{16,}$/.test(value),
  };
  const integration = {
    resolveServiceApiKey: async () => 'app-1234567890abcdef',
    resolveWorkflowOrLegacyApiKey: async () => 'app-1234567890abcdef',
  };
  return new DifyClientService(config as any, integration as any);
}

async function consumeDifyStream(client: DifyClientService) {
  for await (const _event of client.runWorkflowStream({}, 'localization-test')) {
    // Error-path tests do not expect a successful event.
  }
}

async function collectDifyStream(client: DifyClientService) {
  const events: any[] = [];
  for await (const event of client.runWorkflowStream({}, 'localization-test')) {
    events.push(event);
  }
  return events;
}

async function testExecutionErrorsDoNotLeakUpstreamEnglish() {
  const originalFetch = globalThis.fetch;
  const client = createDifyClient();
  try {
    globalThis.fetch = async () => new Response('upstream internal error', { status: 500 });
    const internalError = await rejectedMessage(() => consumeDifyStream(client));
    assertChineseMessage(internalError);
    assert.doesNotMatch(internalError, /upstream internal error/i);

    globalThis.fetch = async () => new Response('rate limit exceeded', { status: 429 });
    const rateLimitError = await rejectedMessage(() => consumeDifyStream(client));
    assertChineseMessage(rateLimitError);
    assert.doesNotMatch(rateLimitError, /rate limit exceeded/i);

    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    const connectionError = await rejectedMessage(() => consumeDifyStream(client));
    assertChineseMessage(connectionError);
    assert.doesNotMatch(connectionError, /fetch failed/i);

    const health = await client.ping();
    assert.equal(health.reachable, false);
    assertChineseMessage(health.error || '');
    assert.doesNotMatch(health.error || '', /fetch failed/i);

    globalThis.fetch = async () => new Response([
      `data: ${JSON.stringify({
        event: 'error',
        data: { status: 500, message: 'model provider rate limit exceeded' },
      })}`,
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const [errorEvent] = await collectDifyStream(client);
    assert.equal(errorEvent.event, 'error');
    assertChineseMessage(errorEvent.data.message);
    assert.doesNotMatch(errorEvent.data.message, /model provider|rate limit exceeded/i);

    globalThis.fetch = async () => new Response([
      `data: ${JSON.stringify({
        event: 'workflow_finished',
        data: { status: 'failed', error: 'sandbox execution failed' },
      })}`,
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const [finishedEvent] = await collectDifyStream(client);
    assertChineseMessage(finishedEvent.data.error);
    assert.doesNotMatch(finishedEvent.data.error, /sandbox execution failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await testIntegrationErrorsAreLocalized();
  await testSyncResultMessagesAreLocalized();
  await testExecutionErrorsDoNotLeakUpstreamEnglish();
  console.log('Dify 中文错误消息测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
