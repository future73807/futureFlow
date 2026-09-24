import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BillingService } from '../src/billing/billing.service';
import { EmbeddedBillingProvider } from '../src/host/embedded-billing.provider';
import { EmbeddedCredentialsProvider } from '../src/host/embedded-credentials.provider';
import { EmbeddedEventSink } from '../src/host/embedded-events.provider';
import { EmbeddedIdentityProvider } from '../src/host/embedded-identity.provider';
import { HostHttpClient } from '../src/host/host-http.client';
import {
  hostCapabilities,
  readHostConfig,
  type HostConfig,
} from '../src/host/host.config';
import {
  StandaloneBillingProvider,
  StandaloneCredentialsProvider,
  StandaloneEventSink,
  StandaloneIdentityProvider,
} from '../src/host/standalone-providers';
import { LOCAL_CAPABILITIES } from '../src/host/host.types';

/**
 * 宿主适配层（`ff-embed`）的离线回归（不连数据库、不起 Nest）。
 *
 * 这组用例守住四条纪律（《flow 集成方案》§3.2 / §3.3）：
 *  ① **不配就是独立模式**：缺省行为与改造前一致，六项能力全部自带；
 *  ② **降级要能被看见**：缺哪一项回调、谁承担哪一项，都要能从 capabilities 读出来；
 *  ③ **入站消息一律校验**：宿主响应的形状不对就报可读错误，不 `as` 断言硬吞；
 *  ④ **幂等**：计费三段的幂等键固定为 `flow:<runId>:<op>`，凭证解析有缓存与单飞。
 *
 * 假宿主是一个真实的 http 服务（不是 stub）：这样「请求头带没带共享密钥 / 协议版本」
 * 「返回非 2xx 时的错误是否可读」这些**过线的行为**才真的被验到。
 */

const SHARED_SECRET = 'ff-embed-test-secret-0123456789';
const HOST_ORIGIN = 'http://127.0.0.1:3001';

function configFrom(env: Record<string, string>): HostConfig {
  return readHostConfig({ get: <T = string>(key: string) => env[key] as T | undefined });
}

function embeddedConfig(overrides: Record<string, string> = {}): HostConfig {
  return configFrom({
    HOST_MODE: 'embedded',
    HOST_SHARED_SECRET: SHARED_SECRET,
    HOST_IDENTITY_VERIFY_URL: 'http://127.0.0.1:9999/identity',
    HOST_ALLOWED_ORIGINS: HOST_ORIGIN,
    ...overrides,
  });
}

interface FakeHost {
  url: string;
  requests: Array<{ path: string; auth: string; protocol: string; body: any; idempotencyKey?: string }>;
  close: () => Promise<void>;
}

/** 起一个真实 http 假宿主；`routes` 按路径返回响应。 */
async function startFakeHost(
  routes: Record<string, (body: any, req: { headers: Record<string, unknown> }) => { status?: number; json?: unknown; text?: string }>,
): Promise<FakeHost> {
  const requests: FakeHost['requests'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const path = (req.url || '/').split('?')[0];
      requests.push({
        path,
        auth: String(req.headers.authorization || ''),
        protocol: String(req.headers['x-ff-embed-protocol'] || ''),
        idempotencyKey: req.headers['x-idempotency-key'] as string | undefined,
        body,
      });
      const handler = routes[path];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no route ${path}` }));
        return;
      }
      const result = handler(body, { headers: req.headers as Record<string, unknown> });
      const status = result.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(result.text ?? JSON.stringify(result.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 转账用的 BillingService 替身：只记录调用参数。 */
function billingDouble() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const service = {
    freezeBalance: async (...args: unknown[]) => {
      calls.push({ op: 'freeze', args });
      return args[1] as number;
    },
    settleBilling: async (...args: unknown[]) => {
      calls.push({ op: 'settle', args });
    },
    refund: async (...args: unknown[]) => {
      calls.push({ op: 'refund', args });
    },
    calculateCost: (...args: unknown[]) => {
      calls.push({ op: 'cost', args });
      return 0.25;
    },
  } as unknown as BillingService;
  return { service, calls };
}

// ── 1. 配置与能力声明 ────────────────────────────────────────────────────────

function testConfig() {
  const standalone = configFrom({});
  assert.equal(standalone.mode, 'standalone', '不配 HOST_MODE 就是独立模式（存量部署行为不变）');
  const local = hostCapabilities(standalone);
  assert.deepEqual(
    local.capabilities,
    LOCAL_CAPABILITIES,
    '独立模式六项能力全部自带',
  );
  assert.match(local.notes.join(''), /独立模式/, '独立模式要有一句可读的形态说明');

  const embedded = embeddedConfig({
    HOST_CREDENTIALS_URL: 'http://127.0.0.1:9999/credentials',
    HOST_BILLING_URL: 'http://127.0.0.1:9999/billing',
  });
  const caps = hostCapabilities(embedded);
  assert.equal(caps.capabilities.identity, true);
  assert.equal(caps.capabilities.credentials, true);
  assert.equal(caps.capabilities.billing, true);
  assert.equal(caps.capabilities.events, false, '没配事件回调 → 该项自带');
  assert.equal(caps.capabilities.theme, true, '内嵌形态的视觉令牌随宿主');
  assert.match(
    caps.notes.join(''),
    /未提供事件回调/,
    '降级必须明示原因（缺哪一项、回落到什么）',
  );

  assert.throws(
    () => configFrom({ HOST_MODE: 'nested' }),
    /HOST_MODE 取值非法/,
    '模式写错要 fail loud：静默按独立模式启动会让宿主以为接通了',
  );
  assert.throws(
    () => configFrom({ HOST_MODE: 'embedded', HOST_IDENTITY_VERIFY_URL: 'http://h/i' }),
    /HOST_SHARED_SECRET/,
    '内嵌模式缺共享密钥必须启动期报错',
  );
  assert.throws(
    () => configFrom({ HOST_MODE: 'embedded', HOST_SHARED_SECRET: SHARED_SECRET }),
    /HOST_IDENTITY_VERIFY_URL/,
    '内嵌模式缺身份验签地址必须启动期报错',
  );
  assert.throws(
    () => embeddedConfig({ HOST_ALLOWED_ORIGINS: '不是来源' }),
    /HOST_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () => embeddedConfig({ HOST_REQUEST_TIMEOUT_MS: '10' }),
    /HOST_REQUEST_TIMEOUT_MS/,
  );
  assert.throws(
    () => embeddedConfig({ HOST_USER_VIP_LEVEL: 'vip' }),
    /HOST_USER_VIP_LEVEL/,
  );

  const origins = embeddedConfig({
    HOST_ALLOWED_ORIGINS: `${HOST_ORIGIN},https://host.example.com/app`,
  });
  assert.deepEqual(
    origins.allowedOrigins,
    [HOST_ORIGIN, 'https://host.example.com'],
    'origin 白名单要归一成 origin（去掉路径）',
  );

  assert.equal(
    embeddedConfig({ HOST_BILLING_URL: 'http://127.0.0.1:9999/billing' }).hostUserVipLevel,
    'pro',
    '宿主承担计费 → 默认 pro（钱由宿主收，flow 的档位不该再拦节点）',
  );
  assert.equal(
    embeddedConfig().hostUserVipLevel,
    'free',
    '宿主不承担计费 → 默认 free（自带余额与档位照旧生效）',
  );
  assert.equal(
    embeddedConfig({ HOST_USER_VIP_LEVEL: 'enterprise' }).hostUserVipLevel,
    'enterprise',
  );
}

// ── 2. 独立 Provider（兜底实现常驻可用）─────────────────────────────────────

async function testStandaloneProviders() {
  const identity = new StandaloneIdentityProvider();
  await assert.rejects(
    () => identity.resolveIdentity('whatever'),
    /独立模式/,
    '独立模式下身份注入要明确拒绝，而不是给一个看不懂的 500',
  );

  const credentials = new StandaloneCredentialsProvider();
  assert.deepEqual(
    await credentials.resolveEngineCredentials(),
    { source: 'local' },
    '独立形态凭证回 local，消费方照旧读 .env',
  );

  const { service, calls } = billingDouble();
  const billing = new StandaloneBillingProvider(service);
  const frozen = await billing.freezeBalance('user-1', 1.5, 'run-1');
  assert.equal(frozen, 1.5);
  await billing.settleBilling('user-1', 1.5, 0.3, 'run-1', 'remark');
  await billing.refund('user-1', 1.5, 'run-1');
  assert.equal(billing.calculateCost(1000, 'deepseek-chat'), 0.25);
  assert.deepEqual(
    calls.map((call) => call.op),
    ['freeze', 'settle', 'refund', 'cost'],
    '独立 Provider 必须**逐参**转发到既有 BillingService（行为与改造前一致）',
  );
  assert.deepEqual(calls[0].args, ['user-1', 1.5, 'run-1']);

  const events = new StandaloneEventSink();
  await events.publish({
    runId: 'run-1',
    seq: 1,
    type: 'workflow_started',
    payload: {},
    at: new Date().toISOString(),
  });
  await events.flush();
}

// ── 3. 内嵌 Provider（对真实假宿主）─────────────────────────────────────────

async function testEmbeddedIdentity() {
  const host = await startFakeHost({
    '/identity': (body) => {
      if (body.token === 'good-token') {
        return { json: { subject: 'host-user-1', displayName: '宿主用户', email: 'u1@host.test' } };
      }
      return { status: 401, json: { error: 'unknown token' } };
    },
  });
  try {
    const config = embeddedConfig({ HOST_IDENTITY_VERIFY_URL: `${host.url}/identity` });
    const provider = new EmbeddedIdentityProvider(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );

    const identity = await provider.resolveIdentity('good-token');
    assert.deepEqual(identity, {
      subject: 'host-user-1',
      displayName: '宿主用户',
      email: 'u1@host.test',
    });
    assert.equal(host.requests.length, 1);
    assert.equal(
      host.requests[0].auth,
      `Bearer ${SHARED_SECRET}`,
      '回调宿主必须带共享密钥（否则宿主无法区分网关与陌生人）',
    );
    assert.equal(host.requests[0].protocol, 'v1', '必须带协议版本头');
    assert.equal(host.requests[0].path, '/identity');

    await assert.rejects(
      () => provider.resolveIdentity('bad-token'),
      /宿主返回 401/,
      '宿主拒绝时要带出状态与原因',
    );
    await assert.rejects(() => provider.resolveIdentity('   '), /缺少宿主令牌/);
    await assert.rejects(
      () => provider.resolveIdentity('x'.repeat(9 * 1024)),
      /宿主令牌过长/,
    );
  } finally {
    await host.close();
  }

  // 宿主响应的形状不对：不 `as` 硬吞，给可读错误
  const badHost = await startFakeHost({
    '/identity': () => ({ json: { subject: '' } }),
  });
  try {
    const config = embeddedConfig({ HOST_IDENTITY_VERIFY_URL: `${badHost.url}/identity` });
    const provider = new EmbeddedIdentityProvider(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );
    await assert.rejects(
      () => provider.resolveIdentity('any'),
      /不符合 ff-embed 契约/,
      '入站消息一律 schema 校验',
    );
  } finally {
    await badHost.close();
  }
}

async function testEmbeddedCredentials() {
  let credentialsCalls = 0;
  const host = await startFakeHost({
    '/credentials': () => {
      credentialsCalls += 1;
      return { json: { apiBase: 'http://127.0.0.1:5001/v1/', apiKey: 'app-hostkey0123456789', label: '宿主 BYOK' } };
    },
  });
  try {
    const config = embeddedConfig({ HOST_CREDENTIALS_URL: `${host.url}/credentials` });
    const provider = new EmbeddedCredentialsProvider(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );

    const first = await provider.resolveEngineCredentials();
    assert.deepEqual(first, {
      source: 'host',
      apiBase: 'http://127.0.0.1:5001/v1',
      apiKey: 'app-hostkey0123456789',
      label: '宿主 BYOK',
    });

    // 单飞 + 缓存：并发十次只打宿主一次
    await Promise.all(
      Array.from({ length: 10 }, () => provider.resolveEngineCredentials()),
    );
    assert.equal(credentialsCalls, 1, '凭证解析要有缓存与单飞（一次 run 会解析多次）');

    // 未配置回调 = 回落本地（缝缺失时降级）
    const noCallback = new EmbeddedCredentialsProvider(
      embeddedConfig(),
      new HostHttpClient(embeddedConfig()),
      hostCapabilities(embeddedConfig()).capabilities,
    );
    assert.deepEqual(await noCallback.resolveEngineCredentials(), { source: 'local' });
  } finally {
    await host.close();
  }

  // 宿主给了回调却出错：**不**静默回落本地 Key（那会用我们的钱办宿主的请求）
  const failing = await startFakeHost({
    '/credentials': () => ({ status: 503, json: { error: 'dify app not ready' } }),
  });
  try {
    const config = embeddedConfig({ HOST_CREDENTIALS_URL: `${failing.url}/credentials` });
    const provider = new EmbeddedCredentialsProvider(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );
    await assert.rejects(
      () => provider.resolveEngineCredentials(),
      /宿主返回 503.*dify app not ready/s,
      '宿主不可用要如实失败，并把宿主给的原因带出来',
    );
  } finally {
    await failing.close();
  }

  // 形状不对（缺 apiKey / apiBase 不是 http）
  const badShape = await startFakeHost({
    '/credentials': () => ({ json: { apiBase: 'file:///etc/passwd' } }),
  });
  try {
    const config = embeddedConfig({ HOST_CREDENTIALS_URL: `${badShape.url}/credentials` });
    const provider = new EmbeddedCredentialsProvider(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );
    await assert.rejects(() => provider.resolveEngineCredentials(), /不符合 ff-embed 契约/);
  } finally {
    await badShape.close();
  }
}

async function testEmbeddedBilling() {
  const host = await startFakeHost({
    '/billing': (body) => {
      if (body.op === 'reserve' && body.amount > 100) {
        return { status: 402, json: { error: '宿主额度不足' } };
      }
      return { json: { ok: true } };
    },
  });
  try {
    const config = embeddedConfig({ HOST_BILLING_URL: `${host.url}/billing` });
    const { service } = billingDouble();
    const provider = new EmbeddedBillingProvider(
      config,
      new HostHttpClient(config),
      service,
      hostCapabilities(config).capabilities,
      {
        // 假宿主侧标识解析：flow 用户 user-1 → 宿主 subject host-subject-1
        async findHostSubject(userId: string) {
          return userId === 'user-1' ? 'host-subject-1' : null;
        },
      },
    );

    const frozen = await provider.freezeBalance('user-1', 2.5, 'run-1');
    assert.equal(frozen, 2.5, '预扣返回冻结金额（与 BillingService 同语义）');
    await provider.settleBilling('user-1', 2.5, 0.7, 'run-1', 'Token: 100', {
      totalTokens: 100,
      model: 'deepseek-chat',
      engine: 'dify',
    });
    await provider.refund('user-1', 2.5, 'run-2');

    assert.deepEqual(
      host.requests.map((request) => request.body.op),
      ['reserve', 'settle', 'refund'],
    );
    assert.deepEqual(
      host.requests.map((request) => request.idempotencyKey),
      ['flow:run-1:reserve', 'flow:run-1:settle', 'flow:run-2:refund'],
      '幂等键固定为 flow:<runId>:<op>（宿主可安全重放）',
    );
    // 归属键：宿主按 hostSubject 解析账目归属（机器对机器回调不带会话令牌）
    assert.deepEqual(
      host.requests.map((request) => request.body.hostSubject),
      ['host-subject-1', 'host-subject-1', 'host-subject-1'],
      '三段回调都必须带宿主 subject',
    );
    assert.equal(host.requests[0].body.amount, 2.5);
    assert.equal(host.requests[1].body.actualCost, 0.7);
    assert.deepEqual(host.requests[1].body.usage, {
      totalTokens: 100,
      model: 'deepseek-chat',
      engine: 'dify',
    });
    assert.equal(host.requests[2].body.amount, 2.5);

    await assert.rejects(
      () => provider.freezeBalance('user-1', 999, 'run-3'),
      /宿主返回 402.*宿主额度不足/s,
      '宿主拒付要如实冒泡（run 必须失败，而不是偷偷用本地余额）',
    );

    // 没有宿主标识的用户：明确拒绝并说明原因（不把费用记到别人账上）
    await assert.rejects(
      () => provider.freezeBalance('user-without-subject', 1, 'run-4'),
      /没有宿主标识（hostSubject）/,
      '归属键缺失必须明确拒绝，而不是静默归到别人账上',
    );
  } finally {
    await host.close();
  }
}

async function testEmbeddedEvents() {
  const batches: any[][] = [];
  const host = await startFakeHost({
    '/events': (body) => {
      batches.push(body.events);
      return { json: { ok: true } };
    },
  });
  try {
    const config = embeddedConfig({ HOST_EVENTS_URL: `${host.url}/events` });
    const sink = new EmbeddedEventSink(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );

    for (let seq = 1; seq <= 24; seq += 1) {
      await sink.publish({
        runId: 'run-1',
        seq,
        type: 'node_finished',
        payload: { node_id: `n-${seq}` },
        at: new Date().toISOString(),
      });
    }
    assert.equal(batches.length, 0, '不足一批时先攒着（不把宿主打成一串单条请求）');

    await sink.flush();
    assert.equal(batches.length, 1, 'flush 立即外发');
    assert.equal(batches[0].length, 24);
    assert.deepEqual(
      batches[0].map((event) => event.seq),
      Array.from({ length: 24 }, (_, index) => index + 1),
      'seq 必须原样透出（宿主用它做断线重放）',
    );

    // 满批即发
    for (let seq = 25; seq <= 49; seq += 1) {
      await sink.publish({
        runId: 'run-1',
        seq,
        type: 'node_finished',
        payload: {},
        at: new Date().toISOString(),
      });
    }
    assert.equal(batches.length, 2, '攒满一批（25 条）立刻外发');
    assert.equal(batches[1].length, 25);
    await sink.flush();
  } finally {
    await host.close();
  }

  // 宿主事件通道挂了：旁路失败**不能**拖垮 run
  const failing = await startFakeHost({
    '/events': () => ({ status: 500, json: { error: 'channel down' } }),
  });
  try {
    const config = embeddedConfig({ HOST_EVENTS_URL: `${failing.url}/events` });
    const sink = new EmbeddedEventSink(
      config,
      new HostHttpClient(config),
      hostCapabilities(config).capabilities,
    );
    await sink.publish({
      runId: 'run-1',
      seq: 1,
      type: 'workflow_started',
      payload: {},
      at: new Date().toISOString(),
    });
    await sink.flush();
  } finally {
    await failing.close();
  }
}

async function main() {
  testConfig();
  await testStandaloneProviders();
  await testEmbeddedIdentity();
  await testEmbeddedCredentials();
  await testEmbeddedBilling();
  await testEmbeddedEvents();
  console.log(
    '宿主适配层 smoke 通过: 六缝 Definition + 独立/内嵌两套 Provider；'
    + '配置 fail loud、能力与降级原因可读、入站响应 schema 校验、'
    + '计费幂等键 flow:<runId>:<op>、凭证缓存单飞、事件带 seq 且失败不拖垮 run',
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
