import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../common/describe-error';
import { MediaJobService } from './media-job.service';

/**
 * 媒体任务对账调度。
 *
 * 与 `StaleRunReconcilerService` 同一类问题：进程在「建好任务记录、尚未置终态」之间
 * 死亡，会让任务永远停在 `creating`/`queued`/`processing`；又因为 `claim()` 对同一
 * 幂等键返回已存在任务，用户既看不到终态、也无法用同一幂等键重试。具体判定逻辑在
 * {@link MediaJobService.sweepStaleJobs}。
 *
 * 单独成类（而不是塞进 MediaJobService）是为了让「周期性」与「业务判定」分离：
 * 前者需要生命周期钩子，后者需要可直接测试。
 */
@Injectable()
export class MediaStaleJobSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaStaleJobSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly jobs: MediaJobService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const seconds = this.positiveInt('MEDIA_STALE_JOB_SWEEP_SECONDS', 300);
    const minutes = this.positiveInt('MEDIA_STALE_JOB_MINUTES', 30);
    this.timer = setInterval(() => void this.sweep(minutes), seconds * 1_000);
    this.timer.unref?.();
    // 启动时先扫一次，回收上一轮进程遗留的卡住任务。
    void this.sweep(minutes);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private positiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(this.config.get<string>(key, String(fallback)), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /** 公开以便直接测试；`sweepStaleJobs` 自身幂等，重复调用不会重复处理。 */
  async sweep(staleMinutes?: number): Promise<{ recovered: number; failed: number }> {
    if (this.running) return { recovered: 0, failed: 0 };
    this.running = true;
    try {
      const minutes = staleMinutes ?? this.positiveInt('MEDIA_STALE_JOB_MINUTES', 30);
      return await this.jobs.sweepStaleJobs(minutes);
    } catch (error) {
      this.logger.error(`媒体任务对账失败: ${describeError(error)}`);
      return { recovered: 0, failed: 0 };
    } finally {
      this.running = false;
    }
  }
}
