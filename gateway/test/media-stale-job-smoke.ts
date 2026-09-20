import assert from 'node:assert/strict';

import { DataType, newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';

import { MediaJobService } from '../src/media/media-job.service';
import { MediaAssetService } from '../src/media/media-asset.service';
import { MediaCredentialService } from '../src/media/media-credential.service';
import { MediaJob } from '../src/database/entities/media-job.entity';
import { MediaAsset } from '../src/database/entities/media-asset.entity';
import { MediaCredential } from '../src/database/entities/media-credential.entity';
import { User } from '../src/database/entities/user.entity';

/**
 * 媒体任务残留对账回归。
 *
 * 背景：流程是 `claim()` 建 `creating` 记录 → 调供应商 → 持久化资产并置终态。进程若
 * 在建好记录之后、置终态之前死亡，任务会永远停在非终态；而 `claim()` 对同一幂等键
 * 返回已存在任务、`reconcileAsset()` 又只在资产已存在时才补记成功 —— 于是任务永远
 * 「生成中」，且**用同一幂等键重试只会拿回同一个卡住的任务，无法重试**。
 *
 * 用 pg-mem 跑真实 schema 与真实 `MediaJobService`，验证：
 *   - 卡在 creating/queued/processing 且超阈值的任务被标记 failed（明确终态）
 *   - **资产其实已落库的任务应被补记为 succeeded，而不是误判失败**（最关键）
 *   - 未超阈值的进行中任务不被误伤
 *   - 已终态（succeeded/failed）的历史任务不动
 */
async function main() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  for (const [name, value] of [
    ['current_database', 'futureflow_test'],
    ['version', 'PostgreSQL 16 test'],
  ] as const) {
    database.public.registerFunction({
      name,
      returns: DataType.text,
      implementation: () => value,
    });
  }
  database.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });

  const dataSource = database.adapters.createTypeormDataSource({
    type: 'postgres',
    entities: [User, MediaJob, MediaAsset, MediaCredential],
    synchronize: true,
  });
  await dataSource.initialize();

  const assetService = new MediaAssetService(
    dataSource.getRepository(MediaAsset),
    { get: () => undefined } as any,
  );
  const service = new MediaJobService(
    dataSource.getRepository(MediaJob),
    null as unknown as MediaCredentialService,
    null as any,
    assetService,
  );
  const logger = (service as any).logger as Logger;
  logger.warn = () => {};
  logger.error = () => {};
  logger.log = () => {};

  let seq = 0;

  const makeUser = async () =>
    dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        username: `media-stale-${Date.now()}-${seq}`,
        email: `media-stale-${Date.now()}-${seq++}@example.test`,
        passwordHash: 'x'.repeat(32),
        role: 'user',
        balance: 100,
        frozenBalance: 0,
      }),
    );

  /** 建一个媒体任务并把 updatedAt 拨到 minutesAgo 分钟前。 */
  const makeJob = async (
    userId: string,
    status: MediaJob['status'],
    minutesAgo: number,
  ) => {
    const saved = await dataSource.getRepository(MediaJob).save(
      dataSource.getRepository(MediaJob).create({
        userId,
        provider: 'openai',
        kind: 'image',
        idempotencyKey: `k-${randomUUID()}`,
        requestHash: 'hash',
        model: 'gpt-image-1',
        status,
        providerTaskId: null,
        assetId: null,
        errorCode: null,
        completedAt: null,
      }),
    );
    await dataSource.query(
      'UPDATE media_jobs SET "updatedAt" = $1 WHERE id = $2',
      [new Date(Date.now() - minutesAgo * 60_000), saved.id],
    );
    return saved.id;
  };

  const statusOf = async (id: string) =>
    (await dataSource.getRepository(MediaJob).findOne({ where: { id } }))?.status;
  const errorCodeOf = async (id: string) =>
    (await dataSource.getRepository(MediaJob).findOne({ where: { id } }))?.errorCode;

  // ── 场景 1：超阈值的 creating 任务被标记失败（给出明确终态）──────
  {
    const user = await makeUser();
    const jobId = await makeJob(user.id, 'creating', 60);
    const result = await service.sweepStaleJobs(30);
    assert.ok(result.failed >= 1, `应至少标记失败 1 条，实际 ${result.failed}`);
    assert.equal(await statusOf(jobId), 'failed', '卡住的任务应变为 failed');
    assert.equal(await errorCodeOf(jobId), 'job_stale_timeout', '应给出可识别的错误码');
  }

  // ── 场景 2（最关键）：资产已落库的任务应补记为 succeeded ─────────
  // 进程在「供应商已完成、资产已持久化」之后死亡，只差把任务置为 succeeded。
  // 这种任务不该被判失败——否则用户白花了钱还拿不到结果。
  {
    const user = await makeUser();
    const jobId = await makeJob(user.id, 'processing', 60);
    const asset = await dataSource.getRepository(MediaAsset).save(
      dataSource.getRepository(MediaAsset).create({
        userId: user.id,
        jobId,
        mimeType: 'image/png',
        sizeBytes: '1024',
        sha256: 'a'.repeat(64),
        fileName: `stale-${jobId}.png`,
        localPath: `stale/${jobId}.png`,
      }),
    );
    assert.ok(asset?.id, '测试前置：资产应已落库');

    const result = await service.sweepStaleJobs(30);
    assert.ok(result.recovered >= 1, `应至少补记成功 1 条，实际 ${result.recovered}`);
    assert.equal(await statusOf(jobId), 'succeeded', '有资产的任务必须补记为成功，不能判失败');
  }

  // ── 场景 3：未超阈值的进行中任务不被误伤 ─────────────────────────
  {
    const user = await makeUser();
    const jobId = await makeJob(user.id, 'processing', 1); // 1 分钟前，远未超阈值
    await service.sweepStaleJobs(30);
    assert.equal(
      await statusOf(jobId),
      'processing',
      '进行中的任务不能被误判失败（否则会打断正在生成的视频）',
    );
  }

  // ── 场景 4：已终态的历史任务不受影响 ─────────────────────────────
  {
    const user = await makeUser();
    const okId = await makeJob(user.id, 'succeeded', 120);
    const badId = await makeJob(user.id, 'failed', 120);
    await service.sweepStaleJobs(30);
    assert.equal(await statusOf(okId), 'succeeded', '已成功的历史任务不应被改动');
    assert.equal(await statusOf(badId), 'failed', '已失败的历史任务不应被改动');
  }

  // ── 场景 5：queued（视频排队中）超阈值同样回收 ───────────────────
  {
    const user = await makeUser();
    const jobId = await makeJob(user.id, 'queued', 90);
    await service.sweepStaleJobs(30);
    assert.equal(
      await statusOf(jobId),
      'failed',
      'queued 卡住同样要给出终态，否则界面永远「排队中」',
    );
  }

  // ── 场景 6：重复扫描幂等，不重复计数 ────────────────────────────
  {
    const user = await makeUser();
    await makeJob(user.id, 'creating', 60);
    const first = await service.sweepStaleJobs(30);
    assert.ok(first.failed >= 1);
    const second = await service.sweepStaleJobs(30);
    assert.equal(second.failed, 0, '第二轮不应再次认领已终态的任务');
  }

  await dataSource.destroy();
  console.log(
    'media stale job tests passed: 标记失败 / 资产补记成功 / 不误伤进行中 / 不动历史 / queued 同回收 / 重复扫描幂等',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
