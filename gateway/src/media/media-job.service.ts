import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { MediaJob, MediaKind } from '../database/entities/media-job.entity';
import { GenerateImageDto, GenerateVideoDto } from './dto/media.dto';
import { MediaAssetService } from './media-asset.service';
import { MediaCredentialService } from './media-credential.service';
import { ProviderContractError } from './media.types';
import { ProviderRegistry } from './providers/provider-registry.service';
import type { MediaExecutionScope } from './media-execution.guard';

@Injectable()
export class MediaJobService {
  private readonly logger = new Logger(MediaJobService.name);

  constructor(
    @InjectRepository(MediaJob)
    private readonly jobs: Repository<MediaJob>,
    private readonly credentials: MediaCredentialService,
    private readonly providers: ProviderRegistry,
    private readonly assets: MediaAssetService,
  ) {}

  async generateImage(
    userId: string,
    idempotencyKey: string,
    dto: GenerateImageDto,
    scope?: MediaExecutionScope,
  ) {
    const credential = await this.credentials.decryptOwned(userId, dto.credentialId);
    const claimed = await this.claim(userId, idempotencyKey, 'image', credential.provider, dto, scope);
    if (!claimed.created) return this.toPublic(await this.reconcileAsset(claimed.job));
    try {
      const adapter = this.providers.get(credential.provider);
      const source = await adapter.createImage(credential.apiKey, dto);
      const asset = await this.assets.persist(userId, claimed.job.id, 'image', source);
      claimed.job.status = 'succeeded';
      claimed.job.assetId = asset.id;
      claimed.job.completedAt = new Date();
      return this.toPublic(await this.jobs.save(claimed.job));
    } catch (error) {
      return this.fail(claimed.job, error);
    }
  }

  async generateVideo(
    userId: string,
    idempotencyKey: string,
    dto: GenerateVideoDto,
    scope?: MediaExecutionScope,
  ) {
    const credential = await this.credentials.decryptOwned(userId, dto.credentialId);
    const claimed = await this.claim(userId, idempotencyKey, 'video', credential.provider, dto, scope);
    if (!claimed.created) return this.toPublic(await this.reconcileAsset(claimed.job));
    try {
      const adapter = this.providers.get(credential.provider);
      const result = await adapter.createVideo(credential.apiKey, dto);
      claimed.job.providerTaskId = result.taskId;
      if (result.status === 'failed') {
        claimed.job.status = 'failed';
        claimed.job.errorCode = 'provider_failed';
        claimed.job.completedAt = new Date();
      } else if (result.status === 'succeeded' && result.source) {
        const asset = await this.assets.persist(userId, claimed.job.id, 'video', result.source);
        claimed.job.status = 'succeeded';
        claimed.job.assetId = asset.id;
        claimed.job.completedAt = new Date();
      } else {
        claimed.job.status = result.status;
      }
      return this.toPublic(await this.jobs.save(claimed.job));
    } catch (error) {
      return this.fail(claimed.job, error);
    }
  }

  async getAndPoll(userId: string, id: string, scope?: MediaExecutionScope) {
    let job = await this.jobs.findOne({ where: { id, userId } });
    if (!job) throw new NotFoundException('媒体任务不存在');
    this.assertExecutionScope(job, scope);
    job = await this.reconcileAsset(job);
    if (
      job.kind !== 'video'
      || !['queued', 'processing'].includes(job.status)
      || !job.providerTaskId
    ) {
      return this.toPublic(job);
    }

    const credentialId = job.credentialId;
    if (!credentialId) {
      job.status = 'failed';
      job.errorCode = 'credential_unavailable';
      job.completedAt = new Date();
      return this.toPublic(await this.jobs.save(job));
    }
    const credential = await this.credentials.decryptOwned(userId, credentialId);
    if (credential.provider !== job.provider) {
      job.status = 'failed';
      job.errorCode = 'credential_provider_mismatch';
      job.completedAt = new Date();
      return this.toPublic(await this.jobs.save(job));
    }
    try {
      const result = await this.providers
        .get(job.provider)
        .getVideoStatus(credential.apiKey, job.providerTaskId);
      if (result.status === 'succeeded') {
        if (!result.source) throw new ProviderContractError('provider_invalid_response');
        const asset = await this.assets.persist(userId, job.id, 'video', result.source);
        job.assetId = asset.id;
        job.status = 'succeeded';
        job.completedAt = new Date();
      } else if (result.status === 'failed') {
        job.status = 'failed';
        job.errorCode = 'provider_failed';
        job.completedAt = new Date();
      } else {
        job.status = result.status;
      }
      return this.toPublic(await this.jobs.save(job));
    } catch (error) {
      // Polling is a safe GET. A transient provider/network failure does not
      // terminally fail the paid task and can be retried by the next status read.
      const code = this.errorCode(error);
      this.logger.warn(`媒体状态查询失败: provider=${job.provider}, code=${code}`);
      return { ...this.toPublic(job), pollError: code };
    }
  }

  private async claim(
    userId: string,
    idempotencyKey: string,
    kind: MediaKind,
    provider: MediaJob['provider'],
    input: GenerateImageDto | GenerateVideoDto,
    scope?: MediaExecutionScope,
  ): Promise<{ job: MediaJob; created: boolean }> {
    const requestHash = this.requestHash(kind, provider, input);
    const existing = await this.jobs.findOne({ where: { userId, idempotencyKey } });
    if (existing) {
      this.assertSameRequest(existing, requestHash);
      this.assertExecutionScope(existing, scope);
      return { job: existing, created: false };
    }
    const job = this.jobs.create({
      userId,
      credentialId: input.credentialId,
      provider,
      kind,
      idempotencyKey,
      requestHash,
      model: input.model,
      executionRunId: scope?.runId || null,
      executionWorkflowId: scope?.workflowId || null,
      executionWorkflowVersion: scope?.workflowVersion || null,
      status: 'creating',
      providerTaskId: null,
      assetId: null,
      errorCode: null,
      completedAt: null,
    });
    try {
      return { job: await this.jobs.save(job), created: true };
    } catch (error: any) {
      if (error?.code !== '23505') throw error;
      const concurrent = await this.jobs.findOne({ where: { userId, idempotencyKey } });
      if (!concurrent) throw error;
      this.assertSameRequest(concurrent, requestHash);
      this.assertExecutionScope(concurrent, scope);
      return { job: concurrent, created: false };
    }
  }

  private assertSameRequest(job: MediaJob, requestHash: string): void {
    if (job.requestHash !== requestHash) {
      throw new ConflictException('幂等键已被其他媒体请求使用');
    }
  }

  private assertExecutionScope(job: MediaJob, scope?: MediaExecutionScope): void {
    if (!scope) return;
    if (
      job.executionRunId !== scope.runId
      || job.executionWorkflowId !== scope.workflowId
      || job.executionWorkflowVersion !== scope.workflowVersion
      || !job.credentialId
      || !scope.credentialIds.includes(job.credentialId)
    ) {
      // Do not reveal whether a same-tenant job exists outside this run.
      throw new NotFoundException('媒体任务不存在');
    }
  }

  private requestHash(
    kind: MediaKind,
    provider: MediaJob['provider'],
    input: GenerateImageDto | GenerateVideoDto,
  ): string {
    const canonical = {
      kind,
      provider,
      credentialId: input.credentialId,
      model: input.model,
      prompt: input.prompt,
      size: input.size || null,
      aspectRatio: input.aspectRatio || null,
      quality: input.quality || null,
      durationSeconds: 'durationSeconds' in input
        ? input.durationSeconds || null
        : null,
      resolution: 'resolution' in input
        ? input.resolution || null
        : null,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private async reconcileAsset(job: MediaJob): Promise<MediaJob> {
    if (job.assetId || job.status === 'failed') return job;
    const asset = await this.assets.findByJob(job.userId, job.id);
    if (!asset) return job;
    job.assetId = asset.id;
    job.status = 'succeeded';
    job.completedAt ||= new Date();
    return this.jobs.save(job);
  }

  private async fail(job: MediaJob, error: unknown) {
    job.status = 'failed';
    job.errorCode = this.errorCode(error);
    job.completedAt = new Date();
    this.logger.warn(`媒体创建失败: provider=${job.provider}, kind=${job.kind}, code=${job.errorCode}`);
    return this.toPublic(await this.jobs.save(job));
  }

  private errorCode(error: unknown): string {
    if (error instanceof ProviderContractError) return error.code;
    const name = error instanceof Error ? error.constructor.name : '';
    if (name === 'PayloadTooLargeException') return 'asset_too_large';
    if (name === 'UnsupportedMediaTypeException') return 'asset_invalid_type';
    if (name === 'BadGatewayException') return 'asset_download_failed';
    return 'media_internal_error';
  }

  private toPublic(job: MediaJob) {
    return {
      id: job.id,
      kind: job.kind,
      provider: job.provider,
      model: job.model,
      status: job.status,
      taskId: job.providerTaskId || undefined,
      assetId: job.assetId || undefined,
      assetUrl: job.assetId ? `/media/assets/${job.assetId}` : undefined,
      errorCode: job.errorCode || undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt || undefined,
    };
  }
}
