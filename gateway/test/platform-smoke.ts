import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';

import { PermissionChecker } from '../src/auth/auth.module';
import { ApiKeyService } from '../src/auth/api-key.service';
import { AuthMiddleware } from '../src/auth/auth.middleware';
import { DifyConverterService } from '../src/converter/dify-converter.service';
import { DifyConsoleService } from '../src/dify/dify-console.service';
import { DifyIntegrationService } from '../src/dify/dify-integration.service';
import { validateEnvironment } from '../src/config/environment.validation';
import { SeedService } from '../src/database/seed.service';
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
  );
  const response = {
    req: { user: { id: 'user-1', username: 'tester' } },
    setHeader() {},
    flushHeaders() {},
    once() {},
    removeListener() {},
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

  await (controller as any).streamWorkflow(
    { nodes: [], edges: [] },
    {},
    response.req.user,
    response as any,
  );

  assert.equal(finalized, true, '控制器必须等待生成器完成结算逻辑');
  assert.equal(ended, true, 'SSE 响应必须正常结束');
  assert.match(writes[0], /workflow_finished/);
}

async function testGatewaySecurityDefaults() {
  assert.throws(
    () => validateEnvironment({
      GATEWAY_JWT_SECRET: 'replace-with-a-random-gateway-jwt-secret-at-least-32-characters',
    }),
    /GATEWAY_JWT_SECRET/,
  );
  assert.equal(
    validateEnvironment({
      GATEWAY_JWT_SECRET: 'a'.repeat(32),
      POSTGRES_PASSWORD: 'b'.repeat(32),
    }).GATEWAY_JWT_SECRET,
    'a'.repeat(32),
  );
  assert.throws(
    () => validateEnvironment({
      GATEWAY_JWT_SECRET: 'a'.repeat(32),
      POSTGRES_PASSWORD: 'short-password',
    }),
    /POSTGRES_PASSWORD/,
  );

  const bootstrapDisabledConfig = {
    get: (name: string, fallback: string) => (
      name === 'GATEWAY_BOOTSTRAP_ADMIN_ENABLED' ? 'false' : fallback
    ),
  } as any;

  const unsafeLegacyUser = {
    username: 'demo',
    passwordHash: await bcrypt.hash('demo123456', 4),
    role: 'admin',
    status: 'active',
  };
  let unsafeLookupCount = 0;
  let unsafeSaveCount = 0;
  const unsafeSeed = new SeedService(
    {
      findOne: async ({ where }: any) => {
        unsafeLookupCount += 1;
        assert.deepEqual(where, { username: 'demo' });
        return unsafeLegacyUser;
      },
      save: async (user: any) => {
        unsafeSaveCount += 1;
        return user;
      },
    } as any,
    bootstrapDisabledConfig,
  );
  await unsafeSeed.onModuleInit();
  assert.equal(unsafeLookupCount, 1, '即使管理员初始化关闭，也必须执行旧账号安全检查');
  assert.equal(unsafeSaveCount, 1);
  assert.equal(unsafeLegacyUser.status, 'suspended', '旧公开密码账号必须暂停以使现有 JWT 失效');
  assert.equal(unsafeLegacyUser.role, 'user', '旧公开密码管理员必须降权');
  const legacyJwtMiddleware = new AuthMiddleware(
    { findOne: async () => unsafeLegacyUser } as any,
    { verify: () => ({ sub: 'legacy-demo-user' }) } as any,
    { authenticate: async () => null } as any,
  );
  await assert.rejects(
    () => legacyJwtMiddleware.use(
      { headers: { authorization: 'Bearer previously-issued-jwt' } } as any,
      {} as any,
      () => assert.fail('暂停后的旧账号不得继续使用已有 JWT'),
    ),
    /无效的 Token 或 API Key/,
  );

  const changedPasswordUser = {
    username: 'demo',
    passwordHash: await bcrypt.hash('a-new-private-password', 4),
    role: 'admin',
    status: 'active',
  };
  let changedPasswordSaveCount = 0;
  const changedPasswordSeed = new SeedService(
    {
      findOne: async () => changedPasswordUser,
      save: async () => {
        changedPasswordSaveCount += 1;
      },
    } as any,
    bootstrapDisabledConfig,
  );
  await changedPasswordSeed.onModuleInit();
  assert.equal(changedPasswordSaveCount, 0, '已修改密码的合法 demo 管理员不得被改动');
  assert.equal(changedPasswordUser.status, 'active');
  assert.equal(changedPasswordUser.role, 'admin');

  let missingAccountLookupCount = 0;
  const noLegacyAccountSeed = new SeedService(
    {
      findOne: async () => {
        missingAccountLookupCount += 1;
        return null;
      },
      save: async () => assert.fail('不存在旧账号时不应写数据库'),
    } as any,
    bootstrapDisabledConfig,
  );
  await assert.doesNotReject(() => noLegacyAccountSeed.onModuleInit());
  assert.equal(missingAccountLookupCount, 1);
}

function testSyntheticDnsSsrfPolicy() {
  const squidConfig = readFileSync(
    resolve(__dirname, '../../infra/dify/ssrf_proxy/squid.conf.template'),
    'utf8',
  );
  const composeConfig = readFileSync(
    resolve(__dirname, '../../docker-compose.yml'),
    'utf8',
  );

  assert.match(squidConfig, /acl synthetic_dns_dst dst 198\.18\.0\.0\/15/);
  assert.match(squidConfig, /acl blocked_dst dst 198\.18\.0\.0\/15/);
  assert.match(
    squidConfig,
    /acl synthetic_dns_allowed_domains dstdomain -n \$\{SYNTHETIC_DNS_ALLOWED_DOMAINS\}/,
  );
  const directIpPatterns = [...squidConfig.matchAll(
    /^acl direct_ip_url url_regex -i (.+)$/gm,
  )].map((match) => new RegExp(match[1], 'i'));
  assert.ok(directIpPatterns.length >= 4, '必须同时覆盖 IPv4、IPv6、HTTP 和 CONNECT IP 字面量');
  const isDirectIpUrl = (url: string) => directIpPatterns.some((pattern) => pattern.test(url));
  assert.equal(isDirectIpUrl('198.18.0.100:443'), true);
  assert.equal(isDirectIpUrl('http://198.18.0.100/anything'), true);
  assert.equal(isDirectIpUrl('http://probe@198.18.0.100/anything'), true);
  assert.equal(isDirectIpUrl('[::1]:443'), true);
  assert.equal(isDirectIpUrl('https://[::1]/health'), true);
  assert.equal(isDirectIpUrl('https://probe@[::1]/health'), true);
  assert.equal(isDirectIpUrl('postman-echo.com:443'), false);
  assert.equal(isDirectIpUrl('https://postman-echo.com/post'), false);

  const denyDomains = squidConfig.indexOf('http_access deny blocked_domains');
  const syntheticAllow = squidConfig.indexOf(
    'http_access allow localnet synthetic_dns_dst synthetic_dns_allowed_domains !direct_ip_url',
  );
  const denyResolvedPrivate = squidConfig.indexOf('http_access deny blocked_dst');
  const generalLocalAllow = squidConfig.indexOf('http_access allow localnet\n');
  assert.ok(denyDomains >= 0 && denyDomains < syntheticAllow, '内部域名拒绝必须先于合成 DNS 例外');
  assert.ok(
    syntheticAllow < denyResolvedPrivate,
    '合成 DNS 例外必须位于解析后私网拒绝之前',
  );
  assert.ok(
    denyResolvedPrivate < generalLocalAllow,
    '解析后私网拒绝必须先于一般本地客户端放行',
  );
  assert.match(
    composeConfig,
    /DIFY_SSRF_SYNTHETIC_DNS_ALLOWED_DOMAINS:-\.invalid/,
    '合成 DNS 域名白名单必须默认关闭',
  );
  assert.doesNotMatch(
    squidConfig,
    /http_access allow synthetic_dns_dst/,
    '不得脱离 localnet、域名白名单和 IP 字面量保护直接放行合成网段',
  );
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
    // The bootstrap fixture intentionally has no LLM_API_KEY.  Dify must
    // still report the DeepSeek provider as installed, but not active, so
    // bootstrap can persist Console authorization without configuring a
    // credential or performing a model request.
    if (url.endsWith('/workspaces/current/model-providers?model_type=llm') && method === 'GET') {
      return new Response(JSON.stringify({
        data: [{ provider: 'deepseek', custom_configuration: { status: 'not_configured' } }],
      }), { status: 200 });
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

async function testDifyConsolePublishMustSucceedBeforeActivation() {
  const originalFetch = global.fetch;
  const input = {
    workflowId: 'workflow-publish-guard',
    workflowVersion: 7,
    workflowName: '发布保护回归',
    flowgram: { nodes: [], edges: [] },
  };

  const runScenario = async (publishResponse: Response) => {
    const fetchCalls: string[] = [];
    const activationCalls: Array<{ workflowId: string; workflowVersion: number }> = [];
    const integration = {
      resolveConsoleAuthorization: async () => ({
        consoleBase: 'http://dify.test/console/api',
        token: 'test-console-token',
      }),
      ensureWorkflowIntegration: async () => ({ appId: 'dify-app-guard' }),
      activateWorkflowIntegration: async (workflowId: string, workflowVersion: number) => {
        activationCalls.push({ workflowId, workflowVersion });
      },
    };
    global.fetch = (async (url: string) => {
      fetchCalls.push(url);
      if (url.endsWith('/apps/imports')) {
        return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
      }
      if (url.endsWith('/apps/dify-app-guard/workflows/publish')) {
        return publishResponse;
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof global.fetch;

    const service = new DifyConsoleService(
      { get: (_key: string, fallback = '') => fallback } as any,
      { toDifyDSLYaml: () => 'app: {}' } as any,
      integration as any,
    );
    const result = await service.syncPublishedWorkflow(input as any);
    return { result, fetchCalls, activationCalls };
  };

  try {
    const success = await runScenario(new Response(null, { status: 204 }));
    assert.equal(success.result.status, 'synced', '任意 2xx 发布响应都应视为成功');
    assert.equal(success.fetchCalls.length, 2, '成功路径必须依次调用导入和发布接口');
    assert.deepEqual(success.activationCalls, [{
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
    }]);

    const failure = await runScenario(new Response('upstream publish rejected', {
      status: 500,
      statusText: 'Internal Server Error',
    }));
    assert.equal(failure.result.status, 'failed', '发布失败不得伪报已同步');
    assert.equal(failure.fetchCalls.length, 2, '发布失败前仍应完成一次导入和一次发布请求');
    assert.equal(failure.activationCalls.length, 0, '未发布版本不得绑定为可执行版本');
    assert.match(failure.result.message, /500/);
    assert.match(failure.result.message, /Dify 工作流发布失败/);
    assert.doesNotMatch(
      failure.result.message,
      /upstream publish rejected/,
      '上游响应正文可能包含服务内部信息，不得直接回显给客户端',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

function createDifyIntegrationHarness(values: Record<string, string>) {
  const stored: any[] = [];
  const repository = {
    findOne: async ({ where }: any) => stored.find((item) => Object.entries(where).every(
      ([key, value]) => item[key] === value,
    )) || null,
    find: async ({ where }: any) => stored.filter((item) => Object.entries(where || {}).every(
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
        : stored.filter((item) => Object.entries(criteria).every(
            ([key, expected]) => item[key] === expected,
          ));
      matches.forEach((item) => Object.assign(item, value));
      return { affected: matches.length };
    },
  };
  const config = {
    get: (key: string, fallback = '') => values[key] ?? fallback,
  };
  return {
    stored,
    service: new DifyIntegrationService(repository as any, config as any),
    config,
  };
}

async function testDifyAutomaticAdminAuthorizationIsEncryptedAndFatal() {
  const originalFetch = global.fetch;
  const consoleBase = 'http://dify-auto.test/console/api';
  const accessToken = 'automatic-access-token';
  const refreshToken = 'automatic-refresh-token';
  const adminPassword = 'automatic-admin-password-that-is-never-persisted';
  try {
    const ready = createDifyIntegrationHarness({
      DIFY_AUTO_BOOTSTRAP: 'true',
      DIFY_AUTO_BOOTSTRAP_ATTEMPTS: '1',
      DIFY_AUTO_BOOTSTRAP_RETRY_MS: '0',
      DIFY_CONSOLE_BASE: consoleBase,
      DIFY_ADMIN_EMAIL: '',
      DIFY_ADMIN_PASSWORD: adminPassword,
      DIFY_KEY_ENCRYPTION_SECRET: 'automatic-bootstrap-encryption-secret-123456',
    });
    const calls: Array<{ url: string; method: string; body: any }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(request);
      if (request.url === `${consoleBase}/login` && request.method === 'POST') {
        assert.equal(request.body.email, 'admin@futureflow.local', '空管理员邮箱必须回退本地默认值');
        assert.equal(request.body.password, adminPassword);
        return new Response(JSON.stringify({
          result: 'success',
          data: { access_token: accessToken, refresh_token: refreshToken },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (request.url === `${consoleBase}/apps` && request.method === 'GET') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers?model_type=llm`
        && request.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'not_configured' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.fail(`未预期的自动授权请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    await ready.service.onModuleInit();
    const connection = ready.stored.find((item) => item.name === 'default');
    assert.ok(connection, '自动授权必须创建默认控制面连接');
    assert.match(connection.encryptedConsoleToken, /^v1:/);
    assert.match(connection.encryptedConsoleRefreshToken, /^v1:/);
    assert.equal((ready.service as any).decrypt(connection.encryptedConsoleToken), accessToken);
    assert.equal((ready.service as any).decrypt(connection.encryptedConsoleRefreshToken), refreshToken);
    assert.equal(connection.appId, null, '受管自动授权不得绑定 legacy 应用');
    const persisted = JSON.stringify(ready.stored);
    assert.doesNotMatch(persisted, new RegExp(accessToken));
    assert.doesNotMatch(persisted, new RegExp(refreshToken));
    assert.doesNotMatch(persisted, new RegExp(adminPassword));
    assert.equal(
      calls.filter((item) => item.method === 'POST' && item.url === `${consoleBase}/apps`).length,
      0,
      '自动保存 Console 授权不得创建共享执行应用',
    );

    const unavailable = createDifyIntegrationHarness({
      DIFY_AUTO_BOOTSTRAP: 'true',
      DIFY_AUTO_BOOTSTRAP_ATTEMPTS: '2',
      DIFY_AUTO_BOOTSTRAP_RETRY_MS: '0',
      DIFY_CONSOLE_BASE: consoleBase,
      DIFY_ADMIN_PASSWORD: adminPassword,
      DIFY_KEY_ENCRYPTION_SECRET: 'automatic-bootstrap-encryption-secret-123456',
    });
    let loginAttempts = 0;
    global.fetch = (async () => {
      loginAttempts += 1;
      throw new TypeError('fetch failed');
    }) as typeof global.fetch;
    await assert.rejects(
      () => unavailable.service.onModuleInit(),
      /网关拒绝进入就绪状态/,
      '自动授权最终失败时必须阻止 Gateway 就绪',
    );
    assert.equal(loginAttempts, 2, '暂时不可达时必须按配置严格重试');
    assert.equal(unavailable.stored.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testDifyAutomaticAuthorizationSyncsModelProviderAfterKeyAdded() {
  const originalFetch = global.fetch;
  const consoleBase = 'http://dify-provider-restart.test/console/api';
  const llmApiKey = 'sk-model-key-added-after-initial-start';
  const seedConnection = (
    harness: ReturnType<typeof createDifyIntegrationHarness>,
    accessToken: string,
    refreshToken: string,
  ) => {
    harness.stored.push({
      id: 'default-integration',
      name: 'default',
      workflowId: null,
      workflowVersion: null,
      appId: null,
      consoleBase,
      encryptedApiKey: null,
      encryptedConsoleToken: (harness.service as any).encrypt(accessToken),
      encryptedConsoleRefreshToken: (harness.service as any).encrypt(refreshToken),
      keyFingerprint: null,
      status: 'active',
      lastRotatedAt: null,
      lastConsoleAuthorizedAt: new Date(),
    });
  };
  const providerConfig = {
    DIFY_AUTO_BOOTSTRAP_ATTEMPTS: '1',
    DIFY_AUTO_BOOTSTRAP_RETRY_MS: '0',
    DIFY_CONSOLE_BASE: consoleBase,
    DIFY_ADMIN_PASSWORD: 'restart-provider-admin-password-123456789',
    DIFY_KEY_ENCRYPTION_SECRET: 'restart-provider-encryption-secret-123456789',
    DIFY_SYNC_LLM_PROVIDER: 'true',
    LLM_DEFAULT_MODEL: 'deepseek-chat',
    LLM_API_HOST: 'https://api.deepseek.com',
    LLM_API_KEY: llmApiKey,
  };

  try {
    const storedAuthorization = createDifyIntegrationHarness(providerConfig);
    seedConnection(storedAuthorization, 'valid-restart-token', 'valid-restart-refresh-token');
    const validCalls: Array<{ url: string; method: string; authorization: string; body: any }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      validCalls.push(request);
      assert.equal(request.authorization, 'Bearer valid-restart-token');
      if (request.url === `${consoleBase}/apps` && request.method === 'GET') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers?model_type=llm`
        && request.method === 'GET'
      ) {
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'not_configured' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers/deepseek`
        && request.method === 'POST'
      ) {
        assert.equal(request.body.credentials.api_key, llmApiKey);
        assert.equal(request.body.credentials.endpoint_url, 'https://api.deepseek.com');
        return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      }
      assert.fail(`未预期的模型 Provider 重启同步请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    // DIFY_AUTO_BOOTSTRAP is intentionally omitted: one-click mode must be
    // the service-level default, not only an .env.example convention.
    await storedAuthorization.service.onModuleInit();
    assert.equal(
      validCalls.filter((item) => item.url.endsWith('/model-providers/deepseek')).length,
      1,
      '已有有效 Console 授权时，后补的模型 Key 必须在重启后自动同步',
    );
    assert.equal(
      validCalls.some((item) => item.url.endsWith('/login') || item.url.endsWith('/refresh-token')),
      false,
      '有效的已保存授权不应触发登录或刷新',
    );

    const refreshedAuthorization = createDifyIntegrationHarness({
      ...providerConfig,
      DIFY_AUTO_BOOTSTRAP: 'true',
    });
    seedConnection(refreshedAuthorization, 'expired-restart-token', 'restart-refresh-token');
    const refreshedCalls: Array<{ url: string; method: string; authorization: string }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      refreshedCalls.push(request);
      if (request.url === `${consoleBase}/apps` && request.method === 'GET') {
        if (request.authorization === 'Bearer expired-restart-token') {
          return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
        }
        assert.equal(request.authorization, 'Bearer refreshed-restart-token');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (request.url === `${consoleBase}/refresh-token` && request.method === 'POST') {
        return new Response(JSON.stringify({
          data: {
            access_token: 'refreshed-restart-token',
            refresh_token: 'refreshed-restart-refresh-token',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers?model_type=llm`
        && request.method === 'GET'
      ) {
        assert.equal(request.authorization, 'Bearer refreshed-restart-token');
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'not_configured' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers/deepseek`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, 'Bearer refreshed-restart-token');
        return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      }
      assert.fail(`未预期的刷新授权 Provider 请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    await refreshedAuthorization.service.onModuleInit();
    assert.equal(
      refreshedCalls.filter((item) => item.url === `${consoleBase}/refresh-token`).length,
      1,
    );
    assert.equal(
      refreshedCalls.filter((item) => item.url.endsWith('/model-providers/deepseek')).length,
      1,
      '刷新 Console 授权后仍必须继续同步模型 Provider',
    );
    const refreshedConnection = refreshedAuthorization.stored.find(
      (item) => item.name === 'default',
    );
    assert.equal(
      (refreshedAuthorization.service as any).decrypt(
        refreshedConnection.encryptedConsoleToken,
      ),
      'refreshed-restart-token',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testDifyExplicitTokenRecoversBrokenStoredAuthorizationSafely() {
  const originalFetch = global.fetch;
  const consoleBase = 'http://dify-explicit-token.test/console/api';
  const replacementToken = 'explicit-configured-replacement-token';
  const llmApiKey = 'sk-explicit-token-provider-sync';
  const config = {
    DIFY_AUTO_BOOTSTRAP: 'true',
    DIFY_AUTO_BOOTSTRAP_ATTEMPTS: '1',
    DIFY_AUTO_BOOTSTRAP_RETRY_MS: '0',
    DIFY_CONSOLE_BASE: consoleBase,
    DIFY_CONSOLE_TOKEN: replacementToken,
    DIFY_ADMIN_EMAIL: 'admin@futureflow.local',
    DIFY_ADMIN_PASSWORD: 'unusable-admin-password-that-is-long-enough',
    DIFY_KEY_ENCRYPTION_SECRET: 'explicit-token-recovery-secret-1234567890',
    DIFY_SYNC_LLM_PROVIDER: 'true',
    LLM_DEFAULT_MODEL: 'deepseek-chat',
    LLM_API_HOST: 'https://api.deepseek.com',
    LLM_API_KEY: llmApiKey,
  };
  const seedConnection = (
    harness: ReturnType<typeof createDifyIntegrationHarness>,
    base: string,
    encryptedAccessToken: string,
    encryptedRefreshToken: string,
  ) => {
    harness.stored.push({
      id: 'default-integration',
      name: 'default',
      workflowId: null,
      workflowVersion: null,
      appId: null,
      consoleBase: base,
      encryptedApiKey: null,
      encryptedConsoleToken: encryptedAccessToken,
      encryptedConsoleRefreshToken: encryptedRefreshToken,
      keyFingerprint: null,
      status: 'reauthorization_required',
      lastRotatedAt: null,
      lastConsoleAuthorizedAt: new Date(0),
    });
  };

  try {
    const expired = createDifyIntegrationHarness(config);
    seedConnection(
      expired,
      consoleBase,
      (expired.service as any).encrypt('expired-stored-access-token'),
      (expired.service as any).encrypt('expired-stored-refresh-token'),
    );
    const expiredCalls: Array<{
      url: string;
      method: string;
      authorization: string;
      body: any;
    }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      expiredCalls.push(request);
      if (request.url === `${consoleBase}/apps` && request.method === 'GET') {
        if (request.authorization === 'Bearer expired-stored-access-token') {
          return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
        }
        assert.equal(request.authorization, `Bearer ${replacementToken}`);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (request.url === `${consoleBase}/refresh-token` && request.method === 'POST') {
        return new Response(JSON.stringify({ message: 'refresh expired' }), { status: 401 });
      }
      if (request.url === `${consoleBase}/login` && request.method === 'POST') {
        return new Response(JSON.stringify({ message: 'admin login rejected' }), { status: 401 });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers?model_type=llm`
        && request.method === 'GET'
      ) {
        assert.equal(request.authorization, `Bearer ${replacementToken}`);
        return new Response(JSON.stringify({
          data: [{ provider: 'deepseek', custom_configuration: { status: 'not_configured' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/workspaces/current/model-providers/deepseek`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${replacementToken}`);
        assert.equal(request.body.credentials.api_key, llmApiKey);
        return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      }
      assert.fail(`未预期的显式 Token 恢复请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    await expired.service.onModuleInit();
    const recovered = expired.stored.find((item) => item.name === 'default');
    assert.equal((expired.service as any).decrypt(recovered.encryptedConsoleToken), replacementToken);
    assert.equal(recovered.encryptedConsoleRefreshToken, null, '显式 Token 接管后不得保留失效 refresh token');
    assert.equal(recovered.status, 'active');
    assert.equal(
      expiredCalls.filter((item) => item.url === `${consoleBase}/refresh-token`).length,
      1,
    );
    assert.equal(
      expiredCalls.filter((item) => item.url === `${consoleBase}/login`).length,
      1,
    );
    assert.equal(
      expiredCalls.filter((item) => item.url.endsWith('/model-providers/deepseek')).length,
      1,
      '替换 Token 验证成功后仍必须同步模型 Provider',
    );
    assert.doesNotMatch(JSON.stringify(expired.stored), new RegExp(replacementToken));

    const damaged = createDifyIntegrationHarness({
      ...config,
      DIFY_SYNC_LLM_PROVIDER: 'false',
    });
    seedConnection(damaged, consoleBase, 'v1:damaged-access', 'v1:damaged-refresh');
    const damagedCalls: Array<{ url: string; method: string; authorization: string }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      damagedCalls.push(request);
      if (request.url === `${consoleBase}/login`) {
        return new Response(JSON.stringify({ message: 'admin login rejected' }), { status: 401 });
      }
      if (request.url === `${consoleBase}/apps` && request.method === 'GET') {
        assert.equal(request.authorization, `Bearer ${replacementToken}`);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      assert.fail(`未预期的损坏密文恢复请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    await damaged.service.onModuleInit();
    const repaired = damaged.stored.find((item) => item.name === 'default');
    assert.equal((damaged.service as any).decrypt(repaired.encryptedConsoleToken), replacementToken);
    assert.equal(repaired.encryptedConsoleRefreshToken, null);
    assert.equal(
      damagedCalls.some((item) => item.url.endsWith('/refresh-token')),
      false,
      '损坏的 refresh token 密文不得被发送到 Dify',
    );

    const oldBase = 'http://old-dify-control-plane.test/console/api';
    const crossPlane = createDifyIntegrationHarness({
      ...config,
      DIFY_SYNC_LLM_PROVIDER: 'false',
    });
    seedConnection(
      crossPlane,
      oldBase,
      (crossPlane.service as any).encrypt('expired-other-plane-token'),
      (crossPlane.service as any).encrypt('expired-other-plane-refresh'),
    );
    const crossPlaneCalls: Array<{ url: string; authorization: string }> = [];
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      crossPlaneCalls.push(request);
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
    }) as typeof global.fetch;

    await assert.rejects(
      () => crossPlane.service.onModuleInit(),
      /不能跨控制面自动覆盖/,
      '显式 Token 不得覆盖不同 Console 地址的已有授权',
    );
    assert.equal(
      crossPlaneCalls.some((item) => item.authorization === `Bearer ${replacementToken}`),
      false,
      '地址不一致时不得把替换 Token 发送给任一控制面',
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testDifyCreateAppAuthorizationRecoveryRetriesWholeProvisioningOnce() {
  const originalFetch = global.fetch;
  const consoleBase = 'http://dify-recovery.test/console/api';
  const expiredToken = 'expired-console-access-token';
  const renewedToken = 'renewed-console-access-token';
  const renewedRefreshToken = 'renewed-console-refresh-token';
  const harness = createDifyIntegrationHarness({
    DIFY_AUTO_BOOTSTRAP: 'false',
    DIFY_CONSOLE_BASE: consoleBase,
    DIFY_KEY_ENCRYPTION_SECRET: 'provisioning-recovery-encryption-secret-12345',
  });
  harness.stored.push({
    id: 'default-integration',
    name: 'default',
    workflowId: null,
    workflowVersion: null,
    appId: null,
    consoleBase,
    encryptedApiKey: null,
    encryptedConsoleToken: (harness.service as any).encrypt(expiredToken),
    encryptedConsoleRefreshToken: (harness.service as any).encrypt('initial-refresh-token'),
    keyFingerprint: null,
    status: 'active',
    lastRotatedAt: null,
    lastConsoleAuthorizedAt: new Date(),
  });
  const requests: Array<{ url: string; method: string; authorization: string }> = [];
  try {
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      requests.push(request);
      if (request.url === `${consoleBase}/refresh-token` && request.method === 'POST') {
        return new Response(JSON.stringify({
          result: 'success',
          data: { access_token: renewedToken, refresh_token: renewedRefreshToken },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (request.url === `${consoleBase}/apps` && request.method === 'POST') {
        if (request.authorization === `Bearer ${expiredToken}`) {
          return new Response(JSON.stringify({ message: 'token expired' }), { status: 401 });
        }
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({ id: 'recovered-workflow-app' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        request.url === `${consoleBase}/apps/recovered-workflow-app/api-keys`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({
          id: 'recovered-service-key-id',
          token: 'app-RECOVERED0123456789abcdef',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (request.url === `${consoleBase}/apps/imports` && request.method === 'POST') {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({ status: 'completed', app_id: 'recovered-workflow-app' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        request.url === `${consoleBase}/apps/recovered-workflow-app/workflows/publish`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      }
      assert.fail(`未预期的授权恢复请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    const consoleService = new DifyConsoleService(
      harness.config as any,
      { toDifyDSLYaml: () => 'version: 0.1.5\nkind: app\napp:\n  mode: workflow' } as any,
      harness.service,
    );
    const result = await consoleService.syncPublishedWorkflow({
      workflowId: '33333333-3333-4333-8333-333333333333',
      workflowVersion: 1,
      workflowName: '401 recovery workflow',
      flowgram: { nodes: [], edges: [] },
    });
    assert.equal(result.status, 'synced');
    assert.equal(result.appId, 'recovered-workflow-app');
    const appCreates = requests.filter(
      (item) => item.url === `${consoleBase}/apps` && item.method === 'POST',
    );
    assert.deepEqual(
      appCreates.map((item) => item.authorization),
      [`Bearer ${expiredToken}`, `Bearer ${renewedToken}`],
      '创建应用阶段的 401 必须刷新后仅重试一次完整 provisioning',
    );
    assert.equal(
      requests.filter((item) => item.url.includes('/api-keys') && item.method === 'POST').length,
      1,
      '被拒绝的首次尝试不得提前创建执行 Key',
    );
    const connection = harness.stored.find((item) => item.name === 'default');
    assert.equal((harness.service as any).decrypt(connection.encryptedConsoleToken), renewedToken);
    assert.equal(
      (harness.service as any).decrypt(connection.encryptedConsoleRefreshToken),
      renewedRefreshToken,
    );
    const binding = harness.stored.find((item) => item.workflowId === '33333333-3333-4333-8333-333333333333');
    assert.equal(binding.status, 'active');
    assert.match(binding.encryptedApiKey, /^v1:/);
    assert.doesNotMatch(JSON.stringify(harness.stored), /app-RECOVERED0123456789abcdef/);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testDifyApiKeyAuthorizationRecoveryCleansPartialAppBeforeRetry() {
  const originalFetch = global.fetch;
  const consoleBase = 'http://dify-key-recovery.test/console/api';
  const expiredToken = 'expired-key-stage-console-token';
  const renewedToken = 'renewed-key-stage-console-token';
  const harness = createDifyIntegrationHarness({
    DIFY_AUTO_BOOTSTRAP: 'false',
    DIFY_CONSOLE_BASE: consoleBase,
    DIFY_KEY_ENCRYPTION_SECRET: 'key-stage-recovery-encryption-secret-123456',
  });
  harness.stored.push({
    id: 'default-integration',
    name: 'default',
    workflowId: null,
    workflowVersion: null,
    appId: null,
    consoleBase,
    encryptedApiKey: null,
    encryptedConsoleToken: (harness.service as any).encrypt(expiredToken),
    encryptedConsoleRefreshToken: (harness.service as any).encrypt('key-stage-refresh-token'),
    keyFingerprint: null,
    status: 'active',
    lastRotatedAt: null,
    lastConsoleAuthorizedAt: new Date(),
  });
  const requests: Array<{ url: string; method: string; authorization: string }> = [];
  let appCreateCount = 0;
  try {
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      requests.push(request);

      if (request.url === `${consoleBase}/apps` && request.method === 'POST') {
        appCreateCount += 1;
        if (appCreateCount === 1) {
          assert.equal(request.authorization, `Bearer ${expiredToken}`);
          return new Response(JSON.stringify({ id: 'partial-key-stage-app' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        assert.equal(appCreateCount, 2, '完整 provisioning 最多只能重试一次');
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({ id: 'replacement-key-stage-app' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (
        request.url === `${consoleBase}/apps/partial-key-stage-app/api-keys`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${expiredToken}`);
        return new Response(JSON.stringify({ message: 'token expired' }), { status: 401 });
      }
      if (
        request.url === `${consoleBase}/apps/partial-key-stage-app`
        && request.method === 'DELETE'
      ) {
        if (request.authorization === `Bearer ${expiredToken}`) {
          return new Response(JSON.stringify({ message: 'token expired' }), { status: 401 });
        }
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(null, { status: 204 });
      }
      if (request.url === `${consoleBase}/refresh-token` && request.method === 'POST') {
        return new Response(JSON.stringify({
          result: 'success',
          data: {
            access_token: renewedToken,
            refresh_token: 'renewed-key-stage-refresh-token',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/apps/replacement-key-stage-app/api-keys`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({
          id: 'replacement-key-stage-key-id',
          token: 'app-KEYSTAGERECOVERY0123456789',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (request.url === `${consoleBase}/apps/imports` && request.method === 'POST') {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({
          status: 'completed',
          app_id: 'replacement-key-stage-app',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (
        request.url === `${consoleBase}/apps/replacement-key-stage-app/workflows/publish`
        && request.method === 'POST'
      ) {
        assert.equal(request.authorization, `Bearer ${renewedToken}`);
        return new Response(JSON.stringify({ result: 'success' }), { status: 200 });
      }
      assert.fail(`未预期的 Key 阶段授权恢复请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    const consoleService = new DifyConsoleService(
      harness.config as any,
      { toDifyDSLYaml: () => 'version: 0.1.5\nkind: app\napp:\n  mode: workflow' } as any,
      harness.service,
    );
    const result = await consoleService.syncPublishedWorkflow({
      workflowId: '44444444-4444-4444-8444-444444444444',
      workflowVersion: 1,
      workflowName: 'API key 401 recovery workflow',
      flowgram: { nodes: [], edges: [] },
    });

    assert.equal(result.status, 'synced');
    assert.equal(result.appId, 'replacement-key-stage-app');
    assert.equal(appCreateCount, 2, 'Key 阶段 401 后应且仅应重试一次完整 provisioning');
    assert.equal(
      requests.filter((item) => item.url === `${consoleBase}/refresh-token`).length,
      1,
      '补偿清理刷新授权后，外层重试必须复用同一新 Token',
    );
    const partialDeletes = requests.filter(
      (item) => item.url === `${consoleBase}/apps/partial-key-stage-app`
        && item.method === 'DELETE',
    );
    assert.deepEqual(
      partialDeletes.map((item) => item.authorization),
      [`Bearer ${expiredToken}`, `Bearer ${renewedToken}`],
      '临时应用必须在刷新授权后完成补偿删除',
    );
    const renewedDeleteIndex = requests.findIndex(
      (item) => item.url === `${consoleBase}/apps/partial-key-stage-app`
        && item.method === 'DELETE'
        && item.authorization === `Bearer ${renewedToken}`,
    );
    const replacementCreateIndex = requests.findIndex(
      (item, index) => index > 0
        && item.url === `${consoleBase}/apps`
        && item.method === 'POST'
        && item.authorization === `Bearer ${renewedToken}`,
    );
    assert.ok(
      renewedDeleteIndex >= 0 && renewedDeleteIndex < replacementCreateIndex,
      '必须先删除首次尝试的临时应用，再创建替代应用',
    );
    const binding = harness.stored.find(
      (item) => item.workflowId === '44444444-4444-4444-8444-444444444444',
    );
    assert.equal(binding.appId, 'replacement-key-stage-app');
    assert.equal(binding.status, 'active');
    assert.match(binding.encryptedApiKey, /^v1:/);
    assert.doesNotMatch(JSON.stringify(harness.stored), /app-KEYSTAGERECOVERY0123456789/);
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
  assert.equal(permissions.checkNodePermissions('free', ['variable']).allowed, true);
  assert.equal(permissions.checkNodePermissions('free', ['loop']).allowed, false);
  assert.equal(permissions.checkNodePermissions('pro', ['loop']).allowed, true);
  assert.equal(permissions.checkNodePermissions('enterprise', ['loop']).allowed, true);
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
  for (const privateUrl of [
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/internal',
    'http://[::1]/health',
    'http://metadata.google.internal/',
  ]) {
    assert.throws(
      () => converter.validateFlowGram({
        nodes: [
          { id: 'private_start', type: 'start', data: { title: '开始' } },
          {
            id: 'private_http',
            type: 'http',
            data: {
              title: 'API 请求',
              api: { method: 'GET', url: { type: 'constant', content: privateUrl } },
            },
          },
          { id: 'private_end', type: 'end', data: { title: '结束' } },
        ],
        edges: [
          { sourceNodeID: 'private_start', targetNodeID: 'private_http' },
          { sourceNodeID: 'private_http', targetNodeID: 'private_end' },
        ],
      }),
      /不能访问本机、私网或云元数据地址/,
    );
  }

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
        {
          id: 'http',
          type: 'http',
          data: {
            title: 'API 请求',
            api: {
              method: 'GET',
              url: { type: 'constant', content: 'https://example.test' },
            },
          },
        },
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
      {
        id: 'start',
        type: 'start',
        data: {
          title: '开始',
          outputs: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
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

  refunds = 0;
  settlements = 0;
  updates.length = 0;
  const cancelledConsumerService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream() {
        yield { event: 'workflow_started', workflow_run_id: 'run-cancelled', task_id: 'task-cancelled' };
        yield {
          event: 'workflow_finished',
          workflow_run_id: 'run-cancelled',
          task_id: 'task-cancelled',
          data: { status: 'succeeded', total_tokens: 1, total_steps: 1, elapsed_time: 0.1 },
        };
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined } as any,
  );
  const cancelledStream = cancelledConsumerService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1 },
  );
  await cancelledStream.next();
  await cancelledStream.return(undefined);
  assert.equal(refunds, 1, '消费者提前 return 后必须解冻退款');
  assert.equal(settlements, 0, '消费者提前 return 后不得结算成功费用');
  assert.equal(updates.some((update) => update.status === 'cancelled'), true);

  refunds = 0;
  settlements = 0;
  updates.length = 0;
  let receivedAbortSignal: AbortSignal | undefined;
  const silentUpstreamService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream(
        _inputs: unknown,
        _user: unknown,
        _target: unknown,
        _sensitiveValues: unknown,
        abortSignal?: AbortSignal,
      ) {
        receivedAbortSignal = abortSignal;
        await new Promise<void>((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new Error('upstream reader aborted'));
            return;
          }
          abortSignal?.addEventListener('abort', () => reject(new Error('upstream reader aborted')), { once: true });
        });
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined } as any,
  );
  const upstreamAbortController = new AbortController();
  const silentStream = silentUpstreamService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1, abortSignal: upstreamAbortController.signal },
  );
  const pendingRead = silentStream.next();
  await Promise.resolve();
  upstreamAbortController.abort();
  const abortedRead = await pendingRead;
  assert.equal(receivedAbortSignal, upstreamAbortController.signal, '断连信号必须传递到 Dify 流');
  assert.equal(abortedRead.done, true, '静默上游读取应被断连信号立即打断');
  assert.equal(refunds, 1, '静默上游被断连中止后必须解冻退款');
  assert.equal(settlements, 0);
  assert.equal(updates.some((update) => update.status === 'cancelled'), true);

  refunds = 0;
  settlements = 0;
  updates.length = 0;
  const boundedService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream() {
        yield { event: 'workflow_started', workflow_run_id: 'run-bounded', task_id: 'task-bounded' };
        yield { event: 'node_started', data: { node_id: 'one' } };
        yield { event: 'node_started', data: { node_id: 'two' } };
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined } as any,
  );
  (boundedService as any).maxExecutionEvents = 2;
  const boundedEvents: any[] = [];
  for await (const event of boundedService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1 },
  )) {
    boundedEvents.push(event);
  }
  assert.equal(
    boundedEvents.some((event) => event.event === 'error' && /安全限制/.test(event.data?.message || '')),
    true,
    '超过总事件数限制必须转换为安全失败事件',
  );
  assert.equal(refunds, 1, '超过总事件数限制后必须解冻退款');
  assert.equal(settlements, 0);

  refunds = 0;
  settlements = 0;
  updates.length = 0;
  const successfulService = new WorkflowsService(
    runRepo as any,
    converter,
    {
      isConfigured: async () => true,
      async *runWorkflowStream() {
        yield { event: 'workflow_started', workflow_run_id: 'run-success', task_id: 'task-success' };
        yield {
          event: 'workflow_finished',
          workflow_run_id: 'run-success',
          task_id: 'task-success',
          data: { status: 'succeeded', total_tokens: 1, total_steps: 1, elapsed_time: 0.1 },
        };
      },
    } as any,
    billing as any,
    new PermissionChecker(),
    { reserve: async () => undefined } as any,
  );
  for await (const _event of successfulService.runWorkflow(
    flowgram,
    { id: 'user-1', username: 'tester', vipLevel: 'pro' } as any,
    {},
    'workflow-1',
    { workflowVersion: 1 },
  )) {
    // Exhaust the stream to reach the successful finalization branch.
  }
  assert.equal(refunds, 0);
  assert.equal(settlements, 1, '正常成功流必须且只能结算一次');
  assert.equal(updates.filter((update) => update.status === 'succeeded').length, 1);
}



async function testConditionBranchConversionAndDirectExecution() {
  const converter = new DifyConverterService();
  const flowgram = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: {
          title: '开始',
          outputs: { type: 'object', properties: { approved: { type: 'integer', default: 1 } } },
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
              right: { type: 'constant', content: 1 },
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

  const mergedBranchDsl = converter.toDifyDSL({
    nodes: [
      flowgram.nodes[0],
      flowgram.nodes[1],
      {
        id: 'shared_text',
        type: 'text',
        data: {
          title: '共用结果',
          inputsValues: { text: { type: 'constant', content: '完成' } },
        },
      },
      { id: 'shared_end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'condition' },
      { sourceNodeID: 'condition', targetNodeID: 'shared_text', sourcePortID: 'approved' },
      { sourceNodeID: 'condition', targetNodeID: 'shared_text', sourcePortID: 'else' },
      { sourceNodeID: 'shared_text', targetNodeID: 'shared_end' },
    ],
  } as any);
  const mergedBranchEdgeIds = mergedBranchDsl.workflow.graph.edges
    .filter((edge) => edge.source === 'condition')
    .map((edge) => edge.id);
  assert.equal(mergedBranchEdgeIds.length, 2);
  assert.equal(new Set(mergedBranchEdgeIds).size, 2, '不同条件端口的边必须具有唯一 ID');

  for (const reservedKey of ['else', 'false']) {
    const reservedCaseFlow = structuredClone(flowgram);
    reservedCaseFlow.nodes.find((node) => node.id === 'condition').data.conditions[0].key = reservedKey;
    assert.throws(
      () => converter.toDifyDSL(reservedCaseFlow),
      new RegExp(`分支不能使用保留端口 ${reservedKey}`),
    );
  }

  const duplicateCaseFlow = structuredClone(flowgram);
  duplicateCaseFlow.nodes.find((node) => node.id === 'condition').data.conditions.push(
    structuredClone(duplicateCaseFlow.nodes.find((node) => node.id === 'condition').data.conditions[0]),
  );
  assert.throws(
    () => converter.toDifyDSL(duplicateCaseFlow),
    /包含重复的分支 key: approved/,
  );
}

async function testDify015NodeSchemas() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: {
          title: '开始',
          outputs: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
      {
        id: 'http',
        type: 'http',
        data: {
          title: 'API 请求',
          api: {
            method: 'POST',
            url: { type: 'template', content: 'https://example.test/{{start.query}}' },
          },
          authorization: {
            type: 'bearer',
            token: { type: 'constant', content: 'secret-token' },
          },
          headersValues: {
            'X-Test': { type: 'constant', content: 'futureflow' },
          },
          paramsValues: {
            page: { type: 'constant', content: 1 },
          },
          body: {
            bodyType: 'JSON',
            json: { type: 'template', content: '{"ok":true}' },
          },
          timeout: { timeout: 12000, retryTimes: 2 },
        },
      },
      {
        id: 'code',
        type: 'code',
        data: {
          title: '代码执行',
          inputsValues: {
            input: { type: 'ref', content: ['http', 'body'] },
            statusCode: { type: 'ref', content: ['http', 'statusCode'] },
          },
          script: {
            language: 'javascript',
            content: 'function main({ params }) { return { score: String(params.input).length }; }',
          },
          outputs: { type: 'object', properties: { score: { type: 'number' } } },
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
  assert.deepEqual(http?.authorization, {
    type: 'api-key',
    config: {
      type: 'bearer',
      api_key: 'secret-token',
      header: 'Authorization',
    },
  });
  assert.deepEqual(http?.body, {
    type: 'json',
    data: [{ key: '', type: 'text', value: '{"ok":true}' }],
  });
  assert.equal(http?.url, 'https://example.test/{{#start.query#}}');
  assert.match(http?.headers, /X-Test:\s+futureflow/);
  assert.doesNotMatch(http?.headers, /Authorization|secret-token/);
  assert.equal(http?.params, 'page:1');
  assert.deepEqual(http?.timeout, { connect: 12, read: 12, write: 12 });
  assert.deepEqual(http?.retry_config, {
    retry_enabled: true,
    max_retries: 2,
    retry_interval: 100,
  });
  const code = dsl.workflow.graph.nodes.find((node) => node.id === 'code')?.data;
  assert.equal(code?.code_language, 'javascript');
  assert.deepEqual(code?.variables, [
    { variable: '__ff_input_0', value_selector: ['http', 'body'] },
    { variable: '__ff_statusCode_1', value_selector: ['http', 'status_code'] },
  ]);
  assert.match(code?.code, /function __futureFlowUserMain/);
  assert.deepEqual(
    code?.outputs,
    { score: { type: 'number', children: null } },
  );
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.source === 'http')?.data.sourceType,
    'http-request',
  );
  assert.deepEqual(
    dsl.workflow.graph.nodes.find((node) => node.id === 'end')?.data.outputs,
    [{ variable: 'result', value_selector: ['code', 'score'] }],
  );

  const httpStatusDsl = converter.toDifyDSL({
    nodes: [
      { id: 'status_start', type: 'start', data: { title: '开始' } },
      {
        id: 'status_http',
        type: 'http',
        data: {
          title: '状态检查',
          api: {
            method: 'GET',
            url: { type: 'constant', content: 'https://example.test/status' },
          },
          body: {
            bodyType: 'JSON',
            json: { type: 'constant', content: '{"must":"be ignored"}' },
          },
        },
      },
      {
        id: 'status_end',
        type: 'end',
        data: {
          title: '结束',
          outputs: { type: 'object', properties: { statusCode: { type: 'integer' } } },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'status_start', targetNodeID: 'status_http' },
      { sourceNodeID: 'status_http', targetNodeID: 'status_end' },
    ],
  } as any);
  assert.deepEqual(
    httpStatusDsl.workflow.graph.nodes.find((node) => node.id === 'status_end')?.data.outputs,
    [{ variable: 'statusCode', value_selector: ['status_http', 'status_code'] }],
  );
  assert.deepEqual(
    httpStatusDsl.workflow.graph.nodes.find((node) => node.id === 'status_http')?.data.body,
    { type: 'none', data: [] },
    'GET 发布 DSL 不得携带请求体',
  );
}

async function testDifyRealCanvasSelectorsAndSchemas() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      {
        id: 'start_0',
        type: 'start',
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              apiToken: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'llm_0',
        type: 'llm',
        data: {
          title: '大语言模型',
          inputsValues: {
            modelName: { type: 'constant', content: 'deepseek-chat' },
            prompt: { type: 'template', content: '{{#start_0.query#}}' },
          },
          outputs: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
        },
      },
      {
        id: 'http_get',
        type: 'http',
        data: {
          title: 'GET API',
          api: {
            method: 'GET',
            url: { type: 'constant', content: 'https://example.test/get' },
          },
          authorization: {
            type: 'bearer',
            token: { type: 'ref', content: ['start_0', 'apiToken'] },
          },
          body: {
            bodyType: 'JSON',
            json: { type: 'constant', content: '{"ignored":true}' },
          },
          outputs: {
            type: 'object',
            properties: {
              body: { type: 'string' },
              headers: { type: 'object' },
              statusCode: { type: 'integer' },
            },
          },
        },
      },
      {
        id: 'code_0',
        type: 'code',
        data: {
          title: '代码执行',
          inputsValues: {
            answer: { type: 'ref', content: ['llm_0', 'result'] },
            status: { type: 'ref', content: ['http_get', 'statusCode'] },
            headers: { type: 'ref', content: ['http_get', 'headers'] },
          },
          script: {
            language: 'javascript',
            content: `function main({ params }) {
  return {
    tags: [String(params.answer)],
    flags: [true, false],
    enabled: true,
    count: 1,
    ratio: 0.5,
    meta: { title: 'ok', valid: true }
  };
}`,
          },
          outputs: {
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' } },
              flags: { type: 'array', items: { type: 'boolean' } },
              enabled: { type: 'boolean' },
              count: { type: 'integer' },
              ratio: { type: 'number' },
              meta: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  valid: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      {
        id: 'image_0',
        type: 'image',
        data: {
          title: '图片处理',
          inputsValues: {
            url: { type: 'constant', content: 'https://example.test/image.png' },
            caption: { type: 'ref', content: ['llm_0', 'result'] },
          },
          outputs: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              caption: { type: 'string' },
              mediaType: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'video_0',
        type: 'video',
        data: {
          title: '视频处理',
          inputsValues: {
            url: { type: 'constant', content: 'https://example.test/video.mp4' },
            poster: { type: 'ref', content: ['image_0', 'url'] },
            caption: { type: 'ref', content: ['image_0', 'caption'] },
          },
          outputs: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              poster: { type: 'string' },
              caption: { type: 'string' },
              mediaType: { type: 'string' },
            },
          },
        },
      },
      {
        id: 'http_head',
        type: 'http',
        data: {
          title: 'HEAD API',
          api: {
            method: 'HEAD',
            url: { type: 'constant', content: 'https://example.test/head' },
          },
          body: {
            bodyType: 'raw-text',
            rawText: { type: 'constant', content: 'must be ignored' },
          },
          outputs: {
            type: 'object',
            properties: { statusCode: { type: 'integer' } },
          },
        },
      },
      {
        id: 'end_0',
        type: 'end',
        data: {
          title: '结束',
          inputsValues: {
            answer: { type: 'ref', content: ['llm_0', 'result'] },
            headers: { type: 'ref', content: ['http_get', 'headers'] },
            status: { type: 'ref', content: ['http_get', 'statusCode'] },
            tags: { type: 'ref', content: ['code_0', 'tags'] },
            enabled: { type: 'ref', content: ['code_0', 'enabled'] },
            count: { type: 'ref', content: ['code_0', 'count'] },
            meta: { type: 'ref', content: ['code_0', 'meta'] },
            imageCaption: { type: 'ref', content: ['image_0', 'caption'] },
            videoPoster: { type: 'ref', content: ['video_0', 'poster'] },
            headStatus: { type: 'ref', content: ['http_head', 'statusCode'] },
          },
          inputs: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
      { sourceNodeID: 'llm_0', targetNodeID: 'http_get' },
      { sourceNodeID: 'http_get', targetNodeID: 'code_0' },
      { sourceNodeID: 'code_0', targetNodeID: 'image_0' },
      { sourceNodeID: 'image_0', targetNodeID: 'video_0' },
      { sourceNodeID: 'video_0', targetNodeID: 'http_head' },
      { sourceNodeID: 'http_head', targetNodeID: 'end_0' },
    ],
  } as any);

  const nodeData = (id: string) =>
    dsl.workflow.graph.nodes.find((node) => node.id === id)?.data;
  assert.equal(nodeData('llm_0')?.prompt_template[0].text, '{{#start_0.query#}}');
  assert.deepEqual(nodeData('http_get')?.body, { type: 'none', data: [] });
  assert.deepEqual(nodeData('http_get')?.authorization, {
    type: 'api-key',
    config: {
      type: 'bearer',
      api_key: '{{#start_0.apiToken#}}',
      header: 'Authorization',
    },
  });
  assert.doesNotMatch(nodeData('http_get')?.headers, /Authorization|apiToken/);
  assert.deepEqual(nodeData('code_0')?.variables, [
    { variable: '__ff_answer_0', value_selector: ['llm_0', 'text'] },
    { variable: '__ff_status_1', value_selector: ['http_get', 'status_code'] },
    { variable: '__ff_headers_2', value_selector: ['http_get', 'headers'] },
  ]);
  assert.deepEqual(nodeData('code_0')?.outputs, {
    tags: { type: 'array[string]', children: null },
    flags: { type: 'array[number]', children: null },
    enabled: { type: 'number', children: null },
    count: { type: 'number', children: null },
    ratio: { type: 'number', children: null },
    meta: {
      type: 'object',
      children: {
        title: { type: 'string', children: null },
        valid: { type: 'number', children: null },
      },
    },
  });
  assert.deepEqual(nodeData('image_0')?.variables, [
    { variable: '__ff_caption_0', value_selector: ['llm_0', 'text'] },
  ]);
  assert.deepEqual(nodeData('video_0')?.variables, [
    { variable: '__ff_poster_0', value_selector: ['image_0', 'url'] },
    { variable: '__ff_caption_1', value_selector: ['image_0', 'caption'] },
  ]);
  assert.deepEqual(nodeData('http_head')?.body, { type: 'none', data: [] });
  assert.deepEqual(nodeData('end_0')?.outputs, [
    { variable: 'answer', value_selector: ['llm_0', 'text'] },
    { variable: 'headers', value_selector: ['http_get', 'headers'] },
    { variable: 'status', value_selector: ['http_get', 'status_code'] },
    { variable: 'tags', value_selector: ['code_0', 'tags'] },
    { variable: 'enabled', value_selector: ['code_0', 'enabled'] },
    { variable: 'count', value_selector: ['code_0', 'count'] },
    { variable: 'meta', value_selector: ['code_0', 'meta'] },
    { variable: 'imageCaption', value_selector: ['image_0', 'caption'] },
    { variable: 'videoPoster', value_selector: ['video_0', 'poster'] },
    { variable: 'headStatus', value_selector: ['http_head', 'status_code'] },
  ]);

  const autoEndDsl = converter.toDifyDSL({
    nodes: [
      { id: 'auto_start', type: 'start', data: { title: '开始' } },
      {
        id: 'auto_code',
        type: 'code',
        data: {
          title: '多输出代码',
          script: {
            language: 'javascript',
            content: 'function main({ params }) { return { first: 1, second: true }; }',
          },
          outputs: {
            type: 'object',
            properties: {
              first: { type: 'number' },
              second: { type: 'boolean' },
            },
          },
        },
      },
    ],
    edges: [{ sourceNodeID: 'auto_start', targetNodeID: 'auto_code' }],
  } as any);
  assert.deepEqual(
    autoEndDsl.workflow.graph.nodes.find((node) => node.id === 'end_auto')?.data.outputs,
    [
      { variable: 'first', value_selector: ['auto_code', 'first'] },
      { variable: 'second', value_selector: ['auto_code', 'second'] },
    ],
    '自动 End 必须完整暴露多输出代码节点',
  );

  assert.throws(
    () => converter.toDifyDSL({
      nodes: [
        {
          id: 'global_start',
          type: 'start',
          data: { title: '开始', outputs: { type: 'object', properties: { token: { type: 'string' } } } },
        },
        {
          id: 'global_http',
          type: 'http',
          data: {
            title: 'API',
            api: { method: 'GET', url: { type: 'constant', content: 'https://example.test' } },
            authorization: {
              type: 'bearer',
              token: { type: 'ref', content: ['global', 'apiToken'] },
            },
          },
        },
      ],
      edges: [{ sourceNodeID: 'global_start', targetNodeID: 'global_http' }],
    } as any),
    /不支持 global 全局变量引用/,
  );
}

async function testHttpPublishValidation() {
  const converter = new DifyConverterService();
  const convert = (data: Record<string, any>) => converter.toDifyDSL({
    nodes: [
      {
        id: 'http_validation_start',
        type: 'start',
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: { token: { type: 'string' } },
          },
        },
      },
      {
        id: 'http_validation',
        type: 'http',
        data: {
          title: 'API 请求',
          api: {
            method: 'POST',
            url: { type: 'constant', content: 'https://example.test/validate' },
          },
          authorization: { type: 'none' },
          body: { bodyType: 'none' },
          timeout: { timeout: 30000, retryTimes: 0 },
          ...data,
        },
      },
    ],
    edges: [
      { sourceNodeID: 'http_validation_start', targetNodeID: 'http_validation' },
    ],
  } as any);

  assert.doesNotThrow(() => convert({
    authorization: {
      type: 'bearer',
      token: { type: 'ref', content: ['http_validation_start', 'token'] },
    },
    timeout: { timeout: 1, retryTimes: 0 },
  }));
  assert.doesNotThrow(() => convert({
    authorization: {
      type: 'api-key',
      headerName: { type: 'constant', content: 'X-API-Key' },
      apiKey: { type: 'ref', content: ['http_validation_start', 'token'] },
    },
    timeout: { timeout: 120000, retryTimes: 10 },
  }));
  assert.doesNotThrow(() => convert({
    authorization: {
      type: 'basic',
      username: { type: 'constant', content: 'futureflow' },
      password: { type: 'constant', content: 'private-password' },
    },
  }));
  assert.doesNotThrow(() => convert({
    body: {
      bodyType: 'raw-text',
      json: { type: 'template', content: '正文：{{http_validation_start.token}}' },
    },
  }));
  assert.doesNotThrow(() => convert({
    headersValues: {
      'X-FutureFlow.Trace_ID': { type: 'constant', content: 'ok' },
    },
    paramsValues: {
      'page-size': { type: 'constant', content: 20 },
    },
  }));

  for (const entry of [
    { method: 'GET', body: { bodyType: 'JSON', json: undefined } },
    {
      method: 'HEAD',
      body: { bodyType: 'raw-text', rawText: { type: 'constant', content: '   ' } },
    },
    { method: 'HEAD', body: { bodyType: 'form-data' } },
  ]) {
    const ignoredBodyDsl = convert({
      api: {
        method: entry.method,
        url: { type: 'constant', content: 'https://example.test/ignore-body' },
      },
      body: entry.body,
    });
    assert.deepEqual(
      ignoredBodyDsl.workflow.graph.nodes
        .find((node) => node.id === 'http_validation')?.data.body,
      { type: 'none', data: [] },
      `${entry.method} 必须无条件忽略请求体`,
    );
  }

  for (const token of [undefined, { type: 'constant', content: '   ' }]) {
    assert.throws(
      () => convert({ authorization: { type: 'bearer', token } }),
      /Bearer 令牌不能为空/,
    );
  }

  assert.throws(
    () => convert({
      authorization: {
        type: 'api-key',
        headerName: { type: 'ref', content: ['http_validation_start', 'token'] },
        apiKey: { type: 'constant', content: 'secret' },
      },
    }),
    /API 密钥请求头名称必须使用常量/,
  );
  for (const headerName of ['', ' Bad-Header', 'Bad Header', 'X-Test:Injected']) {
    assert.throws(
      () => convert({
        authorization: {
          type: 'api-key',
          headerName: { type: 'constant', content: headerName },
          apiKey: { type: 'constant', content: 'secret' },
        },
      }),
      /API 密钥请求头名称格式无效/,
    );
  }
  assert.throws(
    () => convert({
      authorization: {
        type: 'api-key',
        headerName: { type: 'constant', content: 'X-API-Key' },
        apiKey: { type: 'template', content: '  ' },
      },
    }),
    /API 密钥不能为空/,
  );

  for (const headerName of [
    '',
    'Bad Header',
    'X-Test:Injected',
    'X-Test\r\nInjected',
  ]) {
    assert.throws(
      () => convert({
        headersValues: {
          [headerName]: { type: 'constant', content: 'value' },
        },
      }),
      /自定义请求头名称不能为空或包含非法字符/,
    );
  }
  for (const paramName of ['', ' ', 'bad key', 'bad\tkey', 'key\r\nInjected']) {
    assert.throws(
      () => convert({
        paramsValues: {
          [paramName]: { type: 'constant', content: 'value' },
        },
      }),
      /查询参数名称不能为空，也不能包含空白或换行符/,
    );
  }

  for (const username of [
    { type: 'constant', content: '' },
    { type: 'ref', content: ['http_validation_start', 'token'] },
  ]) {
    assert.throws(
      () => convert({
        authorization: {
          type: 'basic',
          username,
          password: { type: 'constant', content: 'private-password' },
        },
      }),
      /Basic 用户名必须使用非空常量/,
    );
  }
  for (const password of [
    { type: 'constant', content: '   ' },
    { type: 'ref', content: ['http_validation_start', 'token'] },
  ]) {
    assert.throws(
      () => convert({
        authorization: {
          type: 'basic',
          username: { type: 'constant', content: 'futureflow' },
          password,
        },
      }),
      /Basic 密码必须使用非空常量/,
    );
  }

  for (const timeout of [0, 120001, 1.5, '1000']) {
    assert.throws(
      () => convert({ timeout: { timeout, retryTimes: 0 } }),
      /超时时间必须是 1 到 120000 之间的整数/,
    );
  }
  for (const retryTimes of [-1, 11, 1.5, '1']) {
    assert.throws(
      () => convert({ timeout: { timeout: 30000, retryTimes } }),
      /重试次数必须是 0 到 10 之间的整数/,
    );
  }

  for (const json of [
    undefined,
    { type: 'constant', content: '' },
    { type: 'template', content: '   ' },
  ]) {
    assert.throws(
      () => convert({ body: { bodyType: 'JSON', json } }),
      /选择 JSON 请求体后内容不能为空/,
    );
  }
  assert.throws(
    () => convert({
      body: {
        bodyType: 'raw-text',
        rawText: { type: 'constant', content: '' },
        json: { type: 'constant', content: '不能回退到旧值' },
      },
    }),
    /选择纯文本请求体后内容不能为空/,
  );
  assert.throws(
    () => convert({ body: { bodyType: 'form-data' } }),
    /请求体类型无效/,
  );
  assert.throws(
    () => convert({ authorization: { type: 'oauth2' } }),
    /身份认证类型无效/,
  );
}

async function testDifyCanvasDecorationsAndUnsupportedNodes() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      { id: 'decor_start', type: 'start', data: { title: '开始' } },
      {
        id: 'decor_text',
        type: 'text',
        data: {
          title: '文本',
          inputsValues: { text: { type: 'constant', content: 'ok' } },
        },
      },
      { id: 'decor_end', type: 'end', data: { title: '结束' } },
      { id: 'canvas_comment', type: 'comment', data: { title: '备注' } },
      { id: 'canvas_group', type: 'group', data: { title: '分组' } },
    ],
    edges: [
      { sourceNodeID: 'decor_start', targetNodeID: 'decor_text' },
      { sourceNodeID: 'decor_text', targetNodeID: 'decor_end' },
      { sourceNodeID: 'decor_start', targetNodeID: 'canvas_comment' },
      { sourceNodeID: 'canvas_comment', targetNodeID: 'canvas_group' },
      { sourceNodeID: 'canvas_group', targetNodeID: 'canvas_comment' },
    ],
  } as any);
  assert.deepEqual(
    dsl.workflow.graph.nodes.map((node) => node.id),
    ['decor_start', 'decor_text', 'decor_end'],
  );
  assert.equal(dsl.workflow.graph.edges.length, 2);

  const unsupported = [
    { type: 'break', message: /发布暂不支持 break 节点/ },
    { type: 'continue', message: /发布暂不支持 continue 节点/ },
  ];
  for (const entry of unsupported) {
    assert.throws(
      () => converter.toDifyDSL({
        nodes: [
          { id: `${entry.type}_start`, type: 'start', data: { title: '开始' } },
          { id: `${entry.type}_node`, type: entry.type, data: { title: entry.type } },
          {
            id: `${entry.type}_text`,
            type: 'text',
            data: {
              title: '文本',
              inputsValues: { text: { type: 'constant', content: 'ok' } },
            },
          },
        ],
        edges: [
          { sourceNodeID: `${entry.type}_start`, targetNodeID: `${entry.type}_node` },
          { sourceNodeID: `${entry.type}_node`, targetNodeID: `${entry.type}_text` },
        ],
      } as any),
      entry.message,
    );
  }
}

async function testVariableNodesCompileToDifyCode() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      {
        id: 'variable_start',
        type: 'start',
        data: {
          title: '开始',
          outputs: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              count: { type: 'integer' },
            },
          },
        },
      },
      {
        id: 'variable_declare',
        type: 'variable',
        data: {
          title: '新建变量',
          assign: [
            {
              operator: 'declare',
              left: 'message',
              right: { type: 'template', content: '标题：{{variable_start.query}}' },
            },
            {
              operator: 'declare',
              left: 'total',
              right: { type: 'ref', content: ['variable_start', 'count'] },
            },
          ],
          outputs: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              total: { type: 'integer' },
            },
          },
        },
      },
      {
        id: 'variable_assign',
        type: 'variable',
        data: {
          title: '修改变量',
          assign: [
            {
              operator: 'assign',
              left: { type: 'ref', content: ['variable_declare', 'total'] },
              right: { type: 'constant', content: 42, schema: { type: 'integer' } },
            },
            {
              operator: 'declare',
              left: 'label',
              right: { type: 'ref', content: ['variable_declare', 'message'] },
            },
          ],
          outputs: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      },
      {
        id: 'variable_text',
        type: 'text',
        data: {
          title: '读取变量',
          inputsValues: {
            text: {
              type: 'template',
              content: '{{variable_declare.total}} / {{variable_assign.label}}',
            },
          },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'variable_end',
        type: 'end',
        data: {
          title: '结束',
          inputsValues: {
            total: { type: 'ref', content: ['variable_declare', 'total'] },
            label: { type: 'ref', content: ['variable_assign', 'label'] },
          },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'variable_start', targetNodeID: 'variable_declare' },
      { sourceNodeID: 'variable_declare', targetNodeID: 'variable_assign' },
      { sourceNodeID: 'variable_assign', targetNodeID: 'variable_text' },
      { sourceNodeID: 'variable_text', targetNodeID: 'variable_end' },
    ],
  } as any);

  const nodeData = (id: string) =>
    dsl.workflow.graph.nodes.find((node) => node.id === id)?.data;
  assert.equal(nodeData('variable_declare')?.type, 'code');
  assert.deepEqual(nodeData('variable_declare')?.variables, [
    { variable: '__ff_message_0', value_selector: ['variable_start', 'query'] },
    { variable: '__ff_total_1', value_selector: ['variable_start', 'count'] },
  ]);
  assert.deepEqual(nodeData('variable_declare')?.outputs, {
    message: { type: 'string', children: null },
    total: { type: 'number', children: null },
  });
  assert.equal(nodeData('variable_assign')?.type, 'code');
  assert.deepEqual(nodeData('variable_assign')?.variables, [
    { variable: '__ff_label_0', value_selector: ['variable_declare', 'message'] },
  ]);
  assert.deepEqual(nodeData('variable_assign')?.outputs, {
    assigned_1: { type: 'number', children: null },
    label: { type: 'string', children: null },
  });
  assert.match(nodeData('variable_assign')?.code, /"assigned_1": 42/);
  assert.deepEqual(nodeData('variable_text')?.variables, [
    { variable: '__ff_text_0', value_selector: ['variable_assign', 'assigned_1'] },
    { variable: '__ff_text_1', value_selector: ['variable_assign', 'label'] },
  ]);
  assert.deepEqual(nodeData('variable_end')?.outputs, [
    { variable: 'total', value_selector: ['variable_assign', 'assigned_1'] },
    { variable: 'label', value_selector: ['variable_assign', 'label'] },
  ]);
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.source === 'variable_assign')?.data.sourceType,
    'code',
  );

  const defaultVariableDsl = converter.toDifyDSL({
    nodes: [
      { id: 'default_variable_start', type: 'start', data: { title: '开始' } },
      {
        id: 'default_variable',
        type: 'variable',
        data: {
          title: '默认变量',
          assign: [{
            operator: 'declare',
            left: 'sum',
            right: { type: 'constant', content: 0, schema: { type: 'integer' } },
          }],
        },
      },
      { id: 'default_variable_end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'default_variable_start', targetNodeID: 'default_variable' },
      { sourceNodeID: 'default_variable', targetNodeID: 'default_variable_end' },
    ],
  } as any);
  assert.deepEqual(nodeData.call({
    workflow: defaultVariableDsl.workflow,
  }, 'default_variable'), undefined);
  assert.deepEqual(
    defaultVariableDsl.workflow.graph.nodes.find((node) => node.id === 'default_variable')?.data.outputs,
    { sum: { type: 'number', children: null } },
  );
  assert.deepEqual(
    defaultVariableDsl.workflow.graph.nodes.find((node) => node.id === 'default_variable_end')?.data.outputs,
    [{ variable: 'result', value_selector: ['default_variable', 'sum'] }],
  );

  const defaultAutoEndDsl = converter.toDifyDSL({
    nodes: defaultVariableDsl.workflow.graph.nodes
      .filter((node) => ['default_variable_start', 'default_variable'].includes(node.id))
      .map((node) => ({
        id: node.id,
        type: node.id === 'default_variable_start' ? 'start' : 'variable',
        data: node.id === 'default_variable_start'
          ? { title: '开始' }
          : {
              title: '默认变量',
              assign: [{
                operator: 'declare',
                left: 'sum',
                right: { type: 'constant', content: 0, schema: { type: 'integer' } },
              }],
            },
      })),
    edges: [{ sourceNodeID: 'default_variable_start', targetNodeID: 'default_variable' }],
  } as any);
  assert.deepEqual(
    defaultAutoEndDsl.workflow.graph.nodes.find((node) => node.id === 'end_auto')?.data.outputs,
    [{ variable: 'sum', value_selector: ['default_variable', 'sum'] }],
  );

  const invalidBase = (data: Record<string, any>) => ({
    nodes: [
      {
        id: 'invalid_start',
        type: 'start',
        data: {
          title: '开始',
          outputs: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
      { id: 'invalid_variable', type: 'variable', data: { title: '变量', ...data } },
    ],
    edges: [{ sourceNodeID: 'invalid_start', targetNodeID: 'invalid_variable' }],
  });
  assert.throws(
    () => converter.toDifyDSL(invalidBase({ assign: [] }) as any),
    /至少需要设置一个变量/,
  );
  assert.throws(
    () => converter.toDifyDSL(invalidBase({
      assign: [
        { operator: 'declare', left: 'same', right: { type: 'constant', content: 1 } },
        { operator: 'declare', left: 'same', right: { type: 'constant', content: 2 } },
      ],
    }) as any),
    /重复的变量名称/,
  );
  assert.throws(
    () => converter.toDifyDSL(invalidBase({
      assign: [{
        operator: 'assign',
        left: { type: 'ref', content: ['invalid_start', 'query', 'nested'] },
        right: { type: 'constant', content: 'value' },
      }],
    }) as any),
    /顶层流程变量/,
  );
  assert.throws(
    () => converter.toDifyDSL(invalidBase({
      assign: [{
        operator: 'assign',
        left: { type: 'ref', content: ['invalid_start', 'missing'] },
        right: { type: 'constant', content: 'value' },
      }],
    }) as any),
    /赋值目标 invalid_start\.missing 不存在/,
  );

  assert.throws(
    () => converter.toDifyDSL({
      nodes: [
        {
          id: 'branch_start',
          type: 'start',
          data: {
            title: '开始',
            outputs: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
        {
          id: 'branch_assign',
          type: 'variable',
          data: {
            title: '分支赋值',
            assign: [{
              operator: 'assign',
              left: { type: 'ref', content: ['branch_start', 'query'] },
              right: { type: 'constant', content: 'changed' },
            }],
          },
        },
        {
          id: 'branch_text',
          type: 'text',
          data: {
            title: '汇合读取',
            inputsValues: { text: { type: 'ref', content: ['branch_start', 'query'] } },
          },
        },
      ],
      edges: [
        { sourceNodeID: 'branch_start', targetNodeID: 'branch_assign' },
        { sourceNodeID: 'branch_start', targetNodeID: 'branch_text' },
        { sourceNodeID: 'branch_assign', targetNodeID: 'branch_text' },
      ],
    } as any),
    /分支汇合处的赋值不明确/,
  );
}

function createBatchLoopFlow(options: {
  inputItemsType?: string;
  outputType?: string;
  sourceCode?: string;
  batchCode?: string;
} = {}) {
  const inputItemsType = options.inputItemsType || 'number';
  const outputType = options.outputType || 'number';
  return {
    nodes: [
      {
        id: 'batch_start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: { title: '开始', outputs: { type: 'object', properties: {} } },
      },
      {
        id: 'batch_source',
        type: 'code',
        meta: { position: { x: 300, y: 0 } },
        data: {
          title: '生成数组',
          inputsValues: {},
          script: {
            language: 'javascript',
            content: options.sourceCode
              || 'function main({ params }) { return { items: [1, 2, 3] }; }',
          },
          outputs: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: inputItemsType } },
            },
          },
        },
      },
      {
        id: 'batch_loop',
        type: 'loop',
        meta: { position: { x: 600, y: 0 } },
        data: {
          title: '数组批处理',
          loopFor: { type: 'ref', content: ['batch_source', 'items'] },
          loopOutputs: {
            doubled: { type: 'ref', content: ['batch_inner_code', 'doubled'] },
          },
          outputs: {
            type: 'object',
            properties: {
              doubled: { type: 'array', items: { type: outputType } },
            },
          },
        },
        blocks: [
          {
            id: 'batch_block_start',
            type: 'block-start',
            meta: { position: { x: 32, y: 0 } },
            data: {},
          },
          {
            id: 'batch_inner_code',
            type: 'code',
            meta: { position: { x: 190, y: 0 } },
            data: {
              title: '逐项翻倍',
              inputsValues: {
                item: { type: 'ref', content: ['batch_loop_locals', 'item'] },
                index: { type: 'ref', content: ['batch_loop_locals', 'index'] },
              },
              script: {
                language: 'javascript',
                content: options.batchCode
                  || 'function main({ params }) { return { doubled: params.item * 2 }; }',
              },
              outputs: {
                type: 'object',
                properties: { doubled: { type: outputType } },
              },
            },
          },
          {
            id: 'batch_block_end',
            type: 'block-end',
            meta: { position: { x: 600, y: 0 } },
            data: {},
          },
        ],
        edges: [
          { sourceNodeID: 'batch_block_start', targetNodeID: 'batch_inner_code' },
          { sourceNodeID: 'batch_inner_code', targetNodeID: 'batch_block_end' },
        ],
      },
      {
        id: 'batch_end',
        type: 'end',
        meta: { position: { x: 1300, y: 0 } },
        data: {
          title: '结束',
          inputsValues: {
            result: { type: 'ref', content: ['batch_loop', 'doubled'] },
          },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'batch_start', targetNodeID: 'batch_source' },
      { sourceNodeID: 'batch_source', targetNodeID: 'batch_loop' },
      { sourceNodeID: 'batch_loop', targetNodeID: 'batch_end' },
    ],
  } as any;
}

async function testBatchLoopCompilesToDifyIteration() {
  const converter = new DifyConverterService();
  const flow = createBatchLoopFlow();
  const dsl = converter.toDifyDSL(flow);
  const node = (id: string) => dsl.workflow.graph.nodes.find((candidate) => candidate.id === id);
  const iteration = node('batch_loop');
  const iterationStart = node('batch_block_start');
  const innerCode = node('batch_inner_code');

  assert.equal(dsl.workflow.graph.nodes.length, 6);
  assert.equal(iteration?.data.type, 'iteration');
  assert.deepEqual(iteration?.data.iterator_selector, ['batch_source', 'items']);
  assert.deepEqual(iteration?.data.output_selector, ['batch_inner_code', 'doubled']);
  assert.equal(iteration?.data.output_type, 'array[number]');
  assert.equal(iteration?.data.start_node_id, 'batch_block_start');
  assert.equal(iteration?.data.is_parallel, false);
  assert.equal(iteration?.data.parallel_nums, 1);
  assert.equal(iterationStart?.data.type, 'iteration-start');
  assert.equal(iterationStart?.data.iteration_id, 'batch_loop');
  assert.equal(iterationStart?.parentId, 'batch_loop');
  assert.equal(innerCode?.parentId, 'batch_loop');
  assert.equal(innerCode?.data.isInIteration, true);
  assert.equal(innerCode?.data.iteration_id, 'batch_loop');
  assert.deepEqual(innerCode?.data.variables, [
    { variable: '__ff_item_0', value_selector: ['batch_loop', 'item'] },
    { variable: '__ff_index_1', value_selector: ['batch_loop', 'index'] },
    { variable: '__ff_iteration_index', value_selector: ['batch_loop', 'index'] },
  ]);
  assert.match(innerCode?.data.code, /__ffIndex >= 20/);
  assert.doesNotMatch(innerCode?.data.code, /\.slice\s*\(/);
  assert.deepEqual(node('batch_end')?.data.outputs, [
    { variable: 'result', value_selector: ['batch_loop', 'output'] },
  ]);

  const internalEdge = dsl.workflow.graph.edges.find(
    (edge) => edge.source === 'batch_block_start' && edge.target === 'batch_inner_code',
  );
  assert.equal(internalEdge?.data.isInIteration, true);
  assert.equal(internalEdge?.data.iteration_id, 'batch_loop');
  assert.equal(internalEdge?.data.sourceType, 'iteration-start');
  assert.equal(internalEdge?.data.targetType, 'code');
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.target === 'batch_loop')?.data.targetType,
    'iteration',
  );
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.source === 'batch_loop')?.data.sourceType,
    'iteration',
  );

  const stringDsl = converter.toDifyDSL(createBatchLoopFlow({
    inputItemsType: 'string',
    outputType: 'string',
    sourceCode: "function main({ params }) { return { items: ['a', 'b'] }; }",
    batchCode: "function main({ params }) { return { doubled: params.item + '!' }; }",
  }));
  assert.equal(
    stringDsl.workflow.graph.nodes.find((candidate) => candidate.id === 'batch_loop')?.data.output_type,
    'array[string]',
  );

  const booleanDsl = converter.toDifyDSL(createBatchLoopFlow({
    outputType: 'boolean',
    batchCode: 'function main({ params }) { return { doubled: params.item > 1 }; }',
  }));
  const booleanIteration = booleanDsl.workflow.graph.nodes.find(
    (candidate) => candidate.id === 'batch_loop',
  );
  const booleanCode = booleanDsl.workflow.graph.nodes.find(
    (candidate) => candidate.id === 'batch_inner_code',
  );
  assert.equal(booleanIteration?.data.output_type, 'array[number]');
  assert.equal(booleanCode?.data.outputs.doubled.type, 'number');
  assert.match(booleanCode?.data.code, /Number\(Boolean\(__ffValue\)\)/);

  const loopConditionFlow = createBatchLoopFlow();
  loopConditionFlow.nodes = loopConditionFlow.nodes.filter((candidate) => candidate.id !== 'batch_end');
  loopConditionFlow.nodes.push(
    {
      id: 'batch_condition',
      type: 'condition',
      data: {
        title: '批处理结果条件',
        conditions: [{
          key: 'not_empty',
          value: {
            left: { type: 'ref', content: ['batch_loop', 'doubled'] },
            operator: 'is_not_empty',
          },
        }],
      },
    },
    {
      id: 'batch_condition_text',
      type: 'text',
      data: {
        title: '批处理条件命中',
        inputsValues: { text: { type: 'constant', content: 'ok' } },
        outputs: { type: 'object', properties: { text: { type: 'string' } } },
      },
    },
    { id: 'batch_condition_end', type: 'end', data: { title: '结束' } },
  );
  loopConditionFlow.edges = loopConditionFlow.edges
    .filter((edge) => edge.targetNodeID !== 'batch_end')
    .concat([
      { sourceNodeID: 'batch_loop', targetNodeID: 'batch_condition' },
      {
        sourceNodeID: 'batch_condition',
        targetNodeID: 'batch_condition_text',
        sourcePortID: 'not_empty',
      },
      { sourceNodeID: 'batch_condition_text', targetNodeID: 'batch_condition_end' },
    ]);
  const loopConditionDsl = converter.toDifyDSL(loopConditionFlow);
  const loopConditionAtom = loopConditionDsl.workflow.graph.nodes
    .find((candidate) => candidate.id === 'batch_condition')?.data.cases[0].conditions[0];
  assert.deepEqual(loopConditionAtom, {
    variable_selector: ['batch_loop', 'output'],
    comparison_operator: 'not null',
  });

  const numericArrayContainsFlow = structuredClone(loopConditionFlow);
  numericArrayContainsFlow.nodes
    .find((candidate) => candidate.id === 'batch_condition')
    .data.conditions[0].value = {
      left: { type: 'ref', content: ['batch_loop', 'doubled'] },
      operator: 'contains',
      right: { type: 'constant', content: 2 },
    };
  assert.throws(
    () => converter.toDifyDSL(numericArrayContainsFlow),
    /当前仅支持字符串数组条件/,
  );

  const invalid = (mutate: (draft: any) => void, expected: RegExp) => {
    const draft = createBatchLoopFlow();
    mutate(draft);
    assert.throws(() => converter.toDifyDSL(draft), expected);
  };
  invalid((draft) => { draft.nodes[2].blocks = draft.nodes[2].blocks.slice(0, 2); }, /子画布必须固定/);
  invalid((draft) => { draft.nodes[2].edges = draft.nodes[2].edges.slice(0, 1); }, /内部连线必须且只能有两条/);
  invalid((draft) => { draft.nodes[2].blocks[1].type = 'http'; }, /仅允许一个同步 JavaScript/);
  invalid((draft) => {
    draft.nodes[2].blocks[1].data.script.content = 'async function main({ params }) { return { doubled: params.item }; }';
  }, /必须同步执行|暂不支持 async/);
  invalid((draft) => {
    draft.nodes[2].blocks[1].data.outputs.properties.extra = { type: 'number' };
  }, /必须且只能声明一个输出/);
  invalid((draft) => {
    draft.nodes[1].data.outputs.properties.items.items.type = 'object';
  }, /输入仅支持字符串数组或数字数组/);
  invalid((draft) => {
    draft.nodes[2].blocks[1].data.outputs.properties.doubled.type = 'object';
  }, /逐项输出仅支持字符串或数字/);
  invalid((draft) => {
    draft.nodes[2].data.outputs.properties.doubled.items.type = 'string';
  }, /输出声明与批处理结果不一致/);
  invalid((draft) => {
    draft.nodes[2].data.loopOutputs.doubled.content = ['batch_inner_code', 'missing'];
  }, /必须引用子画布代码节点的唯一输出/);
  invalid((draft) => {
    draft.nodes[2].blocks[1].data.inputsValues.item.content = ['batch_end', 'result'];
  }, /只能引用当前项 item 或序号 index/);
  invalid((draft) => {
    draft.edges.push({ sourceNodeID: 'batch_start', targetNodeID: 'batch_loop' });
  }, /必须来自所有执行路径都会经过的上游节点/);
  invalid((draft) => {
    draft.nodes.push(JSON.parse(JSON.stringify(draft.nodes[2])));
    draft.nodes[4].id = 'second_batch_loop';
  }, /最多只能使用一个节点/);
}

async function testContentNodesCompileToDifyCode() {
  const converter = new DifyConverterService();
  const dsl = converter.toDifyDSL({
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: {
          title: '开始',
          outputs: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
      {
        id: 'text',
        type: 'text',
        data: {
          title: '文本处理',
          inputsValues: { text: { type: 'template', content: '标题：{{start.query}}' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'image',
        type: 'image',
        data: {
          title: '图片处理',
          inputsValues: {
            url: { type: 'constant', content: 'https://example.test/image.png' },
            caption: { type: 'ref', content: ['text', 'text'] },
          },
          outputs: { type: 'object', properties: { url: { type: 'string' } } },
        },
      },
      { id: 'end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'text' },
      { sourceNodeID: 'text', targetNodeID: 'image' },
      { sourceNodeID: 'image', targetNodeID: 'end' },
    ],
  } as any);

  const text = dsl.workflow.graph.nodes.find((node) => node.id === 'text')?.data;
  const image = dsl.workflow.graph.nodes.find((node) => node.id === 'image')?.data;
  assert.equal(text?.type, 'code');
  assert.deepEqual(text?.variables, [{ variable: '__ff_text_0', value_selector: ['start', 'query'] }]);
  assert.equal(image?.outputs.mediaType.type, 'string');
  assert.deepEqual(
    dsl.workflow.graph.nodes.find((node) => node.id === 'end')?.data.outputs,
    [{ variable: 'result', value_selector: ['image', 'url'] }],
  );
  assert.equal(
    dsl.workflow.graph.edges.find((edge) => edge.source === 'image')?.data.sourceType,
    'code',
  );
}

async function testFlowGramConditionOperatorAliases() {
  const converter = new DifyConverterService();
  const cases = [
    { field: 'text', operator: 'eq', expected: 'is', right: 1, value: '1' },
    { field: 'text', operator: 'neq', expected: 'is not', right: 1, value: '1' },
    { field: 'score', operator: 'eq', expected: '=', right: 1, value: '1' },
    { field: 'score', operator: 'neq', expected: '≠', right: 1, value: '1' },
    { field: 'score', operator: 'gt', expected: '>', right: 1, value: '1' },
    { field: 'score', operator: 'gte', expected: '≥', right: 1, value: '1' },
    { field: 'score', operator: 'lt', expected: '<', right: 1, value: '1' },
    { field: 'score', operator: 'lte', expected: '≤', right: 1, value: '1' },
    { field: 'text', operator: 'in', expected: 'in', right: ['a', 'b'], value: ['a', 'b'] },
    { field: 'text', operator: 'nin', expected: 'not in', right: ['a', 'b'], value: ['a', 'b'] },
    { field: 'text', operator: 'contains', expected: 'contains', right: 'a', value: 'a' },
    { field: 'text', operator: 'not_contains', expected: 'not contains', right: 'a', value: 'a' },
    { field: 'text', operator: 'is_empty', expected: 'null' },
    { field: 'text', operator: 'is_not_empty', expected: 'not null' },
    { field: 'enabled', operator: 'is_true', expected: '=', value: '1' },
    { field: 'enabled', operator: 'is_false', expected: '=', value: '0' },
  ];
  const dsl = converter.toDifyDSL({
    nodes: [
      {
        id: 'operator_start',
        type: 'start',
        data: {
          title: '开始',
        },
      },
      {
        id: 'operator_source',
        type: 'code',
        data: {
          title: '类型化条件数据',
          inputsValues: {},
          inputs: { type: 'object', properties: {} },
          script: {
            language: 'javascript',
            content: `function main() {
  return { text: 'a', score: 1, enabled: true };
}`,
          },
          outputs: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              score: { type: 'integer' },
              enabled: { type: 'boolean' },
            },
          },
        },
      },
      {
        id: 'operator_condition',
        type: 'condition',
        data: {
          title: '条件',
          conditions: cases.map((entry, index) => ({
            key: `case_${index}`,
            value: {
              left: { type: 'ref', content: ['operator_source', entry.field] },
              operator: entry.operator,
              ...(Object.prototype.hasOwnProperty.call(entry, 'right')
                ? { right: { type: 'constant', content: entry.right } }
                : {}),
            },
          })),
        },
      },
      {
        id: 'operator_text',
        type: 'text',
        data: {
          title: '文本',
          inputsValues: { text: { type: 'constant', content: 'ok' } },
        },
      },
      { id: 'operator_end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'operator_start', targetNodeID: 'operator_source' },
      { sourceNodeID: 'operator_source', targetNodeID: 'operator_condition' },
      {
        sourceNodeID: 'operator_condition',
        targetNodeID: 'operator_text',
        sourcePortID: 'case_0',
      },
      { sourceNodeID: 'operator_text', targetNodeID: 'operator_end' },
    ],
  } as any);
  const converted = dsl.workflow.graph.nodes
    .find((node) => node.id === 'operator_condition')?.data.cases;
  assert.equal(converted.length, cases.length);
  cases.forEach((entry, index) => {
    const atom = converted[index].conditions[0];
    assert.equal(atom.comparison_operator, entry.expected, entry.operator);
    if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
      assert.deepEqual(atom.value, entry.value, entry.operator);
    } else {
      assert.equal(Object.prototype.hasOwnProperty.call(atom, 'value'), false, entry.operator);
    }
  });

  const yaml = converter.toDifyDSLYaml({
    nodes: [
      {
        id: 'yaml_start',
        type: 'start',
        data: { title: '开始' },
      },
      {
        id: 'yaml_source',
        type: 'code',
        data: {
          title: '数值来源',
          inputsValues: {},
          inputs: { type: 'object', properties: {} },
          script: { language: 'javascript', content: 'function main() { return { score: 1 }; }' },
          outputs: {
            type: 'object',
            properties: { score: { type: 'integer' } },
          },
        },
      },
      {
        id: 'yaml_condition',
        type: 'condition',
        data: {
          title: '数值等于',
          conditions: [{
            key: 'equal',
            value: {
              left: { type: 'ref', content: ['yaml_source', 'score'] },
              operator: 'eq',
              right: { type: 'constant', content: 1 },
            },
          }],
        },
      },
      {
        id: 'yaml_text',
        type: 'text',
        data: {
          title: '命中结果',
          inputsValues: { text: { type: 'constant', content: 'ok' } },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      { id: 'yaml_end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'yaml_start', targetNodeID: 'yaml_source' },
      { sourceNodeID: 'yaml_source', targetNodeID: 'yaml_condition' },
      { sourceNodeID: 'yaml_condition', targetNodeID: 'yaml_text', sourcePortID: 'equal' },
      { sourceNodeID: 'yaml_text', targetNodeID: 'yaml_end' },
    ],
  } as any);
  assert.match(yaml, /^\s*comparison_operator: "="$/m);
  assert.doesNotMatch(yaml, /^\s*comparison_operator: =$/m);
}

async function testDify015ConditionValueRuntimeContract() {
  const converter = new DifyConverterService();
  const flowgram = {
    nodes: [
      { id: 'contract_start', type: 'start', data: { title: '开始' } },
      {
        id: 'contract_source',
        type: 'code',
        data: {
          title: '条件数据',
          inputsValues: {},
          inputs: { type: 'object', properties: {} },
          script: {
            language: 'javascript',
            content: `function main() {
  return { score: 200, enabled: true, label: 'CN', tags: ['CN'], numericTags: [1], metadata: {} };
}`,
          },
          outputs: {
            type: 'object',
            properties: {
              score: { type: 'integer' },
              enabled: { type: 'boolean' },
              label: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              numericTags: { type: 'array', items: { type: 'integer' } },
              metadata: { type: 'object', properties: {} },
            },
          },
        },
      },
      {
        id: 'contract_condition',
        type: 'condition',
        data: {
          title: '运行时条件契约',
          conditions: [
            {
              key: 'number_equal',
              value: {
                left: { type: 'ref', content: ['contract_source', 'score'] },
                operator: 'eq',
                right: { type: 'constant', content: 200 },
              },
            },
            {
              key: 'boolean_true',
              value: {
                left: { type: 'ref', content: ['contract_source', 'enabled'] },
                operator: 'is_true',
              },
            },
            {
              key: 'boolean_equal_false',
              value: {
                left: { type: 'ref', content: ['contract_source', 'enabled'] },
                operator: 'eq',
                right: { type: 'constant', content: false },
              },
            },
            {
              key: 'list_membership',
              value: {
                left: { type: 'ref', content: ['contract_source', 'label'] },
                operator: 'in',
                right: { type: 'constant', content: [1, true, 'CN'] },
              },
            },
            {
              key: 'ui_list_membership',
              value: {
                left: { type: 'ref', content: ['contract_source', 'label'] },
                operator: 'in',
                right: {
                  type: 'constant',
                  content: '["US", "CN"]',
                  schema: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            {
              key: 'without_value',
              value: {
                left: { type: 'ref', content: ['contract_source', 'label'] },
                operator: 'is_not_empty',
              },
            },
            {
              key: 'object_empty',
              value: {
                left: { type: 'ref', content: ['contract_source', 'metadata'] },
                operator: 'is_empty',
              },
            },
            {
              key: 'number_empty',
              value: {
                left: { type: 'ref', content: ['contract_source', 'score'] },
                operator: 'is_empty',
              },
            },
            {
              key: 'numeric_array_empty',
              value: {
                left: { type: 'ref', content: ['contract_source', 'numericTags'] },
                operator: 'is_empty',
              },
            },
            {
              key: 'array_contains',
              value: {
                left: { type: 'ref', content: ['contract_source', 'tags'] },
                operator: 'contains',
                right: { type: 'constant', content: 'CN' },
              },
            },
          ],
        },
      },
      {
        id: 'contract_text',
        type: 'text',
        data: {
          title: '完成',
          inputsValues: { text: { type: 'constant', content: '完成' } },
        },
      },
      { id: 'contract_end', type: 'end', data: { title: '结束' } },
    ],
    edges: [
      { sourceNodeID: 'contract_start', targetNodeID: 'contract_source' },
      { sourceNodeID: 'contract_source', targetNodeID: 'contract_condition' },
      {
        sourceNodeID: 'contract_condition',
        targetNodeID: 'contract_text',
        sourcePortID: 'number_equal',
      },
      { sourceNodeID: 'contract_text', targetNodeID: 'contract_end' },
    ],
  } as any;
  const dsl = converter.toDifyDSL(flowgram);

  const cases = dsl.workflow.graph.nodes
    .find((node) => node.id === 'contract_condition')?.data.cases;
  assert.deepEqual(
    cases.map((entry) => entry.conditions[0]),
    [
      {
        variable_selector: ['contract_source', 'score'],
        comparison_operator: '=',
        value: '200',
      },
      {
        variable_selector: ['contract_source', 'enabled'],
        comparison_operator: '=',
        value: '1',
      },
      {
        variable_selector: ['contract_source', 'enabled'],
        comparison_operator: '=',
        value: '0',
      },
      {
        variable_selector: ['contract_source', 'label'],
        comparison_operator: 'in',
        value: ['1', 'true', 'CN'],
      },
      {
        variable_selector: ['contract_source', 'label'],
        comparison_operator: 'in',
        value: ['US', 'CN'],
      },
      {
        variable_selector: ['contract_source', 'label'],
        comparison_operator: 'not null',
      },
      {
        variable_selector: ['contract_source', 'metadata'],
        comparison_operator: 'null',
      },
      {
        variable_selector: ['contract_source', 'score'],
        comparison_operator: 'null',
      },
      {
        variable_selector: ['contract_source', 'numericTags'],
        comparison_operator: 'null',
      },
      {
        variable_selector: ['contract_source', 'tags'],
        comparison_operator: 'contains',
        value: 'CN',
      },
    ],
  );

  const invalidCombinations = [
    { field: 'label', operator: 'gt', right: 1, message: /string 类型不支持 gt 比较/ },
    { field: 'score', operator: 'contains', right: 1, message: /integer 类型不支持 contains 比较/ },
    { field: 'label', operator: 'is_true', message: /不是布尔值/ },
    { field: 'tags', operator: 'eq', right: ['CN'], message: /array 类型不支持 eq 比较/ },
    { field: 'numericTags', operator: 'contains', right: 1, message: /仅支持字符串数组条件/ },
    { field: 'enabled', operator: 'gt', right: 0, message: /boolean 类型不支持 gt 比较/ },
    { field: 'label', operator: 'eq', right: undefined, message: /不能是 undefined 或 null/ },
    { field: 'label', operator: 'eq', right: null, message: /不能是 undefined 或 null/ },
    { field: 'label', operator: 'eq', right: { nested: true }, message: /仅支持字符串、数字、布尔值/ },
    { field: 'score', operator: 'eq', right: Number.NaN, message: /必须是有限数字/ },
    { field: 'score', operator: 'eq', right: Number.POSITIVE_INFINITY, message: /必须是有限数字/ },
    { field: 'score', operator: 'eq', right: 1.5, message: /不能包含小数/ },
    { field: 'score', operator: 'eq', right: true, message: /不能使用布尔值/ },
    { field: 'label', operator: 'in', right: ['CN', null], message: /不能是 undefined 或 null/ },
    { field: 'label', operator: 'in', right: ['CN', {}], message: /仅支持字符串、数字、布尔值/ },
    { field: 'tags', operator: 'contains', right: ['CN'], message: /必须是标量常量/ },
    {
      field: 'tags',
      operator: 'contains',
      right: '["CN"]',
      rightSchema: { type: 'array', items: { type: 'string' } },
      message: /必须是标量常量/,
    },
    { field: 'metadata', operator: 'eq', right: {}, message: /object 类型不支持 eq 比较/ },
  ];
  for (const invalid of invalidCombinations) {
    const invalidFlowgram = structuredClone(flowgram);
    invalidFlowgram.nodes.find((node) => node.id === 'contract_condition').data.conditions = [
      {
        key: 'invalid',
        value: {
          left: { type: 'ref', content: ['contract_source', invalid.field] },
          operator: invalid.operator,
          ...(Object.prototype.hasOwnProperty.call(invalid, 'right')
            ? {
              right: {
                type: 'constant',
                content: invalid.right,
                ...(invalid.rightSchema ? { schema: invalid.rightSchema } : {}),
              },
            }
            : {}),
        },
      },
    ];
    invalidFlowgram.edges.find(
      (edge) => edge.sourceNodeID === 'contract_condition',
    ).sourcePortID = 'invalid';
    assert.throws(() => converter.toDifyDSL(invalidFlowgram), invalid.message);
  }
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

async function testDifyPendingImportMustBeConfirmedBeforePublish() {
  const originalFetch = global.fetch;
  const input = {
    workflowId: 'workflow-pending-import-guard',
    workflowVersion: 8,
    workflowName: '待确认导入保护',
    flowgram: { nodes: [], edges: [] },
  };
  const consoleBase = 'http://dify-pending.test/console/api';
  const appId = 'dify-pending-app';
  const importId = '11111111-2222-4333-8444-555555555555';

  const runScenario = async (
    importResult: Record<string, unknown>,
    confirmationResult?: Record<string, unknown>,
  ) => {
    const fetchCalls: Array<{ url: string; method: string; authorization: string }> = [];
    const activationCalls: Array<{ workflowId: string; workflowVersion: number }> = [];
    const integration = {
      resolveConsoleAuthorization: async () => ({
        consoleBase,
        token: 'pending-import-console-token',
      }),
      ensureWorkflowIntegration: async () => ({ appId, status: 'provisioning' }),
      activateWorkflowIntegration: async (workflowId: string, workflowVersion: number) => {
        activationCalls.push({ workflowId, workflowVersion });
      },
    };
    global.fetch = (async (url: string, init?: RequestInit) => {
      const request = {
        url: String(url),
        method: String(init?.method || 'GET'),
        authorization: String(new Headers(init?.headers).get('Authorization') || ''),
      };
      fetchCalls.push(request);
      assert.equal(request.authorization, 'Bearer pending-import-console-token');
      if (request.url === `${consoleBase}/apps/imports`) {
        return new Response(JSON.stringify(importResult), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (request.url === `${consoleBase}/apps/imports/${importId}/confirm`) {
        assert.ok(confirmationResult, '不应在没有确认响应的场景调用确认接口');
        return new Response(JSON.stringify(confirmationResult), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (request.url === `${consoleBase}/apps/${appId}/workflows/publish`) {
        return new Response(null, { status: 204 });
      }
      assert.fail(`未预期的 pending 导入请求: ${request.method} ${request.url}`);
    }) as typeof global.fetch;

    const service = new DifyConsoleService(
      { get: (_key: string, fallback = '') => fallback } as any,
      { toDifyDSLYaml: () => 'version: 0.1.5\nkind: app' } as any,
      integration as any,
    );
    const result = await service.syncPublishedWorkflow(input as any);
    return { result, fetchCalls, activationCalls };
  };

  try {
    const confirmed = await runScenario(
      { id: importId, status: 'pending', app_id: appId },
      { id: importId, status: 'completed-with-warnings', app_id: appId },
    );
    assert.equal(confirmed.result.status, 'synced');
    assert.deepEqual(
      confirmed.fetchCalls.map((item) => ({ url: item.url, method: item.method })),
      [
        { url: `${consoleBase}/apps/imports`, method: 'POST' },
        { url: `${consoleBase}/apps/imports/${importId}/confirm`, method: 'POST' },
        { url: `${consoleBase}/apps/${appId}/workflows/publish`, method: 'POST' },
      ],
      '202 pending 必须先确认完成，之后才能发布',
    );
    assert.deepEqual(confirmed.activationCalls, [{
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
    }]);

    const missingConfirmationPath = await runScenario({
      status: 'pending',
      app_id: appId,
    });
    assert.equal(missingConfirmationPath.result.status, 'failed');
    assert.equal(missingConfirmationPath.fetchCalls.length, 1);
    assert.equal(missingConfirmationPath.activationCalls.length, 0);
    assert.match(missingConfirmationPath.result.message, /未返回可确认的导入 ID/);

    const stillPending = await runScenario(
      { id: importId, status: 'pending', app_id: appId },
      { id: importId, status: 'pending', app_id: appId },
    );
    assert.equal(stillPending.result.status, 'failed');
    assert.equal(
      stillPending.fetchCalls.some((item) => item.url.endsWith('/workflows/publish')),
      false,
      '确认响应仍为 pending 时绝不能发布空应用',
    );
    assert.equal(stillPending.activationCalls.length, 0);
    assert.match(stillPending.result.message, /尚未明确完成/);
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await testGatewaySecurityDefaults();

  testSyntheticDnsSsrfPolicy();
  await testControllerCompletesGenerator();
  await testDifyWorkflowIsolationEncryptsGeneratedKeys();
  await testDifyAutomaticAdminAuthorizationIsEncryptedAndFatal();
  await testDifyAutomaticAuthorizationSyncsModelProviderAfterKeyAdded();
  await testDifyExplicitTokenRecoversBrokenStoredAuthorizationSafely();
  await testDifyCreateAppAuthorizationRecoveryRetriesWholeProvisioningOnce();
  await testDifyApiKeyAuthorizationRecoveryCleansPartialAppBeforeRetry();
  await testDifyConsolePublishMustSucceedBeforeActivation();
  await testDifyPendingImportMustBeConfirmedBeforePublish();
  await testHashedApiKeyAuthentication();
  await testWorkflowValidationAndDirectModeGuard();
  await testExecutionFailuresAlwaysRefund();
  await testConditionBranchConversionAndDirectExecution();
  await testDify015NodeSchemas();
  await testDifyRealCanvasSelectorsAndSchemas();
  await testHttpPublishValidation();
  await testDifyCanvasDecorationsAndUnsupportedNodes();
  await testVariableNodesCompileToDifyCode();
  await testBatchLoopCompilesToDifyIteration();
  await testContentNodesCompileToDifyCode();
  await testFlowGramConditionOperatorAliases();
  await testDify015ConditionValueRuntimeContract();
  await testDifyRejectsAmbiguousMergedEnd();
  console.log('platform smoke tests passed');
}

void main();
