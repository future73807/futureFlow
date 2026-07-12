import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../database/entities/user.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { FlowGramJSON } from '../converter/types';
import { DifyConverterService } from '../converter/dify-converter.service';
import { DifyClientService, DifySSEEvent } from '../dify/dify-client.service';
import { DifyConfigService } from '../dify/dify-config.service';
import { DifyConsoleService } from '../dify/dify-console.service';
import { BillingService } from '../billing/billing.service';
import { PermissionChecker } from '../auth/auth.module';
import { DirectLlmService } from './direct-llm.service';

/**
 * 工作流服务
 *
 * 编排链路:
 *   权限校验 → 扣费预检 → 执行引擎选择 → SSE 透传 → 扣费结算
 *
 * 执行引擎选择逻辑:
 *   1. Dify 已配置（DIFY_API_KEY 为有效 app- 前缀密钥）
 *      → 走 Dify Service API（SSE 流式，支持 DAG 调度）
 *   2. Dify 未配置或格式错误
 *      → 自动降级到 DirectLlmService（直接调用 DeepSeek API）
 *      → 先返回一条 dify_not_configured 通知事件（前端可据此提示用户）
 *      → 再走直接 LLM 执行路径
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly converter: DifyConverterService,
    private readonly difyClient: DifyClientService,
    private readonly difyConfig: DifyConfigService,
    private readonly difyConsole: DifyConsoleService,
    private readonly billing: BillingService,
    private readonly permissionChecker: PermissionChecker,
    private readonly directLlm: DirectLlmService,
  ) {}

  /**
   * 执行工作流(流式)
   * 返回一个 AsyncGenerator,逐个 yield SSE 事件
   */
  async *runWorkflow(
    flowgram: FlowGramJSON,
    user: User,
  ): AsyncGenerator<DifySSEEvent> {
    // ── 1. 权限校验 ──
    const nodeTypes = flowgram.nodes.map((n) => n.type);
    const permission = this.permissionChecker.checkNodePermissions(
      user.vipLevel,
      nodeTypes,
    );
    if (!permission.allowed) {
      throw new BadRequestException(
        `当前 VIP 等级(${user.vipLevel})无权使用以下节点: ${permission.deniedNodes.join(', ')}`,
      );
    }

    // ── 2. 预估费用 ──
    const estimatedCost = this.converter.estimateCost(flowgram);
    const useDify = this.difyClient.isConfigured();

    this.logger.log(
      `工作流执行: userId=${user.id}, nodes=${nodeTypes.join(',')}, estCost=${estimatedCost}, engine=${useDify ? 'dify' : 'direct-llm'}`,
    );

    // ── 3. 创建运行记录 ──
    const runId = uuidv4();
    const run = this.runRepo.create({
      id: runId,
      userId: user.id,
      status: 'running',
      flowgramJson: flowgram,
      estimatedCost,
    });
    await this.runRepo.save(run);

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

    if (useDify) {
      // ═══ Dify 执行路径 ═══
      // (可选)通过 Console API 导入/更新 Dify DSL
      if (this.difyConsole.isEnabled()) {
        const importResult = await this.difyConsole.importWorkflow(flowgram);
        if (importResult.success) {
          this.logger.log(`DSL 已更新到 Dify: ${importResult.message}`);
        } else {
          this.logger.warn(`DSL 导入跳过或失败: ${importResult.message}`);
        }
      }

      const difyInputs = this.converter.extractInputs(flowgram);

      try {
        const stream = this.difyClient.runWorkflowStream(
          difyInputs,
          user.username,
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
    } else {
      // ═══ 降级路径:直接 LLM 模式 ═══
      // 先返回一条降级通知事件（前端可据此显示提示）
      const configStatus = this.difyConfig.getValidation();
      const degradeEvent: DifySSEEvent = {
        event: 'engine_degraded',
        data: {
          engine: 'direct-llm',
          reason: 'dify_not_configured',
          message: configStatus.message,
          suggestion: configStatus.suggestion,
        },
      };
      allEvents.push(degradeEvent);
      yield degradeEvent;

      this.logger.warn(
        `降级到直接 LLM 模式: ${configStatus.message}`,
      );

      // 执行直接 LLM 调用
      try {
        const stream = this.directLlm.runDirect(flowgram, user.username);
        for await (const event of stream) {
          allEvents.push(event);
          yield event;
        }
      } catch (err) {
        executionError = err;
        this.logger.error(`直接 LLM 执行异常: ${err.message}`);
        const errorEvent: DifySSEEvent = {
          event: 'error',
          data: {
            status: 500,
            code: 'direct_llm_failed',
            message: err.message,
          },
        };
        allEvents.push(errorEvent);
        yield errorEvent;
      }
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
      const modelName = this.extractModelName(flowgram);
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
        `Token: ${result.totalTokens}, Steps: ${result.totalSteps}, Model: ${modelName}, Engine: ${useDify ? 'dify' : 'direct'}`,
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
        `工作流完成: runId=${runId}, tokens=${result.totalTokens}, cost=${actualCost}, model=${modelName}, engine=${useDify ? 'dify' : 'direct'}`,
      );
    }
  }

  /**
   * 从 SSE 事件流中提取执行结果汇总
   * 兼容 Dify 和直接 LLM 两种模式
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

    if (errorEvent && !workflowFinished) {
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

    const data = workflowFinished?.data || {};
    return {
      workflowRunId: workflowFinished?.workflow_run_id || '',
      taskId: workflowFinished?.task_id || '',
      status: data.status || 'succeeded',
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
    return modelName ? String(modelName) : 'deepseek-v4-pro';
  }
}
