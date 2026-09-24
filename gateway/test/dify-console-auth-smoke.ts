import 'reflect-metadata';

import assert from 'node:assert/strict';

import { DifyIntegrationService } from '../src/dify/dify-integration.service';

/**
 * Dify Console 登录适配的离线回归（不连网、不起 Nest）。
 *
 * 背景（真机实测，1.17.1）：Dify ≥1.17 的 console 登录把口令改为 **base64 传输**，
 * 令牌改为 **HttpOnly Cookie**（响应体 `data=null`），并在**每个** console 请求上校验
 * CSRF——头 `X-CSRF-Token` 与 cookie `csrf_token` **必须同时给出且相等**，缺一即
 * 401「CSRF token is missing or invalid」。
 *
 * 这组用例把三件事钉死（否则升级一次 Dify 就得从头再踩一遍）：
 *  ① 登录请求发的是 **base64(明文口令)**，不是明文；
 *  ② 登录响应的 Set-Cookie 被解析并记住（access_token / csrf_token）；
 *  ③ 后续 console 请求同时带 **Cookie 会话** 与 **X-CSRF-Token 头**。
 *
 * 同时保留旧版回退：登录 401 且响应体无 token 时，改用明文口令重试一次。
 */

const fx = (...parts: string[]) => parts.filter(Boolean).join('-');
const ENCRYPTION_SECRET = fx('futureflow', 'console', 'auth', 'test', 'secret', '32');
const CONSOLE_BASE = 'http://dify.test/console/api';
const PASSWORD = fx('admin', 'pw', '0421');

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StubOptions {
  /** 旧版行为：登录只认明文口令（第一次 base64 请求回 401）。 */
  legacyPlaintextLogin?: boolean;
}

function installFetchStub(options: StubOptions = {}) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  let loginAttempts = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    });

    if (url === `${CONSOLE_BASE}/login`) {
      loginAttempts += 1;
      const sent = (rawBody ? JSON.parse(rawBody) : {}) as { password?: string };
      const expected = Buffer.from(PASSWORD, 'utf8').toString('base64');
      if (options.legacyPlaintextLogin && sent.password !== PASSWORD) {
        return new Response(JSON.stringify({ code: 'authentication_failed' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!options.legacyPlaintextLogin && sent.password !== expected) {
        throw new Error(`登录口令必须是 base64（收到 ${String(sent.password)}）`);
      }
      const headersBag = new Headers({ 'content-type': 'application/json' });
      if (!options.legacyPlaintextLogin) {
        headersBag.append('set-cookie', 'access_token=cookie-access-token; Path=/; HttpOnly');
        headersBag.append('set-cookie', 'csrf_token=csrf-token-1; Path=/');
      }
      // 旧版 Dify：令牌在响应体（data.access_token），且没有 cookie/CSRF 这套
      const payload = options.legacyPlaintextLogin
        ? { data: { access_token: 'legacy-body-token', refresh_token: 'legacy-refresh' } }
        : { result: 'success', data: null };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: headersBag,
      });
    }

    // 授权校验与后续 console 调用：返回空列表即可（够 assert 头形状）
    if (url.startsWith(`${CONSOLE_BASE}/apps`)) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
  }) as typeof fetch;

  return {
    requests,
    loginAttempts: () => loginAttempts,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function createService() {
  const saved: unknown[] = [];
  const repository = {
    find: async () => [],
    findOne: async () => null,
    create: (value: unknown) => value,
    save: async (value: unknown) => {
      saved.push(value);
      return value;
    },
    update: async () => undefined,
  };
  const env: Record<string, string> = {
    DIFY_CONSOLE_BASE: CONSOLE_BASE,
    DIFY_KEY_ENCRYPTION_SECRET: ENCRYPTION_SECRET,
    DIFY_SYNC_LLM_PROVIDER: 'false',
  };
  const config = {
    get: (key: string, fallback = '') => env[key] ?? fallback,
  };
  return { service: new DifyIntegrationService(repository as never, config as never), saved };
}

async function testModernLogin() {
  const stub = installFetchStub();
  try {
    const { service } = createService();
    await service.bootstrap({
      email: 'admin@dify.test',
      password: PASSWORD,
      consoleBase: CONSOLE_BASE,
    });

    const login = stub.requests.find((request) => request.url.endsWith('/login'));
    assert.ok(login, '应发起登录请求');
    assert.equal(
      (login!.body as { password?: string }).password,
      Buffer.from(PASSWORD, 'utf8').toString('base64'),
      '口令必须 base64 传输（Dify ≥1.17 的 FieldEncryption 只做 base64 解码）',
    );

    const probe = stub.requests.find((request) =>
      request.url.startsWith(`${CONSOLE_BASE}/apps`),
    );
    assert.ok(probe, '登录后应探测 Console 授权（GET /apps）');
    assert.match(
      probe!.headers.cookie ?? '',
      /access_token=cookie-access-token/,
      '后续请求必须带会话 cookie（1.17 起令牌在 HttpOnly cookie 里，响应体 data=null）',
    );
    assert.equal(
      probe!.headers['x-csrf-token'],
      'csrf-token-1',
      '后续请求必须带 X-CSRF-Token（与 cookie 同名值，服务端两处比对）',
    );
    assert.match(probe!.headers.cookie ?? '', /csrf_token=csrf-token-1/);
    assert.equal(stub.loginAttempts(), 1, 'base64 登录一次即成，不应触发明文回退');
  } finally {
    stub.restore();
  }
}

async function testLegacyPlaintextFallback() {
  const stub = installFetchStub({ legacyPlaintextLogin: true });
  try {
    const { service } = createService();
    await service.bootstrap({
      email: 'admin@dify.test',
      password: PASSWORD,
      consoleBase: CONSOLE_BASE,
    });
    assert.equal(stub.loginAttempts(), 2, '旧版 Dify 应回退到明文口令重试一次');

    const okLogin = stub.requests
      .filter((request) => request.url.endsWith('/login'))
      .at(-1);
    assert.equal(
      (okLogin!.body as { password?: string }).password,
      PASSWORD,
      '回退路径发的是明文口令',
    );
  } finally {
    stub.restore();
  }
}

async function main() {
  await testModernLogin();
  console.log('Dify Console 登录适配 smoke 通过: base64 口令、Set-Cookie 会话解析、X-CSRF-Token 头');
  await testLegacyPlaintextFallback();
  console.log('Dify Console 登录旧版回退 smoke 通过: base64 401 → 明文重试一次');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
