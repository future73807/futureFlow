import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowTriggerService } from './workflow-trigger.service';

/**
 * Database-backed fixed-cadence scheduler. Claiming moves nextRunAt first, so
 * separate gateway processes do not execute the same due row twice.
 */
@Injectable()
export class WorkflowTriggerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowTriggerSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

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
    if (this.timer) clearInterval(this.timer);
  }

  private async dispatchDue() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.triggers.claimDueSchedules();
      await Promise.all(due.map((trigger) => this.execute(trigger.id)));
    } catch (error) {
      this.logger.error(`定时触发扫描失败: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  private async execute(triggerId: string) {
    let succeeded = false;
    try {
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
      for await (const event of stream) {
        if (event.event === 'workflow_finished' && event.data?.status === 'succeeded') succeeded = true;
      }
    } catch (error) {
      this.logger.error(`定时触发执行失败: trigger=${triggerId}, ${error.message}`);
    } finally {
      await this.triggers.recordResult(triggerId, succeeded);
    }
  }
}
