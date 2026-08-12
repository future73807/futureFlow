import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThanOrEqual, Repository } from 'typeorm';
import { User } from '../../database/entities/user.entity';
import { WorkflowRun } from '../../database/entities/workflow-run.entity';

export interface RunAdmissionOptions {
  id: string;
  userId: string;
  workflowId?: string;
  flowgramJson: Record<string, any>;
  estimatedCost: number;
  source?: string;
  triggerId?: string;
  idempotencyKey?: string;
}

/**
 * Admits a billable execution before an SSE response is opened. The user-row
 * lock serializes a user's admission decisions on PostgreSQL, and the unique
 * idempotency index is the final safety net across processes.
 */
@Injectable()
export class WorkflowExecutionGuardService {
  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async reserve(options: RunAdmissionOptions): Promise<WorkflowRun> {
    const idempotencyKey = this.normalizeIdempotencyKey(options.idempotencyKey);
    const concurrentLimit = this.readPositiveInt('WORKFLOW_MAX_CONCURRENT_PER_USER', 3);
    const perMinuteLimit = this.readPositiveInt('WORKFLOW_MAX_RUNS_PER_MINUTE', 30);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Production PostgreSQL must always take this lock before the two counts
        // below. The only permitted fallback is pg-mem explicitly reporting that
        // its test adapter cannot implement row locks.
        try {
          await manager.findOne(User, {
            where: { id: options.userId },
            lock: { mode: 'pessimistic_write' },
          });
        } catch (error) {
          if (!this.isPgMemLockUnsupported(error)) throw error;
          await manager.findOne(User, { where: { id: options.userId } });
        }

        if (idempotencyKey) {
          const duplicate = await manager.findOne(WorkflowRun, {
            where: { userId: options.userId, idempotencyKey },
          });
          if (duplicate) {
            throw new ConflictException({
              code: 'idempotency_conflict',
              message: 'This idempotency key has already been accepted',
              runId: duplicate.id,
              status: duplicate.status,
            });
          }
        }

        const [running, recent] = await Promise.all([
          manager.count(WorkflowRun, {
            where: { userId: options.userId, status: 'running' },
          }),
          manager.count(WorkflowRun, {
            where: {
              userId: options.userId,
              createdAt: MoreThanOrEqual(new Date(Date.now() - 60_000)),
            },
          }),
        ]);

        if (running >= concurrentLimit) {
          throw new HttpException({
            code: 'concurrency_limit',
            message: `At most ${concurrentLimit} workflow runs may execute concurrently`,
          }, HttpStatus.TOO_MANY_REQUESTS);
        }
        if (recent >= perMinuteLimit) {
          throw new HttpException({
            code: 'rate_limit',
            message: `At most ${perMinuteLimit} workflow runs may start each minute`,
          }, HttpStatus.TOO_MANY_REQUESTS);
        }

        return manager.save(
          WorkflowRun,
          manager.create(WorkflowRun, {
            id: options.id,
            userId: options.userId,
            workflowId: options.workflowId || null,
            triggerId: options.triggerId || null,
            source: options.source || 'manual',
            idempotencyKey,
            status: 'running',
            flowgramJson: options.flowgramJson,
            estimatedCost: options.estimatedCost,
          }),
        );
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'idempotency_conflict',
          message: 'This idempotency key has already been accepted',
        });
      }
      throw error;
    }
  }

  private normalizeIdempotencyKey(value?: string): string | null {
    if (!value) return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new BadRequestException('Idempotency-Key must contain 1-128 URL-safe characters');
    }
    return normalized;
  }

  private readPositiveInt(key: string, fallback: number): number {
    const value = Number.parseInt(this.config.get<string>(key, String(fallback)), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private isUniqueViolation(error: any): boolean {
    return error?.code === '23505' || /duplicate key|unique constraint/i.test(error?.message || '');
  }

  private isPgMemLockUnsupported(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const details = error as {
      message?: unknown;
      stack?: unknown;
      data?: { hint?: unknown; error?: unknown };
    };
    const evidence = [
      details.message,
      details.stack,
      details.data?.hint,
      details.data?.error,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');

    return /\bpg-mem\b/i.test(evidence)
      && /(?:pessimistic(?:[_\s-]?write)?|for\s+update|row\s+locks?|locking)/i.test(evidence)
      && /(?:not\s+supported|not\s+implemented|does\s+not\s+implement)/i.test(evidence);
  }
}
