import assert from 'node:assert/strict';
import { Workflow } from '../src/database/entities/workflow.entity';
import { DifyIntegrationService } from '../src/dify/dify-integration.service';
import { WorkflowCrudService } from '../src/workflows/workflow-crud.service';

const AUTHORIZATION = {
  consoleBase: 'http://dify.test/console/api',
  token: 'console-token',
};

function createCleanupHarness(bindings: any[]) {
  const deletedCriteria: any[] = [];
  const repository = {
    find: async () => bindings,
    findOne: async () => null,
    delete: async (criteria: any) => {
      deletedCriteria.push(criteria);
      return { affected: bindings.length };
    },
    update: async () => undefined,
    create: (value: unknown) => value,
    save: async (value: unknown) => value,
  };
  const config = {
    get: (key: string, fallback = '') => ({
      DIFY_CONSOLE_TOKEN: '',
      DIFY_CONSOLE_BASE: AUTHORIZATION.consoleBase,
      DIFY_KEY_ENCRYPTION_SECRET: 'futureflow-cleanup-test-secret-32',
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new DifyIntegrationService(repository as any, config as any);
  (service as any).resolveConsoleAuthorization = async () => AUTHORIZATION;
  return { service, deletedCriteria };
}

const binding = (appId: string | null, version = 1) => ({
  workflowId: 'workflow-cleanup',
  workflowVersion: version,
  appId,
  consoleBase: AUTHORIZATION.consoleBase,
});

function createBootstrapHarness(
  bindings: any[],
  existing: any = null,
  configOverrides: Record<string, string> = {},
) {
  const saved: any[] = [];
  let probes = 0;
  let serviceKeyCreates = 0;
  const repository = {
    find: async () => bindings,
    findOne: async () => existing,
    create: (value: unknown) => value,
    save: async (value: unknown) => {
      saved.push(value);
      return value;
    },
    update: async () => undefined,
  };
  const config = {
    get: (key: string, fallback = '') => ({
      DIFY_CONSOLE_BASE: AUTHORIZATION.consoleBase,
      DIFY_KEY_ENCRYPTION_SECRET: 'futureflow-cleanup-test-secret-32',
      DIFY_SYNC_LLM_PROVIDER: 'false',
      ...configOverrides,
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new DifyIntegrationService(repository as any, config as any);
  (service as any).probeConsoleAuthorization = async () => {
    probes += 1;
  };
  (service as any).createServiceApiKey = async () => {
    serviceKeyCreates += 1;
    return 'app-0123456789abcdefghijklmnop';
  };
  (service as any).getStatus = async () => ({ connectionAuthorized: true });
  return {
    service,
    saved,
    getProbes: () => probes,
    getServiceKeyCreates: () => serviceKeyCreates,
  };
}

function createProvisionHarness(options: {
  saveError?: Error;
  createError?: Error;
  concurrentWinner?: any;
} = {}) {
  let findOneCalls = 0;
  let saves = 0;
  const repository = {
    findOne: async () => {
      findOneCalls += 1;
      return findOneCalls === 1 ? null : options.concurrentWinner || null;
    },
    find: async () => [],
    create: (value: unknown) => {
      if (options.createError) throw options.createError;
      return value;
    },
    save: async (value: unknown) => {
      saves += 1;
      if (options.saveError) throw options.saveError;
      return value;
    },
    update: async () => undefined,
  };
  const config = {
    get: (key: string, fallback = '') => ({
      DIFY_KEY_ENCRYPTION_SECRET: 'futureflow-cleanup-test-secret-32',
    } as Record<string, string>)[key] ?? fallback,
  };
  return {
    service: new DifyIntegrationService(repository as any, config as any),
    getSaves: () => saves,
  };
}

const OLD_SERVICE_KEY = 'app-OLDKEY0123456789abcdef';
const NEW_SERVICE_KEY = 'app-NEWKEY0123456789abcdef';
const MANUAL_SERVICE_KEY = 'app-MANUAL0123456789abcdef';

function createRotationHarness(options: {
  updateError?: Error;
  currentConsoleBase?: string;
  oldApiKey?: string | null;
} = {}) {
  const events: string[] = [];
  const updates: any[] = [];
  let statusReads = 0;
  let lockRequests = 0;
  const current: any = {
    id: 'integration-id',
    name: 'default',
    workflowId: null,
    workflowVersion: null,
    appId: 'managed-app',
    consoleBase: options.currentConsoleBase || AUTHORIZATION.consoleBase,
    encryptedApiKey: null,
    keyFingerprint: null,
    status: 'active',
    lastRotatedAt: null,
  };
  const repository: any = {
    findOne: async () => current,
    find: async () => [current],
    create: (value: unknown) => value,
    save: async (value: unknown) => value,
    update: async (_id: string, patch: any) => {
      events.push('DB_UPDATE');
      updates.push(patch);
      if (options.updateError) throw options.updateError;
      Object.assign(current, patch);
      return { affected: 1 };
    },
  };
  repository.manager = {
    transaction: async (operation: (manager: any) => Promise<unknown>) => operation({
      getRepository: () => ({
        findOne: async (options: any) => {
          assert.deepEqual(
            options?.lock,
            { mode: 'pessimistic_write' },
            'Service API Key 轮换必须持有目标绑定的写锁',
          );
          lockRequests += 1;
          return current;
        },
        update: repository.update,
      }),
    }),
  };
  const config = {
    get: (key: string, fallback = '') => ({
      DIFY_CONSOLE_BASE: AUTHORIZATION.consoleBase,
      DIFY_KEY_ENCRYPTION_SECRET: 'futureflow-cleanup-test-secret-32',
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new DifyIntegrationService(repository as any, config as any);
  if (options.oldApiKey !== null) {
    current.encryptedApiKey = (service as any).encrypt(options.oldApiKey || OLD_SERVICE_KEY);
  }
  (service as any).getStatus = async () => {
    statusReads += 1;
    return { rotated: true };
  };
  return {
    service,
    current,
    events,
    updates,
    getStatusReads: () => statusReads,
    getLockRequests: () => lockRequests,
  };
}

const PROVISION_INPUT = {
  workflowId: 'workflow-cleanup',
  workflowVersion: 7,
  workflowName: '资源补偿测试',
};

async function testSuccessfulAndIdempotentStatuses() {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [200, 204, 404]) {
      const { service, deletedCriteria } = createCleanupHarness([binding('managed-app')]);
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(null, { status });
      };
      await service.deleteWorkflowIntegrations('workflow-cleanup');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, `${AUTHORIZATION.consoleBase}/apps/managed-app`);
      assert.equal(requests[0].init?.method, 'DELETE');
      assert.deepEqual(deletedCriteria, [{ workflowId: 'workflow-cleanup' }]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAllVersionsAndDuplicateApps() {
  const originalFetch = globalThis.fetch;
  try {
    const { service, deletedCriteria } = createCleanupHarness([
      binding('app-one', 1),
      binding('app-two', 2),
      binding('app-one', 3),
      binding(null, 4),
    ]);
    const requested: string[] = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 204 });
    };
    await service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.deepEqual(requested.sort(), [
      `${AUTHORIZATION.consoleBase}/apps/app-one`,
      `${AUTHORIZATION.consoleBase}/apps/app-two`,
    ]);
    assert.equal(deletedCriteria.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPartialFailureRemainsRetryable() {
  const originalFetch = globalThis.fetch;
  try {
    const { service, deletedCriteria } = createCleanupHarness([
      binding('app-one', 1),
      binding('app-two', 2),
    ]);
    const requestCounts = new Map<string, number>();
    let attempt = 1;
    globalThis.fetch = async (url) => {
      const appId = String(url).split('/').pop()!;
      requestCounts.set(appId, (requestCounts.get(appId) || 0) + 1);
      if (attempt === 1) {
        return new Response(null, { status: appId === 'app-one' ? 204 : 500 });
      }
      return new Response(null, { status: appId === 'app-one' ? 404 : 204 });
    };

    await assert.rejects(
      () => service.deleteWorkflowIntegrations('workflow-cleanup'),
      /Dify 应用清理失败/,
    );
    assert.equal(deletedCriteria.length, 0, '部分远端删除后失败时必须保留全部本地绑定');

    attempt = 2;
    await service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.deepEqual(Object.fromEntries(requestCounts), { 'app-one': 2, 'app-two': 2 });
    assert.deepEqual(deletedCriteria, [{ workflowId: 'workflow-cleanup' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAuthorizationRefresh() {
  const originalFetch = globalThis.fetch;
  try {
    const { service, deletedCriteria } = createCleanupHarness([binding('managed-app')]);
    let requestCount = 0;
    let markedExpired = false;
    (service as any).refreshConsoleAuthorization = async () => ({
      consoleBase: AUTHORIZATION.consoleBase,
      token: 'refreshed-token',
    });
    (service as any).markConsoleAuthorizationExpired = async () => {
      markedExpired = true;
    };
    globalThis.fetch = async (_url, init) => {
      requestCount += 1;
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      if (requestCount === 1) {
        assert.equal(authorization, 'Bearer console-token');
        return new Response(null, { status: 401 });
      }
      assert.equal(authorization, 'Bearer refreshed-token');
      return new Response(null, { status: 204 });
    };
    await service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.equal(requestCount, 2);
    assert.equal(markedExpired, false);
    assert.equal(deletedCriteria.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testConsoleBaseSafetyBeforeDelete() {
  const originalFetch = globalThis.fetch;
  try {
    const trailing = createCleanupHarness([{
      ...binding('managed-app'),
      consoleBase: `${AUTHORIZATION.consoleBase}///`,
    }]);
    const trailingRequests: string[] = [];
    globalThis.fetch = async (url) => {
      trailingRequests.push(String(url));
      return new Response(null, { status: 204 });
    };
    await trailing.service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.deepEqual(trailingRequests, [`${AUTHORIZATION.consoleBase}/apps/managed-app`]);
    assert.equal(trailing.deletedCriteria.length, 1);

    const mixed = createCleanupHarness([
      binding('app-one', 1),
      { ...binding('app-two', 2), consoleBase: 'http://other-dify.test/console/api' },
    ]);
    let mixedRequests = 0;
    globalThis.fetch = async () => {
      mixedRequests += 1;
      return new Response(null, { status: 404 });
    };
    await assert.rejects(
      () => mixed.service.deleteWorkflowIntegrations('workflow-cleanup'),
      /多个 Dify Console 地址/,
    );
    assert.equal(mixedRequests, 0, '多 Console Base 必须在任何远端 DELETE 前失败');
    assert.equal(mixed.deletedCriteria.length, 0);

    const mismatch = createCleanupHarness([binding('managed-app')]);
    (mismatch.service as any).resolveConsoleAuthorization = async () => ({
      consoleBase: 'http://other-dify.test/console/api',
      token: 'wrong-console-token',
    });
    let mismatchRequests = 0;
    globalThis.fetch = async () => {
      mismatchRequests += 1;
      return new Response(null, { status: 404 });
    };
    await assert.rejects(
      () => mismatch.service.deleteWorkflowIntegrations('workflow-cleanup'),
      /授权地址与历史工作流绑定不一致/,
    );
    assert.equal(mismatchRequests, 0, '授权 Base 不匹配不得用新服务器的 404 清除历史绑定');
    assert.equal(mismatch.deletedCriteria.length, 0);

    const refreshedMismatch = createCleanupHarness([binding('managed-app')]);
    (refreshedMismatch.service as any).refreshConsoleAuthorization = async () => ({
      consoleBase: 'http://other-dify.test/console/api',
      token: 'refreshed-on-wrong-console',
    });
    let refreshRequests = 0;
    globalThis.fetch = async () => {
      refreshRequests += 1;
      return new Response(null, { status: 401 });
    };
    await assert.rejects(
      () => refreshedMismatch.service.deleteWorkflowIntegrations('workflow-cleanup'),
      /授权地址与历史工作流绑定不一致/,
    );
    assert.equal(refreshRequests, 1, '刷新后的 Base 必须在第二次 DELETE 前重新核对');
    assert.equal(refreshedMismatch.deletedCriteria.length, 0);

    const localAliasMismatch = createCleanupHarness([{
      ...binding('managed-app'),
      consoleBase: 'http://localhost:5001/console/api',
    }]);
    (localAliasMismatch.service as any).resolveConsoleAuthorization = async () => ({
      consoleBase: 'http://127.0.0.1:5001/console/api',
      token: 'token-for-different-host',
    });
    let localAliasRequests = 0;
    globalThis.fetch = async () => {
      localAliasRequests += 1;
      return new Response(null, { status: 404 });
    };
    await assert.rejects(
      () => localAliasMismatch.service.deleteWorkflowIntegrations('workflow-cleanup'),
      /授权地址与历史工作流绑定不一致/,
    );
    assert.equal(localAliasRequests, 0, 'localhost 与 127.0.0.1 必须按不同控制面处理');
    assert.equal(localAliasMismatch.deletedCriteria.length, 0);

    const invalidBindingBase = createCleanupHarness([{
      ...binding('managed-app'),
      consoleBase: 'not-a-valid-console-url',
    }]);
    let invalidBaseRequests = 0;
    globalThis.fetch = async () => {
      invalidBaseRequests += 1;
      return new Response(null, { status: 204 });
    };
    await assert.rejects(
      () => invalidBindingBase.service.deleteWorkflowIntegrations('workflow-cleanup'),
      /历史 Dify 工作流绑定的 Console 地址无效/,
    );
    assert.equal(invalidBaseRequests, 0);
    assert.equal(invalidBindingBase.deletedCriteria.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBootstrapConsoleBaseSwitchGate() {
  const differentBase = 'http://other-dify.test/console/api';
  const existingDefault = {
    name: 'default',
    workflowId: null,
    appId: null,
    encryptedApiKey: null,
    encryptedConsoleRefreshToken: 'encrypted-refresh-a',
    consoleBase: AUTHORIZATION.consoleBase,
  };

  const blocked = createBootstrapHarness([binding('managed-app')], existingDefault);
  await assert.rejects(
    () => blocked.service.bootstrap({ consoleToken: 'new-token', consoleBase: differentBase }),
    /不能切换授权地址/,
  );
  assert.equal(blocked.getProbes(), 0, '切换门禁应在远端授权探测前生效');
  assert.equal(blocked.saved.length, 0);

  const trailing = createBootstrapHarness([{
    ...binding('managed-app'),
    consoleBase: `${AUTHORIZATION.consoleBase}/`,
  }], existingDefault);
  await trailing.service.bootstrap({
    consoleToken: 'same-console-token',
    consoleBase: `${AUTHORIZATION.consoleBase}///`,
  });
  assert.equal(trailing.getProbes(), 1);
  assert.equal(trailing.saved.length, 1, '仅尾斜杠不同不应被误判为切换');

  const noManagedApp = createBootstrapHarness([{
    ...binding(null),
    consoleBase: AUTHORIZATION.consoleBase,
  }], existingDefault);
  await noManagedApp.service.bootstrap({ consoleToken: 'new-token', consoleBase: differentBase });
  assert.equal(noManagedApp.getProbes(), 1);
  assert.equal(noManagedApp.saved.length, 1, '没有 managed app 时应允许切换 Console Base');

  const historicalOtherBase = createBootstrapHarness([{
    ...binding('historical-alias-app'),
    consoleBase: 'http://127.0.0.1:5001/console/api',
  }], existingDefault);
  await historicalOtherBase.service.bootstrap({
    consoleToken: 'same-default-token',
    consoleBase: AUTHORIZATION.consoleBase,
  });
  assert.equal(historicalOtherBase.getProbes(), 1);
  assert.equal(
    historicalOtherBase.saved.length,
    1,
    '未切换默认 Base 时，历史异 Base 绑定不应永久阻止刷新当前授权',
  );

  const legacyDefault = createBootstrapHarness([], {
    ...existingDefault,
    appId: 'legacy-app-on-old-console',
    encryptedApiKey: 'encrypted-legacy-key',
  });
  await assert.rejects(
    () => legacyDefault.service.bootstrap({ consoleToken: 'new-token', consoleBase: differentBase }),
    /legacy 应用或密钥/,
  );
  assert.equal(legacyDefault.getProbes(), 0);
  assert.equal(legacyDefault.saved.length, 0);
}

async function testBootstrapCredentialIsolation() {
  const existingDefault = {
    name: 'default',
    workflowId: null,
    appId: null,
    encryptedApiKey: null,
    encryptedConsoleRefreshToken: 'encrypted-refresh-a',
    consoleBase: AUTHORIZATION.consoleBase,
    lastRotatedAt: null,
  };

  const sameBase = createBootstrapHarness([], existingDefault);
  await sameBase.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleBase: AUTHORIZATION.consoleBase,
  });
  assert.equal(sameBase.saved[0].encryptedConsoleRefreshToken, null);

  const explicitRefresh = createBootstrapHarness([], existingDefault);
  await explicitRefresh.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleRefreshToken: 'refresh-token-b',
    consoleBase: AUTHORIZATION.consoleBase,
  });
  assert.equal(
    (explicitRefresh.service as any).decrypt(
      explicitRefresh.saved[0].encryptedConsoleRefreshToken,
    ),
    'refresh-token-b',
  );

  const differentBase = 'http://other-dify.test/console/api';
  const crossBase = createBootstrapHarness([], existingDefault);
  await crossBase.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleBase: differentBase,
  });
  assert.equal(crossBase.saved[0].encryptedConsoleRefreshToken, null);
  assert.equal(crossBase.saved[0].appId, null);
  assert.equal(crossBase.getServiceKeyCreates(), 0);

  const legacyApp = createBootstrapHarness([], {
    ...existingDefault,
    appId: 'legacy-app-a',
    encryptedApiKey: 'encrypted-legacy-key-a',
  });
  await assert.rejects(
    () => legacyApp.service.bootstrap({
      consoleToken: 'access-token-b',
      consoleBase: differentBase,
    }),
    /legacy 应用或密钥/,
  );
  assert.equal(legacyApp.getServiceKeyCreates(), 0);
  assert.equal(legacyApp.saved.length, 0);

  const sameBaseLegacyApp = createBootstrapHarness([], {
    ...existingDefault,
    appId: 'legacy-app-a',
    encryptedApiKey: 'encrypted-legacy-key-a',
  });
  await sameBaseLegacyApp.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleBase: AUTHORIZATION.consoleBase,
  });
  assert.equal(sameBaseLegacyApp.saved[0].appId, 'legacy-app-a');
  assert.equal(sameBaseLegacyApp.getServiceKeyCreates(), 1);

  const preservedRotationTime = new Date('2026-01-02T03:04:05.000Z');
  const idempotentExisting = {
    ...existingDefault,
    appId: 'legacy-app-a',
    encryptedApiKey: null as string | null,
    lastRotatedAt: preservedRotationTime,
  };
  const idempotentLegacyApp = createBootstrapHarness([], idempotentExisting);
  idempotentExisting.encryptedApiKey = (idempotentLegacyApp.service as any).encrypt(
    OLD_SERVICE_KEY,
  );
  await idempotentLegacyApp.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleBase: AUTHORIZATION.consoleBase,
    appId: 'legacy-app-a',
  });
  assert.equal(
    idempotentLegacyApp.getServiceKeyCreates(),
    0,
    '同 Base、同 legacy App 且密钥有效时不得重复 POST 新 key',
  );
  assert.equal(
    (idempotentLegacyApp.service as any).decrypt(
      idempotentLegacyApp.saved[0].encryptedApiKey,
    ),
    OLD_SERVICE_KEY,
  );
  assert.equal(idempotentLegacyApp.saved[0].lastRotatedAt, preservedRotationTime);

  const changedLegacyApp = createBootstrapHarness([], { ...idempotentExisting });
  await changedLegacyApp.service.bootstrap({
    consoleToken: 'access-token-b',
    consoleBase: AUTHORIZATION.consoleBase,
    appId: 'legacy-app-b',
  });
  assert.equal(changedLegacyApp.getServiceKeyCreates(), 1);
  assert.equal(changedLegacyApp.saved[0].appId, 'legacy-app-b');

  const emailLogin = createBootstrapHarness([], existingDefault);
  (emailLogin.service as any).loginConsole = async () => ({
    accessToken: 'login-access-token',
    refreshToken: 'login-refresh-token',
  });
  await emailLogin.service.bootstrap({
    email: 'admin@example.test',
    password: 'one-time-password',
    consoleBase: AUTHORIZATION.consoleBase,
  });
  assert.equal(
    (emailLogin.service as any).decrypt(emailLogin.saved[0].encryptedConsoleRefreshToken),
    'login-refresh-token',
  );
}

async function testManagedModelProviderBootstrap() {
  const originalFetch = globalThis.fetch;
  const providerSecret = 'sk-provider-secret-value';
  const providerUrl = `${AUTHORIZATION.consoleBase}/workspaces/current/model-providers/deepseek`;
  const providerListUrl = `${AUTHORIZATION.consoleBase}/workspaces/current/model-providers?model_type=llm`;
  const providerConfig = {
    LLM_API_KEY: providerSecret,
    LLM_API_HOST: 'https://api.deepseek.example',
    LLM_DEFAULT_MODEL: 'deepseek-chat',
    DIFY_SYNC_LLM_PROVIDER: 'true',
  };
  try {
    const configured = createBootstrapHarness([], null, providerConfig);
    const configuredRequests: Array<{ method: string; url: string; body?: any }> = [];
    globalThis.fetch = async (url, init) => {
      const request = {
        method: String(init?.method || 'GET'),
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      configuredRequests.push(request);
      if (request.method === 'GET' && request.url === providerListUrl) {
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'no-configure' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (request.method === 'POST' && request.url === providerUrl) {
        return new Response(JSON.stringify({ result: 'success' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      assert.fail(`未预期的模型 Provider 请求: ${request.method} ${request.url}`);
    };
    const configuredStatus = await configured.service.bootstrap({
      consoleToken: AUTHORIZATION.token,
      consoleBase: AUTHORIZATION.consoleBase,
    }) as any;
    assert.equal(configuredStatus.modelProvider.status, 'configured');
    assert.equal(configuredStatus.modelProvider.configuredNow, true);
    assert.deepEqual(configuredRequests.map((request) => `${request.method} ${request.url}`), [
      `GET ${providerListUrl}`,
      `POST ${providerUrl}`,
    ]);
    assert.deepEqual(configuredRequests[1].body, {
      credentials: {
        api_key: providerSecret,
        endpoint_url: 'https://api.deepseek.example',
      },
    });
    assert.doesNotMatch(
      JSON.stringify(configured.saved),
      new RegExp(providerSecret),
      'LLM Provider 密钥只应保存到 Dify，不得进入 futureFlow 集成记录',
    );

    const alreadyActive = createBootstrapHarness([], null, providerConfig);
    let activeRequests = 0;
    globalThis.fetch = async (url, init) => {
      activeRequests += 1;
      assert.equal(String(init?.method || 'GET'), 'GET');
      assert.equal(String(url), providerListUrl);
      return new Response(JSON.stringify({
        data: [{ provider: 'deepseek', custom_configuration: { status: 'active' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const activeStatus = await alreadyActive.service.bootstrap({
      consoleToken: AUTHORIZATION.token,
      consoleBase: AUTHORIZATION.consoleBase,
    }) as any;
    assert.equal(activeRequests, 1, '已生效的 Provider 不得被重复覆盖或重复验证计费');
    assert.equal(activeStatus.modelProvider.status, 'active');
    assert.equal(activeStatus.modelProvider.configuredNow, false);

    const rejected = createBootstrapHarness([], null, providerConfig);
    globalThis.fetch = async (url, init) => {
      if (String(init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'no-configure' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(String(url), providerUrl);
      return new Response(JSON.stringify({ error: 'credential validation failed' }), { status: 400 });
    };
    await assert.rejects(
      () => rejected.service.bootstrap({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      /Dify Console 请求失败（HTTP 400）/,
    );
    assert.equal(rejected.saved.length, 0, 'Provider 验证失败时不得保存“已授权”状态');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testServiceApiKeyRotation() {
  const originalFetch = globalThis.fetch;
  const keysUrl = `${AUTHORIZATION.consoleBase}/apps/managed-app/api-keys`;
  try {
    const installFetch = (
      harness: ReturnType<typeof createRotationHarness>,
      options: {
        keys?: Array<{ id: string; token: string }>;
        newKey?: { id: string; token: string };
        oldRevokeStatus?: number;
        newCleanupStatus?: number;
      } = {},
    ) => {
      const requests: Array<{ method: string; url: string }> = [];
      const newKey = options.newKey || { id: 'new-key-id', token: NEW_SERVICE_KEY };
      globalThis.fetch = async (url, init) => {
        const request = {
          method: String(init?.method || 'GET'),
          url: String(url),
        };
        requests.push(request);
        if (request.method === 'GET' && request.url === keysUrl) {
          harness.events.push('GET_KEYS');
          return new Response(JSON.stringify({
            data: options.keys || [
              { id: 'manual-key-id', token: MANUAL_SERVICE_KEY },
              { id: 'old-key-id', token: OLD_SERVICE_KEY },
            ],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (request.method === 'POST' && request.url === keysUrl) {
          harness.events.push('POST_NEW_KEY');
          return new Response(JSON.stringify(newKey), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (request.method === 'DELETE' && request.url.startsWith(`${keysUrl}/`)) {
          const keyId = decodeURIComponent(request.url.slice(keysUrl.length + 1));
          harness.events.push(`DELETE_KEY:${keyId}`);
          const status = keyId === newKey.id
            ? options.newCleanupStatus ?? 204
            : options.oldRevokeStatus ?? 204;
          return new Response(null, { status });
        }
        assert.fail(`未预期的轮换请求: ${request.method} ${request.url}`);
      };
      return requests;
    };

    for (const oldRevokeStatus of [200, 204, 404]) {
      const harness = createRotationHarness();
      const requests = installFetch(harness, { oldRevokeStatus });
      const result = await harness.service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      });
      assert.deepEqual(result, { rotated: true });
      assert.deepEqual(harness.events, [
        'GET_KEYS',
        'POST_NEW_KEY',
        'DB_UPDATE',
        'DELETE_KEY:old-key-id',
      ]);
      assert.equal(
        requests.some((item) => item.url.endsWith('/manual-key-id')),
        false,
        '不得撤销不属于平台记录的人工 key',
      );
      assert.equal(
        (harness.service as any).decrypt(harness.current.encryptedApiKey),
        NEW_SERVICE_KEY,
      );
      assert.equal(harness.getStatusReads(), 1);
    }

    const noOldMatch = createRotationHarness();
    const noOldRequests = installFetch(noOldMatch, {
      keys: [{ id: 'manual-key-id', token: MANUAL_SERVICE_KEY }],
    });
    await noOldMatch.service.rotateServiceApiKey({
      consoleToken: AUTHORIZATION.token,
      consoleBase: AUTHORIZATION.consoleBase,
    });
    assert.deepEqual(noOldMatch.events, ['GET_KEYS', 'POST_NEW_KEY', 'DB_UPDATE']);
    assert.equal(noOldRequests.some((item) => item.method === 'DELETE'), false);

    const missingResponseId = createRotationHarness();
    let missingIdGetCount = 0;
    globalThis.fetch = async (url, init) => {
      const method = String(init?.method || 'GET');
      const requestUrl = String(url);
      if (method === 'GET' && requestUrl === keysUrl) {
        missingResponseId.events.push('GET_KEYS');
        missingIdGetCount += 1;
        return new Response(JSON.stringify({
          data: [
            { id: 'old-key-id', token: OLD_SERVICE_KEY },
            ...(missingIdGetCount > 1
              ? [{ id: 'recovered-new-key-id', token: NEW_SERVICE_KEY }]
              : []),
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && requestUrl === keysUrl) {
        missingResponseId.events.push('POST_NEW_KEY');
        return new Response(JSON.stringify({ token: NEW_SERVICE_KEY }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'DELETE' && requestUrl === `${keysUrl}/old-key-id`) {
        missingResponseId.events.push('DELETE_KEY:old-key-id');
        return new Response(null, { status: 204 });
      }
      assert.fail(`未预期的缺失 Key ID 请求: ${method} ${requestUrl}`);
    };
    await missingResponseId.service.rotateServiceApiKey({
      consoleToken: AUTHORIZATION.token,
      consoleBase: AUTHORIZATION.consoleBase,
    });
    assert.deepEqual(missingResponseId.events, [
      'GET_KEYS',
      'POST_NEW_KEY',
      'GET_KEYS',
      'DB_UPDATE',
      'DELETE_KEY:old-key-id',
    ]);
    assert.equal(
      (missingResponseId.service as any).decrypt(missingResponseId.current.encryptedApiKey),
      NEW_SERVICE_KEY,
      'Dify POST 漏掉 ID 时必须通过精确 token 匹配恢复新 Key ID',
    );

    const crossBase = createRotationHarness();
    let crossBaseRequests = 0;
    globalThis.fetch = async () => {
      crossBaseRequests += 1;
      return new Response(null, { status: 500 });
    };
    await assert.rejects(
      () => crossBase.service.rotateServiceApiKey({
        consoleToken: 'wrong-console-token',
        consoleBase: 'http://other-dify.test/console/api',
      }),
      /授权地址与目标应用绑定不一致/,
    );
    assert.equal(crossBaseRequests, 0, '跨 Base 必须在 GET/POST/DELETE 前拒绝');
    assert.equal(crossBase.updates.length, 0);

    const databaseFailure = createRotationHarness({
      updateError: new Error('database update failed'),
    });
    installFetch(databaseFailure);
    await assert.rejects(
      () => databaseFailure.service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      /database update failed/,
    );
    assert.deepEqual(databaseFailure.events, [
      'GET_KEYS',
      'POST_NEW_KEY',
      'DB_UPDATE',
      'DELETE_KEY:new-key-id',
    ]);
    assert.equal(
      (databaseFailure.service as any).decrypt(databaseFailure.current.encryptedApiKey),
      OLD_SERVICE_KEY,
    );

    const compensationFailure = createRotationHarness({
      updateError: new Error('database update failed'),
    });
    installFetch(compensationFailure, { newCleanupStatus: 500 });
    await assert.rejects(
      () => compensationFailure.service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      (error: unknown) => (
        error instanceof Error
        && /database update failed/.test(error.message)
        && /新 key 清理失败/.test(error.message)
        && /可能遗留需人工清理/.test(error.message)
      ),
    );

    const partialCompletion = createRotationHarness();
    installFetch(partialCompletion, { oldRevokeStatus: 500 });
    await assert.rejects(
      () => partialCompletion.service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      /新 key 已生效但旧 key 未撤销/,
    );
    assert.deepEqual(partialCompletion.events, [
      'GET_KEYS',
      'POST_NEW_KEY',
      'DB_UPDATE',
      'DELETE_KEY:old-key-id',
    ]);
    assert.equal(
      (partialCompletion.service as any).decrypt(partialCompletion.current.encryptedApiKey),
      NEW_SERVICE_KEY,
      '旧 key 撤销失败时必须保留已生效的新 key 数据库记录',
    );
    assert.equal(partialCompletion.getStatusReads(), 0, '部分完成不得返回完整成功状态');

    const invalidNewKey = createRotationHarness();
    installFetch(invalidNewKey, {
      newKey: { id: 'invalid-new-key-id', token: 'invalid-key' },
    });
    await assert.rejects(
      () => invalidNewKey.service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      /新 Service API Key 格式无效/,
    );
    assert.deepEqual(invalidNewKey.events, [
      'GET_KEYS',
      'POST_NEW_KEY',
      'DELETE_KEY:invalid-new-key-id',
    ]);
    assert.equal(invalidNewKey.updates.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testConcurrentServiceApiKeyRotation() {
  const originalFetch = globalThis.fetch;
  const keysUrl = `${AUTHORIZATION.consoleBase}/apps/managed-app/api-keys`;
  const concurrentKeys = [
    'app-CONCURRENTKEY00000000001',
    'app-CONCURRENTKEY00000000002',
  ];
  const current: any = {
    id: 'integration-id',
    name: 'default',
    workflowId: null,
    workflowVersion: null,
    appId: 'managed-app',
    consoleBase: AUTHORIZATION.consoleBase,
    encryptedApiKey: null,
    keyFingerprint: null,
    status: 'active',
    lastRotatedAt: null,
  };
  const remoteKeys = [
    { id: 'manual-key-id', token: MANUAL_SERVICE_KEY },
    { id: 'old-key-id', token: OLD_SERVICE_KEY },
  ];
  const deletedKeyIds: string[] = [];
  let createdKeyCount = 0;
  let lockRequests = 0;
  let activeTransactions = 0;
  let maxActiveTransactions = 0;
  let transactionTail = Promise.resolve();

  const repository: any = {
    findOne: async () => current,
    find: async () => [current],
  };
  const transactionRepository = {
    findOne: async (options: any) => {
      assert.deepEqual(options?.lock, { mode: 'pessimistic_write' });
      lockRequests += 1;
      return current;
    },
    update: async (_id: string, patch: any) => {
      Object.assign(current, patch);
      return { affected: 1 };
    },
  };
  repository.manager = {
    transaction: async <T>(operation: (manager: any) => Promise<T>): Promise<T> => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      activeTransactions += 1;
      maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
      try {
        return await operation({ getRepository: () => transactionRepository });
      } finally {
        activeTransactions -= 1;
        release();
      }
    },
  };

  const config = {
    get: (key: string, fallback = '') => ({
      DIFY_CONSOLE_BASE: AUTHORIZATION.consoleBase,
      DIFY_KEY_ENCRYPTION_SECRET: 'futureflow-cleanup-test-secret-32',
    } as Record<string, string>)[key] ?? fallback,
  };
  const service = new DifyIntegrationService(repository, config as any);
  current.encryptedApiKey = (service as any).encrypt(OLD_SERVICE_KEY);
  (service as any).getStatus = async () => ({ rotated: true });

  try {
    globalThis.fetch = async (url, init) => {
      const method = String(init?.method || 'GET');
      const requestUrl = String(url);
      if (method === 'GET' && requestUrl === keysUrl) {
        return new Response(JSON.stringify({ data: remoteKeys }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && requestUrl === keysUrl) {
        const index = createdKeyCount;
        createdKeyCount += 1;
        const created = { id: `new-key-${index + 1}`, token: concurrentKeys[index] };
        remoteKeys.push(created);
        return new Response(JSON.stringify(created), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'DELETE' && requestUrl.startsWith(`${keysUrl}/`)) {
        const keyId = decodeURIComponent(requestUrl.slice(keysUrl.length + 1));
        deletedKeyIds.push(keyId);
        const index = remoteKeys.findIndex((item) => item.id === keyId);
        if (index >= 0) remoteKeys.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      assert.fail(`未预期的并发轮换请求: ${method} ${requestUrl}`);
    };

    await Promise.all([
      service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
      service.rotateServiceApiKey({
        consoleToken: AUTHORIZATION.token,
        consoleBase: AUTHORIZATION.consoleBase,
      }),
    ]);

    assert.equal(lockRequests, 2, '两个轮换请求都必须在锁内重新读取绑定');
    assert.equal(maxActiveTransactions, 1, '同一绑定的两个轮换事务不得并行进入远端创建阶段');
    assert.equal(createdKeyCount, 2);
    assert.deepEqual(deletedKeyIds, ['old-key-id', 'new-key-1']);
    assert.deepEqual(remoteKeys, [
      { id: 'manual-key-id', token: MANUAL_SERVICE_KEY },
      { id: 'new-key-2', token: concurrentKeys[1] },
    ]);
    assert.equal(
      (service as any).decrypt(current.encryptedApiKey),
      concurrentKeys[1],
      '数据库必须只记录远端唯一保留的最新受管 key',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProvisioningCompensation() {
  const originalFetch = globalThis.fetch;
  const validKey = 'app-0123456789abcdefghijklmnop';
  const winner = {
    name: 'workflow:workflow-cleanup:v7',
    status: 'active',
    appId: 'winner-app',
    encryptedApiKey: 'winner-encrypted-key',
  };
  try {
    const runCase = async ({
      apiKeyStatus = 200,
      apiKey = validKey,
      deleteStatus = 204,
      saveError,
      createError,
      concurrentWinner,
      prepareService,
      apiKeyRawBody,
    }: {
      apiKeyStatus?: number;
      apiKey?: string;
      deleteStatus?: number;
      saveError?: Error;
      createError?: Error;
      concurrentWinner?: any;
      prepareService?: (service: DifyIntegrationService) => void;
      apiKeyRawBody?: string;
    }) => {
      const harness = createProvisionHarness({ saveError, createError, concurrentWinner });
      prepareService?.(harness.service);
      const requests: Array<{ url: string; method: string }> = [];
      globalThis.fetch = async (url, init) => {
        const request = { url: String(url), method: String(init?.method || 'GET') };
        requests.push(request);
        if (request.method === 'POST' && request.url === `${AUTHORIZATION.consoleBase}/apps`) {
          return new Response(JSON.stringify({ id: 'loser-app' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (request.method === 'POST' && request.url.endsWith('/apps/loser-app/api-keys')) {
          return new Response(apiKeyRawBody ?? JSON.stringify({ token: apiKey }), {
            status: apiKeyStatus,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (request.method === 'DELETE' && request.url.endsWith('/apps/loser-app')) {
          return new Response(null, { status: deleteStatus });
        }
        assert.fail(`未预期的 Dify 请求: ${request.method} ${request.url}`);
      };
      const action = () => harness.service.ensureWorkflowIntegration(
        PROVISION_INPUT,
        AUTHORIZATION,
      );
      return { harness, requests, action };
    };

    const keyFailure = await runCase({ apiKeyStatus: 500 });
    await assert.rejects(keyFailure.action, /Dify Console 请求失败/);
    assert.equal(keyFailure.harness.getSaves(), 0);
    assert.equal(keyFailure.requests.filter((item) => item.method === 'DELETE').length, 1);

    const invalidKey = await runCase({ apiKey: 'invalid-key' });
    await assert.rejects(invalidKey.action, /Service API Key 格式无效/);
    assert.equal(invalidKey.requests.filter((item) => item.method === 'DELETE').length, 1);

    for (const deleteStatus of [200, 404]) {
      const idempotentCleanup = await runCase({ apiKey: 'invalid-key', deleteStatus });
      await assert.rejects(
        idempotentCleanup.action,
        (error: unknown) => (
          error instanceof Error
          && /Service API Key 格式无效/.test(error.message)
          && !/资源清理失败/.test(error.message)
        ),
      );
      assert.equal(idempotentCleanup.requests.filter((item) => item.method === 'DELETE').length, 1);
    }

    const malformedKeyResponse = await runCase({ apiKeyRawBody: '{invalid-json' });
    await assert.rejects(
      malformedKeyResponse.action,
      (error: unknown) => error instanceof SyntaxError,
    );
    assert.equal(malformedKeyResponse.requests.filter((item) => item.method === 'DELETE').length, 1);

    const encryptionFailure = await runCase({
      prepareService: (service) => {
        (service as any).encrypt = () => {
          throw new Error('credential encryption failed');
        };
      },
    });
    await assert.rejects(encryptionFailure.action, /credential encryption failed/);
    assert.equal(encryptionFailure.requests.filter((item) => item.method === 'DELETE').length, 1);

    const createFailure = await runCase({ createError: new Error('entity creation failed') });
    await assert.rejects(createFailure.action, /entity creation failed/);
    assert.equal(createFailure.requests.filter((item) => item.method === 'DELETE').length, 1);

    const saveFailure = await runCase({ saveError: new Error('repository save failed') });
    await assert.rejects(saveFailure.action, /repository save failed/);
    assert.equal(saveFailure.harness.getSaves(), 1);
    assert.equal(saveFailure.requests.filter((item) => item.method === 'DELETE').length, 1);

    const concurrent = await runCase({
      saveError: new Error('duplicate key'),
      concurrentWinner: winner,
    });
    assert.equal(await concurrent.action(), winner);
    assert.equal(concurrent.requests.filter((item) => item.method === 'DELETE').length, 1);

    const provisioningWinner = { ...winner, status: 'provisioning' };
    const concurrentProvisioning = await runCase({
      saveError: new Error('duplicate key'),
      concurrentWinner: provisioningWinner,
    });
    assert.equal(await concurrentProvisioning.action(), provisioningWinner);
    assert.equal(
      concurrentProvisioning.requests.filter((item) => item.method === 'DELETE').length,
      1,
      '并发 winner 尚在导入时也必须先删除 loser App，再复用唯一绑定',
    );

    const cleanupFailure = await runCase({ apiKey: 'invalid-key', deleteStatus: 500 });
    await assert.rejects(
      cleanupFailure.action,
      (error: unknown) => (
        error instanceof Error
        && /Service API Key 格式无效/.test(error.message)
        && /资源清理失败/.test(error.message)
        && /可能遗留需人工清理/.test(error.message)
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFailureKeepsBindings() {
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [
      () => Promise.resolve(new Response(null, { status: 500 })),
      () => Promise.reject(new Error('network down')),
    ]) {
      const { service, deletedCriteria } = createCleanupHarness([binding('managed-app')]);
      globalThis.fetch = response as typeof globalThis.fetch;
      await assert.rejects(
        () => service.deleteWorkflowIntegrations('workflow-cleanup'),
        /工作流尚未删除|暂时不可达/,
      );
      assert.equal(deletedCriteria.length, 0);
    }

    const { service, deletedCriteria } = createCleanupHarness([binding('managed-app')]);
    let markedExpired = false;
    (service as any).refreshConsoleAuthorization = async () => null;
    (service as any).markConsoleAuthorizationExpired = async () => {
      markedExpired = true;
    };
    globalThis.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(
      () => service.deleteWorkflowIntegrations('workflow-cleanup'),
      /授权已失效或权限不足/,
    );
    assert.equal(markedExpired, true);
    assert.equal(deletedCriteria.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testRowsWithoutAppsNeedNoAuthorization() {
  const originalFetch = globalThis.fetch;
  try {
    const { service, deletedCriteria } = createCleanupHarness([binding(null)]);
    (service as any).resolveConsoleAuthorization = async () => null;
    globalThis.fetch = async () => {
      assert.fail('没有 appId 的绑定不应请求 Dify');
    };
    await service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.equal(deletedCriteria.length, 1);

    const empty = createCleanupHarness([]);
    await empty.service.deleteWorkflowIntegrations('workflow-cleanup');
    assert.equal(empty.deletedCriteria.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testWorkflowSoftDeleteWaitsForCleanup() {
  const makeService = (cleanup: () => Promise<void>) => {
    const workflow = { id: 'workflow-cleanup', userId: 'owner', status: 'active' };
    let saves = 0;
    const workflowRepo: any = {
      findOne: async () => workflow,
      save: async (value: any) => {
        saves += 1;
        return value;
      },
    };
    workflowRepo.manager = {
      transaction: async (operation: (manager: any) => Promise<unknown>) => operation({
        getRepository: () => workflowRepo,
      }),
    };
    const service = new WorkflowCrudService(
      workflowRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { deleteWorkflowIntegrations: cleanup } as any,
      {} as any,
    );
    return { service, workflow, getSaves: () => saves };
  };

  const failed = makeService(async () => {
    throw new Error('Dify cleanup failed');
  });
  await assert.rejects(() => failed.service.delete('workflow-cleanup', 'owner'));
  assert.equal(failed.workflow.status, 'active');
  assert.equal(failed.getSaves(), 0);

  let cleanedWorkflowId = '';
  const succeeded = makeService(async () => {
    cleanedWorkflowId = 'workflow-cleanup';
  });
  await succeeded.service.delete('workflow-cleanup', 'owner');
  assert.equal(cleanedWorkflowId, 'workflow-cleanup');
  assert.equal(succeeded.workflow.status, 'deleted');
  assert.equal(succeeded.getSaves(), 1);
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function yieldToWaitingTransaction() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createConcurrentWorkflowDatabase(
  published = false,
  beforeWorkflowSave: (workflow: any) => Promise<void> = async () => undefined,
) {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const state = {
    workflow: {
      id: 'workflow-concurrent',
      userId: 'owner',
      name: '并发工作流',
      description: '',
      status: 'active',
      version: 1,
      flowgramJson: { nodes: [{ id: 'start', type: 'start', data: {} }], edges: [] },
      publishedFlowgramJson: published
        ? { nodes: [{ id: 'start', type: 'start', data: {} }], edges: [] }
        : null,
      publishedVersion: published ? 1 : null,
      publishedAt: published ? new Date().toISOString() : null,
    },
    versions: [] as any[],
  };
  let lockTail = Promise.resolve();
  let lockRequests = 0;

  const acquireRowLock = async () => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };

  const manager = {
    transaction: async <T>(operation: (transactionManager: any) => Promise<T>): Promise<T> => {
      let release: (() => void) | undefined;
      let workflow = clone(state.workflow);
      let workflowDirty = false;
      const pendingVersions: any[] = [];

      const ensureLocked = async () => {
        if (release) return;
        release = await acquireRowLock();
        workflow = clone(state.workflow);
      };
      const workflowRepository = {
        findOne: async (options: any) => {
          assert.equal(
            options?.lock?.mode,
            'pessimistic_write',
            '生产路径必须请求 PostgreSQL 写行锁，不能退化为普通读取',
          );
          lockRequests += 1;
          await ensureLocked();
          return workflow && options?.where?.id === workflow.id ? workflow : null;
        },
        save: async (value: any) => {
          await ensureLocked();
          await beforeWorkflowSave(value);
          workflow = clone(value);
          workflowDirty = true;
          return workflow;
        },
      };
      const versionRepository = {
        findOne: async ({ where }: any) => (
          [...state.versions, ...pendingVersions].find(
            (item) => item.workflowId === where.workflowId && item.version === where.version,
          ) || null
        ),
        create: (value: any) => value,
        save: async (value: any) => {
          pendingVersions.push(clone(value));
          return value;
        },
      };
      const transactionManager = {
        getRepository: (entity: unknown) => {
          if (entity === Workflow) return workflowRepository;
          if ((entity as any)?.name === 'WorkflowVersion') return versionRepository;
          if ((entity as any)?.name === 'User') {
            return { findOne: async () => ({ id: 'owner', vipLevel: 'enterprise' }) };
          }
          throw new Error(`未预期的事务仓库: ${(entity as any)?.name || String(entity)}`);
        },
      };

      try {
        const result = await operation(transactionManager);
        if (workflowDirty) state.workflow = clone(workflow);
        state.versions.push(...pendingVersions);
        return result;
      } finally {
        release?.();
      }
    },
  };

  return {
    state,
    getLockRequests: () => lockRequests,
    createRepository: () => ({
      manager,
      // These unlocked methods deliberately model the pre-fix implementation.
      // The concurrency regressions below fail if update returns to using them.
      findOne: async ({ where }: any) => (
        where?.id === state.workflow.id ? clone(state.workflow) : null
      ),
      save: async (value: any) => {
        await beforeWorkflowSave(value);
        state.workflow = clone(value);
        return clone(value);
      },
    }),
  };
}

function createConcurrentWorkflowService(
  database: ReturnType<typeof createConcurrentWorkflowDatabase>,
  sync: (input: any) => Promise<any>,
  cleanup: (workflowId: string) => Promise<void>,
) {
  return new WorkflowCrudService(
    database.createRepository() as any,
    {} as any,
    {} as any,
    { toDifyDSL: () => ({}) } as any,
    { syncPublishedWorkflow: sync } as any,
    { deleteWorkflowIntegrations: cleanup } as any,
    { checkNodePermissions: () => ({ allowed: true, deniedNodes: [] }) } as any,
  );
}

const syncedResult = {
  appId: 'app-v1',
  status: 'synced' as const,
  message: '同步成功',
};

async function testPublishFirstMakesDeleteCleanNewApp() {
  const database = createConcurrentWorkflowDatabase();
  const syncEntered = createDeferred();
  const allowSync = createDeferred();
  const apps = new Set<string>();
  const events: string[] = [];
  let cleanupStarted = false;
  let cleanupSawApps: string[] = [];

  const sync = async () => {
    events.push('sync-start');
    syncEntered.resolve();
    await allowSync.promise;
    apps.add('app-v1');
    events.push('sync-finish');
    return syncedResult;
  };
  const cleanup = async () => {
    cleanupStarted = true;
    cleanupSawApps = [...apps];
    events.push('cleanup-start');
    apps.clear();
  };
  const publisher = createConcurrentWorkflowService(database, sync, cleanup);
  const deleter = createConcurrentWorkflowService(database, sync, cleanup);

  const publishing = publisher.publish('workflow-concurrent', 'owner');
  await syncEntered.promise;
  const deleting = deleter.delete('workflow-concurrent', 'owner');
  await yieldToWaitingTransaction();
  assert.equal(cleanupStarted, false, '发布持锁时删除必须等待 Dify 同步完成');

  allowSync.resolve();
  await publishing;
  await deleting;
  assert.deepEqual(events, ['sync-start', 'sync-finish', 'cleanup-start']);
  assert.deepEqual(cleanupSawApps, ['app-v1'], '删除必须清理刚发布创建的应用');
  assert.equal(apps.size, 0);
  assert.equal(database.state.workflow.status, 'deleted');
  assert.equal(database.getLockRequests(), 2);
}

async function testDeleteFirstPreventsPublishProvisioning() {
  const database = createConcurrentWorkflowDatabase();
  const cleanupEntered = createDeferred();
  const allowCleanup = createDeferred();
  let syncCalls = 0;
  const sync = async () => {
    syncCalls += 1;
    return syncedResult;
  };
  const cleanup = async () => {
    cleanupEntered.resolve();
    await allowCleanup.promise;
  };
  const deleter = createConcurrentWorkflowService(database, sync, cleanup);
  const publisher = createConcurrentWorkflowService(database, sync, cleanup);

  const deleting = deleter.delete('workflow-concurrent', 'owner');
  await cleanupEntered.promise;
  const publishing = publisher.publish('workflow-concurrent', 'owner');
  const publishRejected = assert.rejects(publishing, /工作流不存在/);
  await yieldToWaitingTransaction();
  assert.equal(syncCalls, 0, '删除持锁时发布不能提前创建 Dify 应用');

  allowCleanup.resolve();
  await deleting;
  await publishRejected;
  assert.equal(syncCalls, 0, '发布等待后必须重新读取 deleted 状态并拒绝');
  assert.equal(database.state.workflow.status, 'deleted');
  assert.equal(database.getLockRequests(), 2);
}

async function testManualSyncAlsoSerializesWithDelete() {
  const database = createConcurrentWorkflowDatabase(true);
  const syncEntered = createDeferred();
  const allowSync = createDeferred();
  let cleanupStarted = false;
  const sync = async () => {
    syncEntered.resolve();
    await allowSync.promise;
    return syncedResult;
  };
  const cleanup = async () => {
    cleanupStarted = true;
  };
  const synchronizer = createConcurrentWorkflowService(database, sync, cleanup);
  const deleter = createConcurrentWorkflowService(database, sync, cleanup);

  const syncing = synchronizer.syncPublishedDify('workflow-concurrent', 'owner');
  await syncEntered.promise;
  const deleting = deleter.delete('workflow-concurrent', 'owner');
  await yieldToWaitingTransaction();
  assert.equal(cleanupStarted, false, '手动同步持锁时删除也必须等待');

  allowSync.resolve();
  await syncing;
  await deleting;
  assert.equal(cleanupStarted, true);
  assert.equal(database.state.workflow.status, 'deleted');
  assert.equal(database.getLockRequests(), 2);
}

async function testCleanupFailureRollsBackAndReleasesLock() {
  const database = createConcurrentWorkflowDatabase();
  const cleanupEntered = createDeferred();
  const allowCleanupFailure = createDeferred();
  let syncCalls = 0;
  const sync = async () => {
    syncCalls += 1;
    return syncedResult;
  };
  const cleanup = async () => {
    cleanupEntered.resolve();
    await allowCleanupFailure.promise;
    throw new Error('Dify cleanup failed');
  };
  const deleter = createConcurrentWorkflowService(database, sync, cleanup);
  const publisher = createConcurrentWorkflowService(database, sync, async () => undefined);

  const deleting = deleter.delete('workflow-concurrent', 'owner');
  const deleteRejected = assert.rejects(deleting, /Dify cleanup failed/);
  await cleanupEntered.promise;
  const publishing = publisher.publish('workflow-concurrent', 'owner');
  await yieldToWaitingTransaction();
  assert.equal(syncCalls, 0, '清理失败事务释放锁前发布必须等待');

  allowCleanupFailure.resolve();
  await deleteRejected;
  await publishing;
  assert.equal(database.state.workflow.status, 'active');
  assert.equal(database.state.workflow.publishedVersion, 1);
  assert.equal(syncCalls, 1, '删除回滚后等待中的发布应继续执行');
  assert.equal(database.getLockRequests(), 2);
}

async function testConcurrentUpdateCannotReviveDeletedWorkflow() {
  const updateSaveEntered = createDeferred();
  const allowUpdateSave = createDeferred();
  const updatedName = '自动保存中的名称';
  const database = createConcurrentWorkflowDatabase(false, async (workflow) => {
    if (workflow.name !== updatedName) return;
    updateSaveEntered.resolve();
    await allowUpdateSave.promise;
  });
  let cleanupStarted = false;
  const sync = async () => syncedResult;
  const cleanup = async () => {
    cleanupStarted = true;
  };
  const updater = createConcurrentWorkflowService(database, sync, cleanup);
  const deleter = createConcurrentWorkflowService(database, sync, cleanup);

  const updating = updater.update('workflow-concurrent', 'owner', { name: updatedName });
  await updateSaveEntered.promise;
  const deleting = deleter.delete('workflow-concurrent', 'owner');
  await yieldToWaitingTransaction();
  assert.equal(cleanupStarted, false, '更新持锁且尚未保存时，删除必须等待而不能穿过更新');

  allowUpdateSave.resolve();
  await updating;
  await deleting;
  assert.equal(database.state.workflow.name, updatedName);
  assert.equal(database.state.workflow.status, 'deleted', '旧的 active 实体不能在删除后复活工作流');
  assert.equal(database.getLockRequests(), 2);
}

async function testConcurrentUpdatePreservesPublishedSnapshot() {
  const updateSaveEntered = createDeferred();
  const allowUpdateSave = createDeferred();
  const updatedName = '发布期间的自动保存';
  const database = createConcurrentWorkflowDatabase(false, async (workflow) => {
    if (workflow.name !== updatedName) return;
    updateSaveEntered.resolve();
    await allowUpdateSave.promise;
  });
  const syncEntered = createDeferred();
  const allowSync = createDeferred();
  const sync = async () => {
    syncEntered.resolve();
    await allowSync.promise;
    return syncedResult;
  };
  const publisher = createConcurrentWorkflowService(database, sync, async () => undefined);
  const updater = createConcurrentWorkflowService(database, sync, async () => undefined);

  const publishing = publisher.publish('workflow-concurrent', 'owner');
  await syncEntered.promise;
  const updating = updater.update('workflow-concurrent', 'owner', { name: updatedName });
  await yieldToWaitingTransaction();

  allowSync.resolve();
  await publishing;
  await updateSaveEntered.promise;
  allowUpdateSave.resolve();
  await updating;

  assert.equal(database.state.workflow.name, updatedName);
  assert.equal(database.state.workflow.version, 2);
  assert.equal(database.state.workflow.publishedVersion, 1);
  assert.ok(
    database.state.workflow.publishedFlowgramJson,
    '发布后执行的更新必须基于最新行，不能用 stale null 覆盖发布快照',
  );
  assert.ok(database.state.workflow.publishedAt);
  assert.equal(database.getLockRequests(), 2);
}

async function testUnexpectedSyncThrowStillCommitsSnapshot() {
  const database = createConcurrentWorkflowDatabase();
  const service = createConcurrentWorkflowService(
    database,
    async () => {
      throw new Error('unexpected Dify failure');
    },
    async () => undefined,
  );

  await assert.rejects(
    () => service.publish('workflow-concurrent', 'owner'),
    /unexpected Dify failure/,
  );
  assert.equal(database.state.workflow.status, 'active');
  assert.equal(database.state.workflow.publishedVersion, 1);
  assert.ok(database.state.workflow.publishedFlowgramJson);
  assert.equal(database.state.versions.length, 1, 'Dify 异常不得回滚本地不可变版本');

  await service.delete('workflow-concurrent', 'owner');
  assert.equal(database.state.workflow.status, 'deleted', '异常后事务锁必须正常释放');
}

async function main() {
  await testSuccessfulAndIdempotentStatuses();
  await testAllVersionsAndDuplicateApps();
  await testPartialFailureRemainsRetryable();
  await testAuthorizationRefresh();
  await testConsoleBaseSafetyBeforeDelete();
  await testBootstrapConsoleBaseSwitchGate();
  await testBootstrapCredentialIsolation();
  await testManagedModelProviderBootstrap();
  await testServiceApiKeyRotation();
  await testConcurrentServiceApiKeyRotation();
  await testProvisioningCompensation();
  await testFailureKeepsBindings();
  await testRowsWithoutAppsNeedNoAuthorization();
  await testWorkflowSoftDeleteWaitsForCleanup();
  await testPublishFirstMakesDeleteCleanNewApp();
  await testDeleteFirstPreventsPublishProvisioning();
  await testManualSyncAlsoSerializesWithDelete();
  await testCleanupFailureRollsBackAndReleasesLock();
  await testConcurrentUpdateCannotReviveDeletedWorkflow();
  await testConcurrentUpdatePreservesPublishedSnapshot();
  await testUnexpectedSyncThrowStillCommitsSnapshot();
  console.log('Dify 工作流资源清理测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
