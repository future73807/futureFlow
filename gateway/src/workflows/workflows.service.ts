import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../database/entities/user.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { FlowGramJSON } from '../converter/types';
import { DifyConverterService } from '../converter/dify-converter.service';
import { DifyClientService, DifySSEEvent } from '../dify/dify-client.service';
import { BillingService } from '../billing/billing.service';
import { PermissionChecker } from '../auth/auth.module';
import { WorkflowExecutionGuardService } from './services/workflow-execution-guard.service';

/**
 * 工作流服务
 *
 * 编排链路:
 *   权限校验 → 扣费预检 → Dify 引擎执行 → SSE 透传 → 扣费结算
 *
 * 执行引擎:
 *   - Dify 已配置（DIFY_API_KEY 为有效 app- 前缀密钥）
 *     → 走 Dify Service API（SSE 流式，支持 DAG 调度）
 *   - Dify 未配置或格式错误
 *     → 直接报错，不降级
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly converter: DifyConverterService,
    private readonly difyClient: DifyClientService,
    private readonly billing: BillingService,
    private readonly permissionChecker: PermissionChecker,
    @Optional()
    private readonly executionGuard?: WorkflowExecutionGuardService,
  ) {}

  /**
   * 执行工作流(流式)
   * 返回一个 AsyncGenerator,逐个 yield SSE 事件
   */
  async *runWorkflow(
    flowgram: FlowGramJSON,
    user: User,
    inputOverrides: Record<string, string | number | boolean> = {},
    workflowId?: string,
    executionContext: {
      source?: string;
      triggerId?: string;
      idempotencyKey?: string;
      workflowVersion?: number;
    } = {},
  ): AsyncGenerator<DifySSEEvent> {
    const executableFlowgram = this.applyInputOverrides(flowgram, inputOverrides);
    this.converter.validateFlowGram(executableFlowgram);

    // ── 1. 权限校验 ──
    const nodeTypes = executableFlowgram.nodes.map((n) => n.type);
    const permission = this.permissionChecker.checkNodePermissions(
      user.vipLevel,
      nodeTypes,
    );
    if (!permission.allowed) {
      throw new BadRequestException(
        `当前 VIP 等级(${user.vipLevel})无权使用以下节点: ${permission.deniedNodes.join(', ')}`,
      );
    }

    // ── 2. 检查 Dify 配置 ──
    const estimatedCost = this.converter.estimateCost(executableFlowgram);
    const hasWorkflowVersion = !!(workflowId && executionContext.workflowVersion);
    const difyTarget = hasWorkflowVersion
      ? { workflowId, workflowVersion: executionContext.workflowVersion }
      : {};
    const difyConfigured = hasWorkflowVersion && (await this.difyClient.isConfigured(difyTarget));

    if (!difyConfigured) {
      throw new BadRequestException(
        `工作流执行需要 Dify 引擎。请先在 Dify 控制台创建工作流应用并发布，或联系管理员配置 DIFY_API_KEY。`,
      );
    }

    this.logger.log(
      `工作流执行: userId=${user.id}, nodes=${nodeTypes.join(',')}, estCost=${estimatedCost}, engine=dify`,
    );

    // ── 3. 创建运行记录 ──
    const runId = uuidv4();
    if (this.executionGuard) {
      await this.executionGuard.reserve({
        id: runId,
        userId: user.id,
        workflowId,
        flowgramJson: executableFlowgram,
        estimatedCost,
        source: executionContext.source,
        triggerId: executionContext.triggerId,
        idempotencyKey: executionContext.idempotencyKey,
      });
    } else {
      const run = this.runRepo.create({
        id: runId,
        userId: user.id,
        workflowId: workflowId || null,
        triggerId: executionContext.triggerId || null,
        source: executionContext.source || 'manual',
        idempotencyKey: executionContext.idempotencyKey || null,
        status: 'running',
        flowgramJson: executableFlowgram,
        estimatedCost,
      });
      await this.runRepo.save(run);
    }

    // ── 4. 扣费预检:冻结预估费用 ──
    let frozenAmount = 0;
    try {
      frozenAmount = await this.billing.freezeBalance(
        user.id,
        estimatedCost,
        runId,
      );
    } catch (err) {
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: err.message,
      });
      throw err;
    }

    // ── 5. 执行工作流 ──
    const allEvents: DifySSEEvent[] = [];
    let executionError: Error | null = null;

    try {
      // A published release was imported into its own Dify app at publish
      // time. Execution is read-only and never serializes other workflows.
      const difyInputs = this.converter.extractInputs(executableFlowgram);

      const stream = this.difyClient.runWorkflowStream(
        difyInputs,
        user.username,
        difyTarget,
      );
      for await (const event of stream) {
        allEvents.push(event);
        yield event;
        if (event.event === 'workflow_started' && event.workflow_run_id) {
          await this.runRepo.update(runId, {
            difyWorkflowId: event.data?.id,
            difyTaskId: event.task_id,
          });
        }
      }
    } catch (err) {
      executionError = err;
      this.logger.error(`Dify 执行异常: ${err.message}`);
      const errorEvent: DifySSEEvent = {
        event: 'error',
        data: {
          status: 500,
          code: 'dify_execution_failed',
          message: err.message,
        },
      };
      allEvents.push(errorEvent);
      yield errorEvent;
    }

    // ── 6. 提取执行结果 ──
    const result = this.extractResult(allEvents);

    // ── 7. 扣费结算 ──
    if (executionError || result.status === 'failed') {
      // 执行失败:全额退款
      await this.billing.refund(user.id, frozenAmount, runId);
      await this.runRepo.update(runId, {
        status: 'failed',
        totalTokens: result.totalTokens,
        totalSteps: result.totalSteps,
        elapsedTime: result.elapsedTime,
        errorMessage: result.error || executionError?.message,
        finishedAt: new Date(),
      });
      this.logger.warn(
        `工作流失败: runId=${runId}, error=${result.error || executionError?.message}`,
      );
    } else {
      // 执行成功:计算实际费用并结算
      const modelName = this.extractModelName(executableFlowgram);
      const actualCost = this.billing.calculateCost(
        result.totalTokens,
        modelName,
        undefined,
      );

      await this.billing.settleBilling(
        user.id,
        frozenAmount,
        actualCost,
        runId,
        `Token: ${result.totalTokens}, Steps: ${result.totalSteps}, Model: ${modelName}, Engine: dify`,
      );

      await this.runRepo.update(runId, {
        status: 'succeeded',
        totalTokens: result.totalTokens,
        totalSteps: result.totalSteps,
        elapsedTime: result.elapsedTime,
        actualCost,
        difyWorkflowId: result.workflowRunId,
        difyTaskId: result.taskId,
        finishedAt: new Date(),
      });

      this.logger.log(
        `工作流完成: runId=${runId}, tokens=${result.totalTokens}, cost=${actualCost}, model=${modelName}, engine=dify`,
      );
    }
  }

  /**
   * 从 SSE 事件流中提取执行结果汇总
   */
  private extractResult(events: DifySSEEvent[]): {
    workflowRunId: string;
    taskId: string;
    status: string;
    totalTokens: number;
    totalSteps: number;
    elapsedTime: number;
    outputs: Record<string, any>;
    error?: string;
  } {
    const workflowFinished = events.find(
      (e) => e.event === 'workflow_finished',
    );
    const errorEvent = events.find((e) => e.event === 'error');
    const started = events.find((e) => e.event === 'workflow_started');

    if (errorEvent) {
      return {
        workflowRunId: started?.workflow_run_id || '',
        taskId: started?.task_id || '',
        status: 'failed',
        totalTokens: 0,
        totalSteps: 0,
        elapsedTime: 0,
        outputs: {},
        error: errorEvent.data?.message || '未知错误',
      };
    }

    if (!workflowFinished) {
      return {
        workflowRunId: started?.workflow_run_id || '',
        taskId: started?.task_id || '',
        status: 'failed',
        totalTokens: 0,
        totalSteps: 0,
        elapsedTime: 0,
        outputs: {},
        error: '执行流意外结束，未收到 workflow_finished 事件',
      };
    }

    const data = workflowFinished.data || {};
    return {
      workflowRunId: workflowFinished?.workflow_run_id || '',
      taskId: workflowFinished?.task_id || '',
      status: data.status || 'failed',
      totalTokens: data.total_tokens || 0,
      totalSteps: data.total_steps || 0,
      elapsedTime: data.elapsed_time || 0,
      outputs: data.outputs || {},
      error: data.error,
    };
  }

  /** 从 FlowGram JSON 中提取第一个 LLM 节点的模型名 */
  private extractModelName(flowgram: FlowGramJSON): string {
    const llmNode = flowgram.nodes.find((n) => n.type === 'llm');
    const modelName = llmNode?.data?.inputsValues?.modelName?.content;
    return modelName ? String(modelName) : 'deepseek-chat';
  }

  /**
   * 将本次调用传入的 inputs 写入 Start 节点副本，不修改保存的草稿或发布快照。
   */
  private applyInputOverrides(
    flowgram: FlowGramJSON,
    inputs: Record<string, string | number | boolean>,
  ): FlowGramJSON {
    if (Object.keys(inputs).length === 0) return flowgram;

    const startIndex = flowgram.nodes.findIndex((node) => node.type === 'start');
    if (startIndex < 0) {
      throw new BadRequestException('工作流缺少 Start 节点，无法接收运行参数');
    }

    const copied = JSON.parse(JSON.stringify(flowgram)) as FlowGramJSON;
    const startNode = copied.nodes[startIndex];
    const properties = (startNode.data.outputs?.properties || {}) as Record<string, unknown>;

    for (const [key, value] of Object.entries(inputs)) {
      if (!(key in properties)) {
        throw new BadRequestException(`未知的工作流输入参数: ${key}`);
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new BadRequestException(`输入参数 ${key} 仅支持字符串、数字或布尔值`);
      }
      const expectedType = (properties[key] as any)?.type;
      if (
        expectedType &&
        ['string', 'number', 'boolean'].includes(expectedType) &&
        typeof value !== expectedType
      ) {
        throw new BadRequestException(
          `输入参数 ${key} 必须是 ${expectedType} 类型`,
        );
      }
    }

    startNode.data.inputsValues = { ...(startNode.data.inputsValues || {}) };
    for (const [key, value] of Object.entries(inputs)) {
      startNode.data.inputsValues[key] = { type: 'constant', content: value };
    }

    return copied;
  }
}
