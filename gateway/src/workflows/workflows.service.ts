import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../database/entities/user.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { FlowGramJSON } from '../converter/types';
import { DifyConverterService } from '../converter/dify-converter.service';
import { DifyClientService, DifySSEEvent } from '../dify/dify-client.service';
import { DifyConsoleService } from '../dify/dify-console.service';
import { BillingService } from '../billing/billing.service';
import { PermissionChecker } from '../auth/auth.module';

/**
 * 工作流服务
 * 编排:权限校验 → 扣费预检 → DSL转换 → Dify执行 → SSE透传 → 扣费结算
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly converter: DifyConverterService,
    private readonly difyClient: DifyClientService,
    private readonly difyConsole: DifyConsoleService,
    private readonly billing: BillingService,
    private readonly permissionChecker: PermissionChecker,
  ) {}

  /**
   * 执行工作流(流式)
   * 返回一个 AsyncGenerator,逐个 yield 透传的 SSE 事件
   */
  async *runWorkflow(
    flowgram: FlowGramJSON,
    user: User,
  ): AsyncGenerator<DifySSEEvent> {
    // 1. 权限校验:检查用户 VIP 等级是否有权使用所有节点
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

    // 2. DSL 转换(核心步骤)
    const difyInputs = this.converter.extractInputs(flowgram);
    const estimatedCost = this.converter.estimateCost(flowgram);

    this.logger.log(
      `工作流执行: userId=${user.id}, nodes=${nodeTypes.join(',')}, estCost=${estimatedCost}`,
    );

    // 3. 创建运行记录
    const runId = uuidv4();
    const run = this.runRepo.create({
      id: runId,
      userId: user.id,
      status: 'running',
      flowgramJson: flowgram,
      estimatedCost,
    });
    await this.runRepo.save(run);

    // 4. 扣费预检:冻结预估费用
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

    // 5. (可选)通过 Console API 导入/更新 Dify DSL
    if (this.difyConsole.isEnabled()) {
      const importResult = await this.difyConsole.importWorkflow(flowgram);
      if (importResult.success) {
        this.logger.log(`DSL 已更新到 Dify: ${importResult.message}`);
      } else {
        this.logger.warn(`DSL 导入跳过或失败: ${importResult.message}`);
      }
    }

    // 6. 执行 Dify 工作流(流式)
    const allEvents: DifySSEEvent[] = [];
    let executionError: Error | null = null;

    // 检查 Dify 配置是否就绪
    if (!this.difyClient.isConfigured()) {
      const msg =
        'Dify API Key 未配置。请在 .env 中设置 DIFY_API_KEY(在 Dify 后台创建工作流应用后获取 app- 前缀的密钥)';
      executionError = new Error(msg);
      const errorEvent: DifySSEEvent = {
        event: 'error',
        data: { status: 400, code: 'dify_not_configured', message: msg },
      };
      allEvents.push(errorEvent);
      yield errorEvent;
    } else {
    try {
      const stream = this.difyClient.runWorkflowStream(
        difyInputs,
        user.username,
      );

      for await (const event of stream) {
        allEvents.push(event);
        yield event; // 透传给前端

        // 实时更新运行记录中的 Dify ID
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
      // 构造一个 error 事件发给前端
      const errorEvent: DifySSEEvent = {
        event: 'error',
        data: {
          status: 500,
          code: 'execution_failed',
          message: err.message,
        },
      };
      allEvents.push(errorEvent);
      yield errorEvent;
    }
    } // end of else (Dify 已配置)

    // 7. 提取执行结果
    const result = this.difyClient.extractResult(allEvents);

    // 8. 扣费结算
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
    } else {
      // 执行成功:计算实际费用并结算
      // 优先使用 Dify 返回的 total_price
      const difyTotalPrice = this.extractDifyTotalPrice(allEvents);
      const actualCost = this.billing.calculateCost(
        result.totalTokens,
        this.extractModelName(flowgram),
        difyTotalPrice,
      );

      await this.billing.settleBilling(
        user.id,
        frozenAmount,
        actualCost,
        runId,
        `Token: ${result.totalTokens}, Steps: ${result.totalSteps}`,
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
        `工作流完成: runId=${runId}, tokens=${result.totalTokens}, cost=${actualCost}`,
      );
    }
  }

  /** 从 SSE 事件中提取 Dify 返回的 total_price */
  private extractDifyTotalPrice(events: DifySSEEvent[]): number | undefined {
    for (const event of events) {
      if (event.event === 'node_finished') {
        const price = event.data?.execution_metadata?.total_price;
        if (price && !isNaN(parseFloat(String(price)))) {
          return parseFloat(String(price));
        }
      }
    }
    return undefined;
  }

  /** 从 FlowGram JSON 中提取第一个 LLM 节点的模型名 */
  private extractModelName(flowgram: FlowGramJSON): string {
    const llmNode = flowgram.nodes.find((n) => n.type === 'llm');
    const modelName = llmNode?.data?.inputsValues?.modelName?.content;
    return modelName ? String(modelName) : 'gpt-3.5-turbo';
  }
}
