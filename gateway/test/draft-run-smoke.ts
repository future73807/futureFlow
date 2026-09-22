/**
 * 草稿云端试运行（draft-run）编排冒烟测试。
 *
 * 用假沙箱服务验证 WorkflowsController.draftRun 的编排契约：
 * 归属校验先于沙箱准备、准备失败时阻断执行、成功时以沙箱 Key 走执行链路。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { WorkflowsController } from '../src/workflows/workflows.controller';
import { DraftRunService } from '../src/workflows/draft-run.service';
import { encryptAesGcm, resolveEncryptionKeyRing } from '../src/common/encryption-key-ring';

function makeRes() {
  const sse: string[] = [];
  return {
    req: { user: { id: 'user-1', username: 'tester', vipLevel: 'pro' } },
    headersSent: false,
    destroyed: false,
    status() { return this; },
    json() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) { sse.push(chunk); },
    end() {},
    once() {},
    on() {},
    removeListener() {},
    writableEnded: false,
    sse,
  } as any;
}

function makeHarness(options: { failPrepare?: boolean }) {
  const runCalls: Array<{ target: any }> = [];
  const sandboxCalls: string[] = [];
  const workflowsService = {
    *runWorkflow(_flowgram: any, _user: any, _inputs: any, _workflowId: any, ctx: any) {
      runCalls.push({ target: { apiKey: ctx.sandboxApiKey } });
      yield { event: 'workflow_finished', data: { status: 'succeeded' } };
    },
  };
  const draftRunService = {
    async prepareSandbox(userId: string, flowgram: any) {
      sandboxCalls.push(userId);
      if (options.failPrepare && flowgram?.nodes?.some((n: any) => n.data?.failPrepare)) {
        throw new ServiceUnavailableMock();
      }
      return { appId: 'sandbox-app', apiKey: ['app', 'sandbox', 'key'].join(''), reused: false };
    },
  };
  const crudService = {
    async getById(id: string, _userId: string) {
      if (id === 'missing') throw new NotFoundException('工作流不存在');
      return {
        id,
        userId: _userId,
        name: '草稿',
        flowgramJson: { nodes: [{ id: 'n1', type: 'text', data: options.failPrepare ? { failPrepare: true } : {} }], edges: [] },
      };
    },
  };
  const controller = new WorkflowsController(
    workflowsService as any,
    {} as any,
    crudService as any,
    draftRunService as any,
    { assertFlowgramDatasetsOwned: async () => undefined } as any,
  );
  return { controller, runCalls, sandboxCalls };
}

class ServiceUnavailableMock extends Error {
  status = 503;
}

async function main() {
  // 1. 正常路径：沙箱准备 → runWorkflow 收到沙箱 Key → SSE 输出终态。
  const ok = makeHarness({});
  const okRes = makeRes();
  await ok.controller.draftRun('wf-1', { inputs: { query: 'hi' } } as any, okRes);
  assert.deepEqual(ok.sandboxCalls, ['user-1']);
  assert.equal(ok.runCalls.length, 1);
  assert.equal(ok.runCalls[0].target.apiKey, 'appsandboxkey');
  assert.match(okRes.sse.join(''), /workflow_finished/);

  // 2. 目标工作流不存在：归属校验先于沙箱准备。
  const missing = makeHarness({});
  await assert.rejects(
    () => missing.controller.draftRun('missing', {} as any, makeRes()),
    (error: unknown) => error instanceof NotFoundException,
  );
  assert.equal(missing.sandboxCalls.length, 0, '归属校验失败时不得准备沙箱');

  // 3. 沙箱准备失败：不进入执行链路。
  const failed = makeHarness({ failPrepare: true });
  const failedRes = makeRes();
  await failed.controller.draftRun('wf-1', {} as any, failedRes).catch(() => undefined);
  assert.equal(failed.runCalls.length, 0, '沙箱准备失败时不得执行工作流');

  await testSandboxSelfHealing();

  console.log('draft-run orchestration smoke passed');
}

// ─────────────────────────────────────────────────────────────────────
// DraftRunService：沙箱记录与 Dify 侧应用不一致时的自愈
// ─────────────────────────────────────────────────────────────────────
//
// 背景：`draft_sandboxes` 每个用户一行。一旦它指向的 Dify 应用被外部删掉
// （人工清理 Dify 资源、Dify 数据卷被重置、或误删），而代码又无条件相信这一行，
// 该用户的草稿试运行就会**每次**以
// `Dify 草稿沙箱请求失败（HTTP 400）："App not found"` 硬失败 —— 用户侧完全无法
// 自愈，只能等 DSL 变化。两条路径都会用到 existing.appId（DSL 未变时直接复用；
// DSL 变了也会复用同一个应用重新导入），所以校验必须覆盖两条。

const SANDBOX_SECRET = 'draft-sandbox-test-encryption-secret-0123456789';
const STUB_YAML = 'kind: app\nversion: 0.1.5\n';
/** 与服务内 createHash('sha256').update(yaml,'utf8').digest('hex') 保持一致。 */
const STUB_DSL_HASH = createHash('sha256').update(STUB_YAML, 'utf8').digest('hex');

/** 服务用的配置桩：只要密钥环那一项。 */
function sandboxConfig(): any {
  return {
    get: (key: string, fallback?: string) => (
      key === 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET' ? SANDBOX_SECRET : fallback
    ),
  };
}

/**
 * 造一份**服务真能解开**的密文。
 *
 * 密钥是 `resolveEncryptionKeyRing` 从 secret 派生出来的（不是直接把 secret
 * 填充成 32 字节），所以这里必须走同一个函数，否则测试会卡在解密失败上 ——
 * 那样测到的是「夹具造错了」而不是被测逻辑。
 */
function encryptForSandbox(plaintext: string, userId: string): string {
  const [key] = resolveEncryptionKeyRing(sandboxConfig(), {
    primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET',
    legacy: ['DIFY_KEY_ENCRYPTION_SECRET'],
    purpose: '草稿沙箱凭据',
  });
  return encryptAesGcm(key, plaintext, Buffer.from(`draft-sandbox:${userId}`, 'utf8'));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 构造真实 DraftRunService + 桩依赖，并把 fetch 换成一个按路径分派的假 Console。
 *
 * @param appExists 存在性校验（GET /apps/:id）是否返回 200
 * @param sameDsl   记录里的 dslHash 是否与本次草稿一致
 */
function makeDraftRunHarness(options: { appExists: boolean; sameDsl: boolean }) {
  const deleted: any[] = [];
  const saved: any[] = [];
  const consoleCalls: string[] = [];

  const existingRow = {
    id: 'row-1',
    userId: 'user-1',
    appId: 'stale-or-existing-app',
    dslHash: options.sameDsl ? STUB_DSL_HASH : 'hash-from-a-previous-draft',
    // 复用路径要解密它，所以必须是真密文
    encryptedApiKey: encryptForSandbox('reused-api-key', 'user-1'),
  };

  const repo = {
    findOne: async () => ({ ...existingRow }),
    delete: async (criteria: any) => { deleted.push(criteria); },
    create: (value: any) => value,
    save: async (value: any) => { saved.push(value); return value; },
  };
  const dify = {
    resolveConsoleAuthorization: async () => ({
      consoleBase: 'http://console.test/console/api',
      token: 'console-token',
    }),
  };
  const converter = { toDifyDSLYaml: () => STUB_YAML };
  const config = sandboxConfig();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    consoleCalls.push(`${method} ${url}`);

    // 存在性校验：GET /apps/<id>（没有更深的路径段）
    if (method === 'GET' && /\/apps\/[^/]+$/.test(url)) {
      return options.appExists
        ? jsonResponse(200, { id: 'x', name: 'futureFlow · 草稿试运行' })
        : jsonResponse(404, { code: 'app_not_found', message: 'App not found.' });
    }
    if (method === 'POST' && url.endsWith('/apps')) {
      return jsonResponse(201, { id: 'brand-new-app' });
    }
    if (method === 'POST' && url.endsWith('/apps/imports')) {
      return jsonResponse(200, { status: 'completed' });
    }
    if (method === 'POST' && url.endsWith('/workflows/publish')) {
      return jsonResponse(200, { result: 'success' });
    }
    if (method === 'GET' && url.endsWith('/api-keys')) {
      return jsonResponse(200, { data: [{ id: 'k1', token: 'fresh-api-key' }] });
    }
    throw new Error(`未预期的 Console 调用: ${method} ${url}`);
  }) as any;

  const service = new DraftRunService(
    repo as any,
    dify as any,
    converter as any,
    config as any,
  );
  return {
    service,
    deleted,
    saved,
    consoleCalls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

async function testSandboxSelfHealing() {
  const flowgram = { nodes: [], edges: [] } as any;

  // 1. 应用已被外部删除 + DSL 变了（实测踩到的就是这条路径：
  //    走到 `existing?.appId || createApp(...)`，直接拿已删除的 appId 去导入）。
  {
    const harness = makeDraftRunHarness({ appExists: false, sameDsl: false });
    try {
      const target = await harness.service.prepareSandbox('user-1', flowgram);
      assert.deepEqual(
        harness.deleted.map((c) => c.id), ['row-1'],
        '应用已不存在时必须丢弃陈旧记录，否则下次还会拿着它继续失败',
      );
      assert.equal(
        target.appId, 'brand-new-app',
        `必须新建应用而不是复用已删除的 appId，实际 ${target.appId}`,
      );
      assert.equal(target.reused, false, '重建后不应标记为复用');
      assert.equal(
        harness.consoleCalls.some((c) => c === 'POST http://console.test/console/api/apps'),
        true,
        '应调用创建应用接口',
      );
      const persisted = harness.saved.at(-1);
      assert.equal(persisted?.appId, 'brand-new-app', '新记录必须指向新应用');
    } finally {
      harness.restore();
    }
  }

  // 2. 应用已被外部删除 + DSL 未变（复用分支）：同样必须自愈。
  {
    const harness = makeDraftRunHarness({ appExists: false, sameDsl: true });
    try {
      const target = await harness.service.prepareSandbox('user-1', flowgram);
      assert.deepEqual(harness.deleted.map((c) => c.id), ['row-1'], '复用分支也要丢弃陈旧记录');
      assert.equal(target.appId, 'brand-new-app', '不得复用已删除的应用');
    } finally {
      harness.restore();
    }
  }

  // 3. 应用仍在 + DSL 未变：必须复用，且不碰 Dify 的导入/发布。
  {
    const harness = makeDraftRunHarness({ appExists: true, sameDsl: true });
    try {
      const target = await harness.service.prepareSandbox('user-1', flowgram);
      assert.equal(target.reused, true, '应用仍在且 DSL 未变时应复用');
      assert.equal(target.appId, 'stale-or-existing-app', '复用应沿用原应用');
      assert.equal(target.apiKey, 'reused-api-key', '复用应返回解密后的原 Key');
      assert.deepEqual(harness.deleted, [], '健康路径不得删除记录');
      assert.deepEqual(harness.saved, [], '健康路径不得写库');
      assert.equal(
        harness.consoleCalls.some((c) => c.includes('/workflows/publish')),
        false,
        '复用路径不得重新导入/发布',
      );
    } finally {
      harness.restore();
    }
  }

  // 4. 应用仍在 + DSL 变了：复用同一个应用重新导入，不得新建应用。
  {
    const harness = makeDraftRunHarness({ appExists: true, sameDsl: false });
    try {
      const target = await harness.service.prepareSandbox('user-1', flowgram);
      assert.equal(
        target.appId, 'stale-or-existing-app',
        '每个用户只有一个沙箱应用，DSL 变化时应复用同一应用重新导入',
      );
      assert.equal(target.reused, false, 'DSL 变化不属于复用');
      assert.equal(
        harness.consoleCalls.some((c) => c === 'POST http://console.test/console/api/apps'),
        false,
        'DSL 变化不应新建应用',
      );
      assert.deepEqual(harness.deleted, [], '应用健康时不得删除记录');
    } finally {
      harness.restore();
    }
  }

  // 5. 拿不到 Console 授权时不得把复用路径拖垮（执行用的是已存的 Service API Key）。
  {
    const harness = makeDraftRunHarness({ appExists: true, sameDsl: true });
    const originalFetch = globalThis.fetch;
    try {
      const broken = new DraftRunService(
        { findOne: async () => ({
          id: 'row-1',
          userId: 'user-1',
          appId: 'stale-or-existing-app',
          dslHash: STUB_DSL_HASH,
          encryptedApiKey: encryptForSandbox('reused-api-key', 'user-1'),
        }) } as any,
        { resolveConsoleAuthorization: async () => { throw new Error('console down'); } } as any,
        { toDifyDSLYaml: () => STUB_YAML } as any,
        sandboxConfig(),
      );
      const target = await broken.prepareSandbox('user-1', { nodes: [], edges: [] } as any);
      assert.equal(target.reused, true, '授权不可用时应跳过校验、照常复用');
      assert.equal(target.apiKey, 'reused-api-key');
    } finally {
      globalThis.fetch = originalFetch;
      harness.restore();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
