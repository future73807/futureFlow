import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MediaCredentialCrypto } from '../src/media/media-credential.crypto';
import { MediaCredentialService } from '../src/media/media-credential.service';
import {
  detectMedia,
  isPublicIpAddress,
  MediaAssetService,
  resolvePublicAddress,
} from '../src/media/media-asset.service';
import { MediaJobService } from '../src/media/media-job.service';
import { ProviderHttpClient } from '../src/media/provider-http.client';
import { OpenAiMediaAdapter } from '../src/media/providers/openai.adapter';
import { GoogleMediaAdapter } from '../src/media/providers/google.adapter';
import { DoubaoMediaAdapter } from '../src/media/providers/doubao.adapter';
import { MiniMaxMediaAdapter } from '../src/media/providers/minimax.adapter';
import {
  CreateMediaCredentialDto,
  GenerateImageDto,
  GenerateVideoDto,
} from '../src/media/dto/media.dto';
import type { ProviderJsonRequest } from '../src/media/media.types';
import { MediaExecutionGuard, MediaExecutionScope } from '../src/media/media-execution.guard';
import { JwtAuthGuard } from '../src/auth/jwt.guard';

const KEY = 'provider-test-key-do-not-leak-0123456789';

class FixtureTransport {
  readonly requests: ProviderJsonRequest[] = [];
  constructor(private readonly fixtures: unknown[]) {}
  async requestJson<T>(request: ProviderJsonRequest): Promise<T> {
    this.requests.push(request);
    if (!this.fixtures.length) throw new Error('fixture exhausted');
    return this.fixtures.shift() as T;
  }
}

async function providerContracts() {
  const openaiHttp = new FixtureTransport([
    { data: [{ b64_json: 'iVBORw0KGgo=' }] },
    { id: 'video_openai_1', status: 'queued' },
    { id: 'video_openai_1', status: 'completed' },
  ]);
  const openai = new OpenAiMediaAdapter(openaiHttp as any);
  assert.equal((await openai.createImage(KEY, { model: 'gpt-image-1', prompt: '猫' })).type, 'base64');
  assert.equal((await openai.createVideo(KEY, {
    model: 'sora-2', prompt: '海面', durationSeconds: 8, size: '1280x720',
  })).taskId, 'video_openai_1');
  const openaiDone = await openai.getVideoStatus(KEY, 'video_openai_1');
  assert.equal(openaiDone.status, 'succeeded');
  assert.match((openaiDone.source as any).url, /\/content$/);
  const openaiForm = openaiHttp.requests[1].formData!;
  assert.equal(openaiForm.get('seconds'), '8');
  assert.equal(openaiHttp.requests.filter((item) => item.method === 'POST').length, 2);

  const googleHttp = new FixtureTransport([
    { steps: [{ type: 'model_output', content: [{ type: 'image', data: 'iVBORw0KGgo=', mime_type: 'image/png' }] }] },
    { steps: [{ type: 'model_output', content: [{ type: 'image', uri: 'https://generativelanguage.googleapis.com/downloads/image-1', mime_type: 'image/png' }] }] },
    { name: 'operations/veo-123' },
    { done: false },
    { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/downloads/video-1' } }] } } },
  ]);
  const google = new GoogleMediaAdapter(googleHttp as any);
  assert.equal((await google.createImage(KEY, {
    model: 'gemini-image', prompt: '山水', aspectRatio: '16:9', size: '2K',
  })).type, 'base64');
  assert.deepEqual(googleHttp.requests[0].body, {
    model: 'gemini-image',
    input: [{ type: 'text', text: '山水' }],
    response_format: {
      type: 'image', mime_type: 'image/png', aspect_ratio: '16:9', image_size: '2K',
    },
  });
  const googleImageUri = await google.createImage(KEY, { model: 'gemini-image', prompt: '下载图片' });
  assert.equal(googleImageUri.type, 'url');
  assert.deepEqual((googleImageUri as any).headers, { 'x-goog-api-key': KEY });
  assert.equal((await google.createVideo(KEY, { model: 'veo-3.0', prompt: '山水' })).taskId, 'operations/veo-123');
  assert.equal((await google.getVideoStatus(KEY, 'operations/veo-123')).status, 'processing');
  const googleVideo = await google.getVideoStatus(KEY, 'operations/veo-123');
  assert.equal(googleVideo.status, 'succeeded');
  assert.deepEqual((googleVideo.source as any).headers, { 'x-goog-api-key': KEY });
  assert.equal(new URL(googleHttp.requests[0].url).origin, 'https://generativelanguage.googleapis.com');

  const doubaoHttp = new FixtureTransport([
    { data: [{ url: 'https://cdn.example/image.png' }] },
    { id: 'doubao-task-1' },
    { status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } },
  ]);
  const doubao = new DoubaoMediaAdapter(doubaoHttp as any);
  assert.equal((await doubao.createImage(KEY, { model: 'seedream', prompt: '花' })).type, 'url');
  assert.equal((await doubao.createVideo(KEY, { model: 'seedance', prompt: '花' })).taskId, 'doubao-task-1');
  assert.equal((await doubao.getVideoStatus(KEY, 'doubao-task-1')).status, 'succeeded');
  assert.ok(doubaoHttp.requests.every((item) => new URL(item.url).origin === 'https://ark.cn-beijing.volces.com'));

  const minimaxHttp = new FixtureTransport([
    { data: { image_urls: ['https://cdn.example/image.png'] } },
    { task_id: 'minimax-task-1' },
    { task: { status: 'success', content: { url: 'https://cdn.example/video.mp4' } } },
  ]);
  const minimax = new MiniMaxMediaAdapter(minimaxHttp as any);
  assert.equal((await minimax.createImage(KEY, { model: 'image-01', prompt: '城市' })).type, 'url');
  assert.equal((await minimax.createVideo(KEY, {
    model: 'MiniMax-H3', prompt: '城市', resolution: '2K', durationSeconds: 5, aspectRatio: '9:16',
  })).taskId, 'minimax-task-1');
  assert.deepEqual(minimaxHttp.requests[1].body, {
    model: 'MiniMax-H3',
    content: [{ type: 'text', text: '城市' }],
    resolution: '2K',
    duration: 5,
    ratio: '9:16',
  });
  await assert.rejects(
    () => minimax.createVideo(KEY, { model: 'MiniMax-H3', prompt: '城市', durationSeconds: 3 }),
    /provider_rejected/,
  );
  assert.equal((await minimax.getVideoStatus(KEY, 'minimax-task-1')).status, 'succeeded');
  assert.ok(minimaxHttp.requests.every((item) => new URL(item.url).origin === 'https://api.minimaxi.com'));

  for (const transport of [openaiHttp, googleHttp, doubaoHttp, minimaxHttp]) {
    for (const request of transport.requests) {
      assert.doesNotMatch(JSON.stringify(request.body || {}), new RegExp(KEY));
      assert.ok(['GET', 'POST'].includes(request.method));
    }
  }
}

async function outboundSafety() {
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  for (const address of [
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1',
    '::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1', 'fd00::1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  await assert.rejects(() => resolvePublicAddress('localhost'));
  await assert.rejects(() => resolvePublicAddress('mixed.example', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.2', family: 4 },
  ]));

  const client = new ProviderHttpClient(new ConfigService({ MEDIA_PROVIDER_TIMEOUT_MS: '1000' }));
  await assert.rejects(
    () => client.requestJson({
      provider: 'openai', method: 'GET', url: 'https://attacker.example/v1/videos/1', headers: {},
    }),
    /provider_http_error/,
  );
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new Error(`network failure ${KEY}`);
  }) as any;
  try {
    await assert.rejects(() => client.requestJson({
      provider: 'openai', method: 'POST', url: 'https://api.openai.com/v1/images/generations',
      headers: { authorization: `Bearer ${KEY}` }, body: { prompt: 'x' },
    }), /provider_http_error/);
    assert.equal(attempts, 1, 'billable POST must not be retried');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function encryptedTenantCredentials() {
  const crypto = new MediaCredentialCrypto(new ConfigService({
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: 'media-test-encryption-secret-at-least-32-characters',
  }));
  const rows: any[] = [];
  const repo: any = {
    create: (value: any) => ({ ...value }),
    save: async (value: any) => {
      value.createdAt ||= new Date();
      value.updatedAt ||= new Date();
      rows.push(value);
      return value;
    },
    find: async ({ where }: any) => rows.filter((row) => row.userId === where.userId),
  };
  const service = new MediaCredentialService(repo, {} as any, crypto);
  const publicRow = await service.create('user-a', {
    provider: 'openai', label: '主账号', apiKey: KEY,
  });
  assert.deepEqual(Object.keys(publicRow).sort(), [
    'createdAt', 'fingerprint', 'id', 'label', 'provider', 'updatedAt',
  ]);
  assert.doesNotMatch(JSON.stringify(publicRow), new RegExp(KEY));
  assert.match(rows[0].encryptedApiKey, /^v1:/);
  assert.doesNotMatch(rows[0].encryptedApiKey, new RegExp(KEY));
  assert.equal(crypto.decrypt(rows[0].encryptedApiKey, {
    userId: 'user-a', provider: 'openai', credentialId: rows[0].id,
  }), KEY);
  assert.throws(() => crypto.decrypt(rows[0].encryptedApiKey, {
    userId: 'user-b', provider: 'openai', credentialId: rows[0].id,
  }));
  assert.equal((await service.list('user-b')).length, 0, 'credential list must be tenant scoped');
}

async function privateAssets() {
  const root = await mkdtemp(join(tmpdir(), 'futureflow-media-test-'));
  const rows: any[] = [];
  const repo: any = {
    findOne: async ({ where }: any) => rows.find((row) => row.userId === where.userId && row.jobId === where.jobId) || null,
    create: (value: any) => ({ ...value }),
    save: async (value: any) => { rows.push(value); return value; },
  };
  const service = new MediaAssetService(repo, new ConfigService({
    MEDIA_ASSET_ROOT: root,
    MEDIA_IMAGE_MAX_BYTES: '1024',
  }));
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
    const asset = await service.persist('11111111-1111-4111-8111-111111111111', 'job-1', 'image', {
      type: 'base64', data: png.toString('base64'), mimeType: 'text/html',
    });
    assert.equal(asset.mimeType, 'image/png', 'magic bytes, not declared MIME, determine type');
    assert.equal((await readFile(join(root, asset.localPath))).equals(png), true);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(png.toString('base64')));
    await assert.rejects(() => service.persist(
      '11111111-1111-4111-8111-111111111111', 'job-2', 'image',
      { type: 'url', url: 'https://169.254.169.254/latest/meta-data' },
    ));
    assert.equal(detectMedia(Buffer.from('<svg><script>')), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function idempotencyAndNoPersistenceLeak() {
  const stored: any[] = [];
  const repo: any = {
    findOne: async ({ where }: any) => stored.find((row) => (
      (where.id ? row.id === where.id : true)
      && row.userId === where.userId
      && (where.idempotencyKey ? row.idempotencyKey === where.idempotencyKey : true)
    )) || null,
    create: (value: any) => ({ id: `job-${stored.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...value }),
    save: async (value: any) => {
      value.updatedAt = new Date();
      if (!stored.includes(value)) stored.push(value);
      return value;
    },
  };
  let creates = 0;
  const provider = {
    createImage: async () => { creates += 1; return { type: 'base64', data: 'iVBORw0KGgo=' }; },
    createVideo: async () => ({ taskId: 'provider-video-1', status: 'queued' }),
  };
  const service = new MediaJobService(
    repo,
    { decryptOwned: async () => ({ id: 'credential-1', provider: 'openai', apiKey: KEY }) } as any,
    { get: () => provider } as any,
    {
      persist: async () => ({ id: 'asset-1' }),
      findByJob: async () => null,
    } as any,
  );
  const dto = plainToInstance(GenerateImageDto, {
    credentialId: '11111111-1111-4111-8111-111111111111',
    model: 'gpt-image-1', prompt: '不可持久化的提示词', size: '1024x1024',
  });
  const scope: MediaExecutionScope = {
    workflowId: '22222222-2222-4222-8222-222222222222',
    workflowVersion: 3,
    runId: '33333333-3333-4333-8333-333333333333',
    credentialIds: [dto.credentialId],
  };
  const first = await service.generateImage('user-a', 'idem-key-0001', dto, scope);
  const second = await service.generateImage('user-a', 'idem-key-0001', dto, scope);
  assert.equal(first.assetId, 'asset-1');
  assert.equal(second.assetId, 'asset-1');
  assert.equal(creates, 1, 'same idempotency key must create at most once');
  assert.equal(stored[0].executionRunId, scope.runId);
  assert.doesNotMatch(JSON.stringify(stored), /不可持久化的提示词|provider-test-key|iVBORw0KGgo/);
  await assert.rejects(
    () => service.generateImage('user-a', 'idem-key-0001', { ...dto, prompt: 'different' } as any, scope),
    ConflictException,
  );
  await assert.rejects(
    () => service.getAndPoll('user-a', stored[0].id, { ...scope, runId: '44444444-4444-4444-8444-444444444444' }),
    /媒体任务不存在/,
  );
  const videoDto = plainToInstance(GenerateVideoDto, {
    credentialId: dto.credentialId,
    model: 'MiniMax-H3',
    prompt: '不持久化的视频提示词',
    resolution: '768P',
    durationSeconds: 5,
    aspectRatio: '16:9',
  });
  await service.generateVideo('user-a', 'idem-key-0002', videoDto, scope);
  await assert.rejects(
    () => service.generateVideo('user-a', 'idem-key-0002', { ...videoDto, resolution: '2K' } as any, scope),
    ConflictException,
    '视频分辨率必须参与幂等请求哈希',
  );
}

async function executionTokenScope() {
  const jwt = new JwtService({ secret: 'media-execution-jwt-secret-at-least-32-characters' });
  const userId = '11111111-1111-4111-8111-111111111111';
  const credentialId = '22222222-2222-4222-8222-222222222222';
  const payload = {
    sub: userId,
    type: 'media_execution',
    workflowId: '33333333-3333-4333-8333-333333333333',
    workflowVersion: 2,
    runId: '44444444-4444-4444-8444-444444444444',
    credentialIds: [credentialId],
  };
  const token = jwt.sign(payload, { expiresIn: '15m' });
  const ordinary = jwt.sign({ sub: userId });
  const auth: any = { validateJwtPayload: async (claims: any) => ({ id: claims.sub }) };
  const guard = new MediaExecutionGuard(jwt, auth);
  const context = (request: any) => ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as any;

  const createRequest: any = {
    method: 'POST', originalUrl: '/media/images/generate',
    headers: { authorization: `Bearer ${token}` }, body: { credentialId },
  };
  assert.equal(await guard.canActivate(context(createRequest)), true);
  assert.equal(createRequest.mediaExecution.runId, payload.runId);

  await assert.rejects(() => guard.canActivate(context({
    method: 'POST', originalUrl: '/media/images/generate',
    headers: { authorization: `Bearer ${token}` },
    body: { credentialId: '55555555-5555-4555-8555-555555555555' },
  })), /授权范围/);
  await assert.rejects(() => guard.canActivate(context({
    method: 'GET', originalUrl: '/media/credentials',
    headers: { authorization: `Bearer ${token}` },
  })), /无权访问/);
  assert.equal(await guard.canActivate(context({
    method: 'GET', originalUrl: '/media/credentials',
    headers: { authorization: `Bearer ${ordinary}` },
  })), true);

  const ordinaryGuard = new JwtAuthGuard(jwt, auth);
  await assert.rejects(() => ordinaryGuard.canActivate(context({
    headers: { authorization: `Bearer ${token}` },
  })), /媒体执行令牌不能访问/);
}

function strictDtos() {
  const dto = plainToInstance(CreateMediaCredentialDto, {
    provider: 'openai', label: 'key', apiKey: KEY, unexpected: 'no',
  });
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  assert.ok(errors.some((error) => error.property === 'unexpected'));

  const automatic = plainToInstance(GenerateVideoDto, {
    credentialId: '11111111-1111-4111-8111-111111111111',
    model: 'MiniMax-H3',
    prompt: '自动参数不应传给供应商',
    size: 'auto',
    aspectRatio: 'auto',
    resolution: 'auto',
    durationSeconds: 5,
  });
  assert.equal(validateSync(automatic).length, 0);
  assert.equal(automatic.size, undefined);
  assert.equal(automatic.aspectRatio, undefined);
  assert.equal(automatic.resolution, undefined);
}

async function main() {
  await providerContracts();
  await outboundSafety();
  await encryptedTenantCredentials();
  await privateAssets();
  await idempotencyAndNoPersistenceLeak();
  await executionTokenScope();
  strictDtos();
  console.log('media provider/security smoke passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
