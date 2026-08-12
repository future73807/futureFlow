import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowTrigger } from '../database/entities/workflow-trigger.entity';
import { CreateWorkflowTriggerDto, UpdateWorkflowTriggerDto } from './dto/workflow-trigger.dto';

export interface RunnableTrigger {
  trigger: WorkflowTrigger;
  workflow: Workflow;
  user: User;
}

@Injectable()
export class WorkflowTriggerService {
  constructor(
    @InjectRepository(WorkflowTrigger)
    private readonly triggerRepo: Repository<WorkflowTrigger>,
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async list(userId: string, workflowId: string) {
    await this.getOwnedPublishedWorkflow(userId, workflowId);
    const triggers = await this.triggerRepo.find({
      where: { userId, workflowId },
      order: { createdAt: 'DESC' },
    });
    return triggers.map((trigger) => this.serialize(trigger));
  }

  async create(userId: string, workflowId: string, dto: CreateWorkflowTriggerDto) {
    const workflow = await this.getOwnedPublishedWorkflow(userId, workflowId);
    const name = this.normalizeName(dto.name);
    this.validateInputs(workflow, dto.staticInputs, dto.type === 'schedule');
    if (dto.type === 'schedule' && !dto.intervalMinutes) {
      throw new BadRequestException('定时触发器必须设置 intervalMinutes');
    }
    if (dto.type === 'webhook' && dto.intervalMinutes !== undefined) {
      throw new BadRequestException('Webhook 触发器不能设置 intervalMinutes');
    }
    if (dto.intervalMinutes && dto.intervalMinutes > 43_200) {
      throw new BadRequestException('intervalMinutes 不能超过 30 天');
    }

    const trigger = this.triggerRepo.create({
      userId,
      workflowId,
      name,
      type: dto.type,
      staticInputs: dto.staticInputs || {},
      intervalMinutes: dto.type === 'schedule' ? dto.intervalMinutes! : null,
      nextRunAt:
        dto.type === 'schedule'
          ? this.nextRun(dto.intervalMinutes!, new Date())
          : null,
    });

    let plaintext: string | undefined;
    if (dto.type === 'webhook') {
      plaintext = this.generateSecret();
      trigger.webhookSecretHash = this.hashSecret(plaintext);
      trigger.webhookSecretPrefix = plaintext.slice(0, 13);
    }
    const saved = await this.triggerRepo.save(trigger);
    return {
      trigger: this.serialize(saved),
      ...(plaintext
        ? {
            secret: plaintext,
            webhookUrl: `${this.config.get<string>('PUBLIC_GATEWAY_URL', 'http://localhost:3001').replace(/\/$/, '')}/webhooks/${plaintext}`,
          }
        : {}),
    };
  }

  async update(userId: string, triggerId: string, dto: UpdateWorkflowTriggerDto) {
    const trigger = await this.getOwned(userId, triggerId);
    if (dto.name !== undefined) trigger.name = this.normalizeName(dto.name);
    if (dto.status !== undefined) trigger.status = dto.status;
    if (dto.staticInputs !== undefined) {
      const workflow = await this.getOwnedPublishedWorkflow(userId, trigger.workflowId);
      this.validateInputs(workflow, dto.staticInputs, trigger.type === 'schedule');
      trigger.staticInputs = dto.staticInputs;
    }
    if (dto.intervalMinutes !== undefined) {
      if (trigger.type !== 'schedule') throw new BadRequestException('Webhook 触发器不能设置执行间隔');
      if (dto.intervalMinutes > 43_200) throw new BadRequestException('intervalMinutes 不能超过 30 天');
      trigger.intervalMinutes = dto.intervalMinutes;
      trigger.nextRunAt = this.nextRun(dto.intervalMinutes, new Date());
    }
    if (trigger.type === 'schedule' && trigger.status === 'active' && !trigger.nextRunAt) {
      trigger.nextRunAt = this.nextRun(trigger.intervalMinutes!, new Date());
    }
    return this.serialize(await this.triggerRepo.save(trigger));
  }

  async remove(userId: string, triggerId: string) {
    await this.triggerRepo.remove(await this.getOwned(userId, triggerId));
  }

  async rotateWebhook(userId: string, triggerId: string) {
    const trigger = await this.getOwned(userId, triggerId);
    if (trigger.type !== 'webhook') throw new BadRequestException('仅 Webhook 触发器可轮换密钥');
    const secret = this.generateSecret();
    trigger.webhookSecretHash = this.hashSecret(secret);
    trigger.webhookSecretPrefix = secret.slice(0, 13);
    await this.triggerRepo.save(trigger);
    return {
      trigger: this.serialize(trigger),
      secret,
      webhookUrl: `${this.config.get<string>('PUBLIC_GATEWAY_URL', 'http://localhost:3001').replace(/\/$/, '')}/webhooks/${secret}`,
    };
  }

  async resolveWebhook(secret: string): Promise<RunnableTrigger> {
    const trigger = await this.triggerRepo.findOne({
      where: { webhookSecretHash: this.hashSecret(secret), type: 'webhook', status: 'active' },
    });
    if (!trigger) throw new NotFoundException('Webhook 不存在、已轮换或已暂停');
    return this.toRunnable(trigger);
  }

  /** Claim due schedule rows by moving nextRunAt before execution begins. */
  async claimDueSchedules(limit = 20): Promise<WorkflowTrigger[]> {
    const now = new Date();
    const due = await this.triggerRepo.find({
      where: { type: 'schedule', status: 'active', nextRunAt: LessThanOrEqual(now) },
      order: { nextRunAt: 'ASC' },
      take: limit,
    });
    const claimed: WorkflowTrigger[] = [];
    for (const trigger of due) {
      const nextRunAt = this.nextRun(trigger.intervalMinutes!, now);
      const result = await this.triggerRepo
        .createQueryBuilder()
        .update(WorkflowTrigger)
        .set({ nextRunAt })
        .where('id = :id AND "nextRunAt" <= :now AND status = :status', {
          id: trigger.id,
          now,
          status: 'active',
        })
        .execute();
      if (result.affected) {
        trigger.nextRunAt = nextRunAt;
        claimed.push(trigger);
      }
    }
    return claimed;
  }

  async toRunnable(trigger: WorkflowTrigger): Promise<RunnableTrigger> {
    const workflow = await this.getOwnedPublishedWorkflow(trigger.userId, trigger.workflowId);
    const user = await this.userRepo.findOne({ where: { id: trigger.userId, status: 'active' } });
    if (!user) throw new ConflictException('触发器所有者不可用');
    return { trigger, workflow, user };
  }

  async toRunnableById(triggerId: string): Promise<RunnableTrigger> {
    const trigger = await this.triggerRepo.findOne({
      where: { id: triggerId, type: 'schedule', status: 'active' },
    });
    if (!trigger) throw new NotFoundException('定时触发器不存在或已暂停');
    return this.toRunnable(trigger);
  }

  async recordResult(triggerId: string, succeeded: boolean) {
    const trigger = await this.triggerRepo.findOne({ where: { id: triggerId } });
    if (!trigger) return;
    trigger.lastTriggeredAt = new Date();
    trigger.lastRunStatus = succeeded ? 'succeeded' : 'failed';
    trigger.failureCount = succeeded ? 0 : trigger.failureCount + 1;
    await this.triggerRepo.save(trigger);
  }

  private async getOwned(userId: string, triggerId: string) {
    const trigger = await this.triggerRepo.findOne({ where: { id: triggerId, userId } });
    if (!trigger) throw new NotFoundException('触发器不存在');
    return trigger;
  }

  private async getOwnedPublishedWorkflow(userId: string, workflowId: string) {
    const workflow = await this.workflowRepo.findOne({ where: { id: workflowId, userId, status: 'active' } });
    if (!workflow) throw new NotFoundException('工作流不存在');
    if (!workflow.publishedFlowgramJson) {
      throw new BadRequestException('触发器只能调用已发布的工作流');
    }
    return workflow;
  }

  /**
   * Reject malformed trigger inputs when they are configured, instead of
   * creating a trigger that can only fail later in the background.
   */
  private validateInputs(
    workflow: Workflow,
    inputs?: Record<string, unknown>,
    requireComplete = false,
  ) {
    const startNode = (workflow.publishedFlowgramJson as any)?.nodes?.find(
      (node: any) => node.type === 'start',
    );
    const properties = startNode?.data?.outputs?.properties || {};
    if (requireComplete) {
      const required = Array.isArray(startNode?.data?.outputs?.required)
        ? startNode.data.outputs.required.map(String)
        : [];
      for (const key of required) {
        const supplied = Object.prototype.hasOwnProperty.call(inputs || {}, key)
          ? inputs![key]
          : startNode?.data?.inputsValues?.[key]?.content ?? properties[key]?.default;
        if (
          supplied === undefined
          || supplied === null
          || (typeof supplied === 'string' && !supplied.trim())
        ) {
          throw new BadRequestException(`定时触发器缺少必填工作流输入参数: ${key}`);
        }
      }
    }
    for (const [key, value] of Object.entries(inputs || {})) {
      if (!key || !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new BadRequestException('触发器输入仅支持字符串、数字或布尔值');
      }
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new BadRequestException(`未知的工作流输入参数: ${key}`);
      }
      const expectedType = properties[key]?.type;
      const typeMatches = expectedType === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : !expectedType
          || !['string', 'number', 'boolean'].includes(expectedType)
          || typeof value === expectedType;
      if (!typeMatches) {
        const expectedLabel = ({
          string: '字符串',
          number: '数字',
          integer: '整数',
          boolean: '布尔值',
        } as Record<string, string>)[expectedType] || expectedType;
        throw new BadRequestException(
          `输入参数 ${key} 必须是${expectedLabel}类型`,
        );
      }
    }
  }

  private normalizeName(name: string) {
    const normalized = name.trim();
    if (!normalized) throw new BadRequestException('触发器名称不能为空');
    return normalized;
  }

  private serialize(trigger: WorkflowTrigger) {
    const { webhookSecretHash, ...safe } = trigger;
    return safe;
  }

  private nextRun(intervalMinutes: number, from: Date) {
    return new Date(from.getTime() + intervalMinutes * 60_000);
  }

  private generateSecret() {
    return `ffwh_${randomBytes(24).toString('base64url')}`;
  }

  private hashSecret(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
