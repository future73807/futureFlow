import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../common/describe-error';
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowTriggerService } from './workflow-trigger.service';
import {
  describeConsecutiveFailure,
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetry,
  type RetryPolicy,
} from './trigger-retry.policy';

/**
 * Database-backed fixed-cadence scheduler. Claiming moves nextRunAt first, so
 * separate gateway processes do not execute the same due row twice.
 *
 * 单次执行失败时会按 {@link RetryPolicy} 做有限次退避重试，重试仍失败才记为一次
 * 失败。重试在本次 tick 内串行等待（调度器有单飞保护），所以默认只额外重试一次、
 * 且退避有上限，避免「注定失败」的触发器长期占住调度槽位。
 */
@Injectable()
export class WorkflowTriggerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowTriggerSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** 进入销毁流程后置为 true：不再启动新的重试等待，避免悬挂定时器拖住进程退出。 */
  private stopping = false;
  /** 尚在等待中的退避定时器，销毁时清掉并立即唤醒。 */
  private pendingSleep?: { timer: NodeJS.Timeout; resolve: () => void };

  constructor(
    private readonly triggers: WorkflowTriggerService,
    private readonly workflows: WorkflowsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const seconds = Number.parseInt(this.config.get<string>('WORKFLOW_SCHEDULE_TICK_SECONDS', '30'), 10) || 30;
    this.timer = setInterval(() => void this.dispatchDue(), seconds * 1_000);
    void this.dispatchDue();
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pendingSleep) {
      clearTimeout(this.pendingSleep.timer);
      this.pendingSleep.resolve();
      this.pendingSleep = undefined;
    }
  }

  private retryPolicy(): RetryPolicy {
    return resolveRetryPolicy({
      WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: this.config.get('WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS'),
      WORKFLOW_TRIGGER_RETRY_BASE_MS: this.config.get('WORKFLOW_TRIGGER_RETRY_BASE_MS'),
      WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD: this.config.get('WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD'),
    });
  }

  private async dispatchDue() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.triggers.claimDueSchedules();
      // 单个触发器失败不能中断同一批次的其他任务：execute 内部已记录错误并
      // 回写结果，这里再用 allSettled 兜一层，并把未处理的拒绝显式打出来，
      // 避免「任务静默不执行」。
      const results = await Promise.allSettled(
        due.map((trigger) => this.execute(trigger.id)),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error(`定时触发调度未处理异常: ${describeError(result.reason)}`);
        }
      }
    } catch (error) {
      this.logger.error(`定时触发扫描失败: ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** 可中断的等待：销毁时会被立即唤醒，不阻塞进程退出。 */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSleep = undefined;
        resolve();
      }, ms);
      this.pendingSleep = { timer, resolve };
    });
  }

  /** 跑一次工作流，返回是否成功（流正常结束且状态为 succeeded）。 */
  private async runOnce(triggerId: string): Promise<boolean> {
    const trigger = await this.triggers.toRunnableById(triggerId);
    const stream = this.workflows.runWorkflow(
      trigger.workflow.publishedFlowgramJson as any,
      trigger.user,
      trigger.trigger.staticInputs || {},
      trigger.workflow.id,
      {
        source: 'schedule',
        triggerId,
        workflowVersion: trigger.workflow.publishedVersion || undefined,
      },
    );
    let succeeded = false;
    for await (const event of stream) {
      if (event.event === 'workflow_finished' && event.data?.status === 'succeeded') succeeded = true;
    }
    return succeeded;
  }

  private async execute(triggerId: string) {
    const policy = this.retryPolicy();
    let succeeded = false;
    /** 「触发器已被删除或暂停」是不可重试的终态：重试不会改变结果。 */
    let retryable = true;
    let lastError: unknown;
    let attempts = 0;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        succeeded = await this.runOnce(triggerId);
      } catch (error) {
        if (error instanceof NotFoundException) {
          retryable = false;
          lastError = error;
          this.logger.warn(`定时触发已不可运行（已删除或已暂停），不再重试: trigger=${triggerId}`);
          break;
        }
        lastError = error;
        this.logger.error(
          `定时触发执行失败（第 ${attempt}/${policy.maxAttempts} 次）: trigger=${triggerId}, ${describeError(error)}`,
        );
      }

      if (succeeded) break;

      if (shouldRetry({ attempt, policy, retryable, stopping: this.stopping })) {
        const delay = retryDelayMs(attempt, policy.baseDelayMs);
        this.logger.warn(`定时触发将在 ${delay}ms 后重试: trigger=${triggerId}`);
        await this.sleep(delay);
        if (this.stopping) break;
        continue;
      }
      break;
    }

    if (!succeeded && retryable && lastError) {
      this.logger.error(
        `定时触发重试 ${policy.maxAttempts} 次后仍失败: trigger=${triggerId}, ${describeError(lastError)}`,
      );
    }

    const recorded = await this.triggers.recordResult(triggerId, succeeded);
    const alert = !succeeded && recorded
      ? describeConsecutiveFailure(recorded.failureCount, recorded.name, policy)
      : null;
    if (alert) this.logger.error(alert);
  }
}
