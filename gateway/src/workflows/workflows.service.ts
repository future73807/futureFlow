import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { JwtService } from '@nestjs/jwt';
import { User } from '../database/entities/user.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { FlowGramJSON } from '../converter/types';
import { DifyConverterService } from '../converter/dify-converter.service';
import { DifyClientService, DifySSEEvent } from '../dify/dify-client.service';
import { BillingService } from '../billing/billing.service';
import { PermissionChecker } from '../auth/auth.module';
import { WorkflowExecutionGuardService } from './services/workflow-execution-guard.service';
import {
  isSensitiveKey,
  sanitizeWorkflowRunSnapshot,
} from '../security/sensitive-data';
import {
  MEDIA_RUN_TOKEN_INPUT,
  collectNativeMediaCredentialIds,
  isNativeMediaNode,
  mediaIdempotencyInputName,
} from '../converter/native-media-bridge';

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
  /**
   * Dify events are forwarded immediately, but the gateway only retains the
   * handful needed for final billing. These caps bound work performed while a
   * valid (but unexpectedly verbose) upstream stream is still open.
   */
  private readonly maxExecutionEvents = 10_000;
  private readonly maxExecutionEventBytes = 32 * 1024 * 1024;

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly converter: DifyConverterService,
    private readonly difyClient: DifyClientService,
    private readonly billing: BillingService,
    private readonly permissionChecker: PermissionChecker,
    @Optional()
    private readonly executionGuard?: WorkflowExecutionGuardService,
    @Optional()
    private readonly jwtService?: JwtService,
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
      /** The HTTP client left; stop waiting on Dify and refund the reservation. */
      abortSignal?: AbortSignal;
    } = {},
  ): AsyncGenerator<DifySSEEvent> {
    const executableFlowgram = this.applyInputOverrides(flowgram, inputOverrides);
    // Keep the run-input field structure for auditing, but never persist any
    // resolved start-node values in either storage path.
    const runSnapshot = sanitizeWorkflowRunSnapshot(executableFlowgram);
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
    const difyConfigured = await this.difyClient.isConfigured(difyTarget);

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
        flowgramJson: runSnapshot,
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
        flowgramJson: runSnapshot,
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
    // Do not retain the complete event stream: outputs can be large and a
    // long-running workflow otherwise keeps every event alive until it ends.
    let workflowStarted: DifySSEEvent | undefined;
    let workflowFinished: DifySSEEvent | undefined;
    let errorEvent: DifySSEEvent | undefined;
    let receivedEventCount = 0;
    let receivedEventBytes = 0;
    let streamDrained = false;
    let executionError: Error | null = null;

    const recordEvent = (event: DifySSEEvent) => {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      receivedEventCount += 1;
      receivedEventBytes += eventBytes;
      if (
        receivedEventCount > this.maxExecutionEvents
        || receivedEventBytes > this.maxExecutionEventBytes
      ) {
        throw new Error('Dify 事件流超过网关安全限制');
      }
      if (event.event === 'workflow_started') workflowStarted = event;
      if (event.event === 'workflow_finished') workflowFinished = event;
      if (event.event === 'error') errorEvent = event;
    };

    try {
      // A published release was imported into its own Dify app at publish
      // time. Execution is read-only and never serializes other workflows.
      const difyInputs = {
        ...this.converter.extractInputs(executableFlowgram),
        ...this.createNativeMediaExecutionInputs(
          executableFlowgram,
          user,
          runId,
          workflowId,
          executionContext.workflowVersion,
        ),
      };
      const sensitiveValues = this.collectSensitiveExecutionValues(
        executableFlowgram,
        difyInputs,
      );

      const stream = this.difyClient.runWorkflowStream(
        difyInputs,
        user.username,
        difyTarget,
        sensitiveValues,
        executionContext.abortSignal,
      );
      for await (const event of stream) {
        recordEvent(event);
        yield event;
        if (event.event === 'workflow_started' && event.workflow_run_id) {
          await this.runRepo.update(runId, {
            difyWorkflowId: event.data?.id,
            difyTaskId: event.task_id,
          });
        }
      }
      streamDrained = true;
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
      if (!executionContext.abortSignal?.aborted) {
        this.logger.error(`Dify 执行异常: ${executionError.message}`);
        errorEvent = {
          event: 'error',
          data: {
            status: 500,
            code: 'dify_execution_failed',
            message: executionError.message,
          },
        };
        yield errorEvent;
      }
    } finally {
      // `return()` is invoked when an SSE consumer disconnects or otherwise
      // stops iteration. Awaiting this finalizer guarantees the frozen balance
      // cannot remain stranded just because the response was abandoned.
      const result = this.extractResult(
        [workflowStarted, errorEvent, workflowFinished].filter(Boolean) as DifySSEEvent[],
      );
      const executionSucceeded = streamDrained
        && !executionError
        && result.status === 'succeeded';
      if (!executionSucceeded) {
        await this.billing.refund(user.id, frozenAmount, runId);
        const cancelled = !streamDrained && Boolean(
          executionContext.abortSignal?.aborted || !executionError,
        );
        const failureMessage = cancelled
          ? '执行连接已关闭，工作流已取消并退款'
          : result.error
            || executionError?.message
            || `Dify 以非成功状态结束: ${result.status || 'unknown'}`;
        await this.runRepo.update(runId, {
          status: cancelled ? 'cancelled' : 'failed',
          totalTokens: result.totalTokens,
          totalSteps: result.totalSteps,
          elapsedTime: result.elapsedTime,
          errorMessage: failureMessage,
          finishedAt: new Date(),
        });
        this.logger.warn(
          `工作流未完成: runId=${runId}, error=${failureMessage}`,
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

  /**
   * Tracks invocation values used by API credential fields so an upstream
   * service cannot echo them back through otherwise legitimate node outputs.
   */
  private collectSensitiveExecutionValues(
    flowgram: FlowGramJSON,
    inputs: Record<string, any>,
  ): string[] {
    const secrets = new Set<string>();
    const startNodeIds = new Set(
      flowgram.nodes.filter((node) => node.type === 'start').map((node) => node.id),
    );
    const addSecret = (candidate: unknown) => {
      if (!['string', 'number', 'boolean'].includes(typeof candidate)) return;
      const value = String(candidate);
      if (!value) return;
      secrets.add(value);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) secrets.add(encoded);
    };
    const addFlowValue = (flowValue: any) => {
      if (['string', 'number', 'boolean'].includes(typeof flowValue)) {
        addSecret(flowValue);
        return;
      }
      if (!flowValue || typeof flowValue !== 'object') return;
      if (flowValue.type === 'constant') {
        addSecret(flowValue.content);
        return;
      }
      if (flowValue.type === 'ref' && Array.isArray(flowValue.content)) {
        const [nodeId, key] = flowValue.content.map(String);
        if (startNodeIds.has(nodeId)) addSecret(inputs[key]);
        return;
      }
      if (flowValue.type !== 'template' || typeof flowValue.content !== 'string') return;
      let matchedReference = false;
      const referencePattern = /\{\{#?([^.#{}\s]+)\.([^#{}\s]+)#?\}\}/g;
      for (const match of flowValue.content.matchAll(referencePattern)) {
        matchedReference = true;
        if (startNodeIds.has(match[1])) addSecret(inputs[match[2]]);
      }
      if (!matchedReference) addSecret(flowValue.content);
    };
    const constantText = (flowValue: any): string | null => {
      if (['string', 'number', 'boolean'].includes(typeof flowValue)) return String(flowValue);
      if (flowValue?.type !== 'constant') return null;
      return ['string', 'number', 'boolean'].includes(typeof flowValue.content)
        ? String(flowValue.content)
        : null;
    };

    for (const [key, value] of Object.entries(inputs)) {
      if (isSensitiveKey(key)) addSecret(value);
    }

    for (const node of flowgram.nodes.filter((candidate) => candidate.type === 'http')) {
      const authorization = node.data.authorization || { type: 'none' };
      if (authorization.type === 'bearer') {
        addFlowValue(authorization.token);
      } else if (authorization.type === 'api-key') {
        addFlowValue(authorization.apiKey);
      } else if (authorization.type === 'basic') {
        const username = constantText(authorization.username);
        const password = constantText(authorization.password);
        if (password !== null) addSecret(password);
        if (username !== null && password !== null) {
          addSecret(Buffer.from(`${username}:${password}`, 'utf8').toString('base64'));
        }
      }

      for (const [headerName, value] of Object.entries(node.data.headersValues || {})) {
        if (isSensitiveKey(headerName)) addFlowValue(value);
      }
      for (const [parameterName, value] of Object.entries(node.data.paramsValues || {})) {
        if (isSensitiveKey(parameterName)) addFlowValue(value);
      }
    }

    return Array.from(secrets);
  }

  /**
   * Dify receives only a short-lived, run-scoped Gateway token and one fresh
   * idempotency key per charge-creating node. Provider API keys remain in the
   * encrypted media credential store and never enter the DSL or run archive.
   */
  private createNativeMediaExecutionInputs(
    flowgram: FlowGramJSON,
    user: User,
    runId: string,
    workflowId?: string,
    workflowVersion?: number,
  ): Record<string, string> {
    const mediaNodes = flowgram.nodes.filter(isNativeMediaNode);
    if (mediaNodes.length === 0) return {};
    if (!workflowId || !workflowVersion) {
      throw new BadRequestException('原生媒体节点只能运行已发布的工作流版本');
    }
    if (!this.jwtService) {
      throw new BadRequestException('媒体执行令牌服务未初始化');
    }

    const token = this.jwtService.sign(
      {
        sub: user.id,
        type: 'media_execution',
        workflowId,
        workflowVersion,
        runId,
        credentialIds: collectNativeMediaCredentialIds(flowgram),
      },
      { expiresIn: '15m' },
    );
    const inputs: Record<string, string> = { [MEDIA_RUN_TOKEN_INPUT]: token };
    for (const node of mediaNodes) {
      const operation = node.type === 'video'
        ? String(node.data.media?.operation || 'create')
        : 'create';
      if (operation !== 'query') {
        inputs[mediaIdempotencyInputName(node.id)] = uuidv4();
      }
    }
    return inputs;
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
    const startIndex = flowgram.nodes.findIndex((node) => node.type === 'start');
    if (startIndex < 0) {
      throw new BadRequestException('工作流缺少开始节点，无法接收运行参数');
    }

    const originalStartNode = flowgram.nodes[startIndex];
    const outputSchema = originalStartNode.data.outputs as any;
    const properties = (outputSchema?.properties || {}) as Record<
      string,
      any
    >;
    const required = new Set<string>(
      Array.isArray(outputSchema?.required)
        ? outputSchema.required.map(String)
        : [],
    );
    const defaults = originalStartNode.data.inputsValues || {};
    const isMissing = (value: unknown) =>
      value === undefined
      || value === null
      || (typeof value === 'string' && !value.trim());

    for (const key of required) {
      const supplied = Object.prototype.hasOwnProperty.call(inputs, key)
        ? inputs[key]
        : defaults[key]?.content ?? properties[key]?.default;
      if (isMissing(supplied)) {
        throw new BadRequestException(`缺少必填工作流输入参数: ${key}`);
      }
    }

    if (Object.keys(inputs).length === 0) return flowgram;

    const copied = JSON.parse(JSON.stringify(flowgram)) as FlowGramJSON;
    const startNode = copied.nodes[startIndex];

    for (const [key, value] of Object.entries(inputs)) {
      if (!(key in properties)) {
        throw new BadRequestException(`未知的工作流输入参数: ${key}`);
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new BadRequestException(`输入参数 ${key} 仅支持字符串、数字或布尔值`);
      }
      const expectedType = (properties[key] as any)?.type;
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

    startNode.data.inputsValues = { ...(startNode.data.inputsValues || {}) };
    for (const [key, value] of Object.entries(inputs)) {
      startNode.data.inputsValues[key] = { type: 'constant', content: value };
    }

    return copied;
  }
}
