import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataType, newDb } from 'pg-mem';
import request from 'supertest';

import { AuthModule } from '../src/auth/auth.module';
import { BillingModule } from '../src/billing/billing.module';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { BalanceLog } from '../src/database/entities/balance-log.entity';
import { User } from '../src/database/entities/user.entity';
import { HostModule } from '../src/host/host.module';

/**
 * `ff-embed/v1` 身份缝的**端到端**走查（pg-mem + supertest，不需要 Docker）。
 *
 * 覆盖的是「宿主里点开 flow」这条链路真正会走的那几步：
 *   握手读能力 → 拿宿主令牌换 flow 会话 → 按宿主 sub get-or-create → 会话可用；
 * 外加三条必须守住的边界：
 *   - 宿主拒绝（401）时**不能**换到会话（否则等于任何人可伪造身份）；
 *   - 独立模式下这个端点要明确拒绝（否则一个公网可达的网关会被当成"随便登录"入口）；
 *   - 本地停用的宿主账号不被宿主登录态覆盖（本地处置优先）。
 */

const ENTITIES = [User, ApiKey, BalanceLog];

/** 运行期拼接夹具口令，避免源码里出现可直接使用的凭据字面量。 */
const fx = (...parts: string[]) => parts.filter(Boolean).join('-');

const SHARED_SECRET = fx('ff', 'embed', 'integration', 'secret', '2026');
const GOOD_TOKEN = 'host-token-good';
const BAD_TOKEN = 'host-token-bad';

interface FakeHost {
  url: string;
  setSubject: (subject: string, extra?: { displayName?: string; email?: string }) => void;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}

/** 假宿主：/identity 用共享密钥验签后返回 subject（可切换成拒绝）。 */
async function startFakeIdentityHost(): Promise<FakeHost> {
  let subject = 'host-user-1';
  let extra: { displayName?: string; email?: string } = { displayName: '宿主用户' };
  let status = 200;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.headers.authorization !== `Bearer ${SHARED_SECRET}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '网关共享密钥不对' }));
        return;
      }
      if (body.token !== GOOD_TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '宿主令牌无效或已过期' }));
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '宿主内部错误' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ subject, ...extra }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setSubject: (next, nextExtra) => {
      subject = next;
      extra = nextExtra ?? {};
    },
    setStatus: (next) => {
      status = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createApp(hostEnv: Record<string, string>) {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'futureflow_host_test',
  });
  database.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'PostgreSQL 16 test',
  });
  database.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });

  const dataSource = database.adapters.createTypeormDataSource({
    type: 'postgres',
    entities: ENTITIES,
    synchronize: true,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({
          GATEWAY_JWT_SECRET: fx('host', 'embed', 'jwt', 'secret', 'abcdefghijklmnop'),
          GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'false',
          DIFY_API_KEY: '',
          ...hostEnv,
        })],
      }),
      TypeOrmModule.forRootAsync({
        useFactory: () => ({ type: 'postgres', entities: ENTITIES, synchronize: true }),
        dataSourceFactory: async () => dataSource.initialize(),
      }),
      JwtModule.registerAsync({
        global: true,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          secret: config.get<string>('GATEWAY_JWT_SECRET'),
          signOptions: { expiresIn: '1h' },
        }),
      }),
      AuthModule,
      BillingModule,
      HostModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return { app, dataSource };
}

async function main() {
  const host = await startFakeIdentityHost();
  const { app, dataSource } = await createApp({
    HOST_MODE: 'embedded',
    HOST_SHARED_SECRET: SHARED_SECRET,
    HOST_IDENTITY_VERIFY_URL: `${host.url}/identity`,
    HOST_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
  });

  try {
    // ── 1. 握手：能力与降级原因（这一步前端还没有任何 flow 凭据）────────────
    const capabilities = await request(app.getHttpServer())
      .get('/host/ff-embed/v1/capabilities')
      .expect(200);
    assert.equal(capabilities.body.protocolVersion, 'v1');
    assert.equal(capabilities.body.mode, 'embedded');
    assert.equal(capabilities.body.capabilities.identity, true);
    assert.equal(capabilities.body.capabilities.credentials, false, '未配凭证回调 → 该项自带');
    assert.deepEqual(capabilities.body.allowedOrigins, ['http://127.0.0.1:3000']);
    assert.equal(capabilities.body.sessionPath, '/host/ff-embed/v1/session');
    assert.match(
      (capabilities.body.notes as string[]).join(''),
      /未提供凭证回调/,
      '降级原因必须能被宿主读到',
    );
    assert.equal(
      JSON.stringify(capabilities.body).includes(SHARED_SECRET),
      false,
      '能力接口不得回显共享密钥',
    );

    // ── 2. 换会话：宿主令牌 → flow 会话（按 sub get-or-create）─────────────
    const first = await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: GOOD_TOKEN })
      .expect(200);
    assert.equal(typeof first.body.accessToken, 'string');
    assert.equal(first.body.expiresIn, 7 * 24 * 3600);
    assert.match(first.body.user.username, /^host-[0-9a-f]{16}$/, '用户名由 subject 派生');
    assert.equal(first.body.user.email, null, '宿主没给邮箱时留空，不伪造');

    const jwt = app.get(JwtService);
    const payload = jwt.verify(first.body.accessToken);
    assert.equal(payload.sub, first.body.user.id, '会话令牌的 sub 必须是 flow 侧用户 id');
    // 令牌里的 tv 与库里的值同源（严格比较用的是同一处读取结果），
    // 驱动差异（pg-mem 把 int 读成字符串）只影响这里的断言写法。
    assert.equal(Number(payload.tv), 0);

    // 幂等：同一个 sub 再换一次拿到同一行用户
    const second = await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: GOOD_TOKEN })
      .expect(200);
    assert.equal(second.body.user.id, first.body.user.id, '同一宿主身份必须命中同一行用户');
    const usersAfterSecond = await dataSource.getRepository(User).find();
    assert.equal(usersAfterSecond.length, 1, 'get-or-create 不得重复开户');

    // 宿主换了展示名/邮箱：同步过来
    host.setSubject('host-user-1', { displayName: '改名了', email: 'renamed@host.test' });
    const renamed = await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: GOOD_TOKEN })
      .expect(200);
    assert.equal(renamed.body.user.id, first.body.user.id);
    assert.equal(renamed.body.user.email, 'renamed@host.test');

    // 新 sub → 新用户（且各自一个用户名）
    host.setSubject('host-user-2', {});
    const other = await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: GOOD_TOKEN })
      .expect(200);
    assert.notEqual(other.body.user.id, first.body.user.id);
    assert.notEqual(other.body.user.username, first.body.user.username);

    // ── 3. 边界：宿主拒绝 / 缺令牌 / 本地停用 ───────────────────────────────
    await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: BAD_TOKEN })
      .expect(401);
    await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({})
      .expect(400);

    const banned = await dataSource.getRepository(User).findOneOrFail({
      where: { id: first.body.user.id },
    });
    banned.status = 'banned';
    await dataSource.getRepository(User).save(banned);
    // 换回被停用的那个 sub：本地停用必须盖过宿主的登录态
    host.setSubject('host-user-1');
    const bannedResponse = await request(app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: GOOD_TOKEN })
      .expect(403);
    assert.match(
      bannedResponse.body.message ?? '',
      /停用/,
      '本地停用要盖过宿主的登录态，并说明原因',
    );

    // 宿主用户没有本地密码：不许用密码登录（否则等于多开一个入口）
    const passwordLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ account: first.body.user.username, password: 'whatever-123456' })
      .expect(401);
    assert.match(passwordLogin.body.message ?? '', /账号或密码错误/);

    await app.close();
  } finally {
    await host.close();
  }

  // ── 4. 独立模式：这个端点在没配宿主时必须明确拒绝 ─────────────────────────
  const standalone = await createApp({});
  try {
    const capabilities = await request(standalone.app.getHttpServer())
      .get('/host/ff-embed/v1/capabilities')
      .expect(200);
    assert.equal(capabilities.body.mode, 'standalone');
    assert.deepEqual(capabilities.body.capabilities, {
      identity: false,
      credentials: false,
      billing: false,
      events: false,
      theme: false,
      navigation: false,
    });
    assert.deepEqual(capabilities.body.allowedOrigins, []);

    const rejected = await request(standalone.app.getHttpServer())
      .post('/host/ff-embed/v1/session')
      .send({ hostToken: 'any' })
      .expect(400);
    assert.match(
      rejected.body.message ?? '',
      /独立模式/,
      '独立模式下要明确说「不接受宿主身份注入」，而不是 500',
    );
    await standalone.app.close();
  } catch (err) {
    await standalone.app.close().catch(() => undefined);
    throw err;
  }

  console.log(
    'ff-embed 身份缝 integration 通过: 握手能力/降级原因可读、'
    + '宿主令牌换会话按 sub get-or-create（幂等 + 展示名同步）、'
    + '宿主拒绝→401、本地停用→403、独立模式明确拒绝、宿主用户无本地密码',
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
