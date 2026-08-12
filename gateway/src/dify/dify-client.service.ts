import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { DifyConfigService } from './dify-config.service';
import { DifyIntegrationService } from './dify-integration.service';
import {
  redactInputValues,
  redactSensitiveValues,
  sanitizeSensitiveData,
} from '../security/sensitive-data';

/**
 * Dify SSE 事件类型
 */
export interface DifySSEEvent {
  event: string;
  task_id?: string;
  workflow_run_id?: string;
  data?: any;
}

/**
 * 工作流执行结果汇总(从 SSE 流中提取)
 */
export interface WorkflowExecutionResult {
  workflowRunId: string;
  taskId: string;
  status: string;
  totalTokens: number;
  totalSteps: number;
  elapsedTime: number;
  outputs: Record<string, any>;
  error?: string;
}

export interface DifyExecutionTarget {
  workflowId?: string;
  workflowVersion?: number;
}

/**
 * Dify 客户端服务
 * 负责调用 Dify 的 Service API,执行工作流并处理 SSE 流式响应
 *
 * 配置校验委托给 DifyConfigService:
 *  - isConfigured() 检查 API Key 是否为有效的 app- 前缀密钥
 *  - 未配置时 WorkflowsService 将报错
 */
@Injectable()
export class DifyClientService {
  private readonly logger = new Logger(DifyClientService.name);
  private readonly maxSseEventBytes = 8 * 1024 * 1024;

  constructor(
    private readonly difyConfig: DifyConfigService,
    private readonly integration: DifyIntegrationService,
  ) {}

  /**
   * 检查 Dify 是否已配置有效的 API Key
   * 委托给 DifyConfigService 进行格式校验
   */
  async isConfigured(target: DifyExecutionTarget = {}): Promise<boolean> {
    const apiKey = await this.resolveApiKey(target);
    return this.difyConfig.isValidApiKey(apiKey);
  }

  /**
   * 获取未配置时的友好提示信息
   */
  getNotConfiguredMessage(): string {
    const v = this.difyConfig.getValidation();
    return `Dify API Key 未配置。${v.message}。${v.suggestion}`;
  }

  /**
   * 探测 Dify 服务是否可达（不执行工作流，仅检查连通性）
   * 用于健康检查
   */
  async ping(): Promise<{ reachable: boolean; latency?: number; error?: string }> {
    if (!(await this.isConfigured())) {
      return {
        reachable: false,
        error: 'Dify API Key 未配置',
      };
    }

    const apiBase = this.difyConfig.getApiBase();
    const apiKey = await this.resolveApiKey();
    const start = Date.now();

    try {
      // 调用一个轻量级接口检查连通性
      const url = `${apiBase.replace(/\/v1\/?$/, '')}/v1/workflows/run`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: {},
          response_mode: 'blocking',
          user: 'health-check',
        }),
        signal: AbortSignal.timeout(5000), // 5 秒超时
      });

      const latency = Date.now() - start;

      // 401/403 说明 Key 无效，但服务可达
      if (response.status === 401 || response.status === 403) {
        return {
          reachable: true,
          latency,
          error: `Dify 服务可达，但 API Key 无效 (${response.status})`,
        };
      }

      // 其他状态码都说明服务可达
      return { reachable: true, latency };
    } catch (err) {
      this.logger.warn(`Dify 健康检查失败: ${err instanceof Error ? err.message : String(err)}`);
      return {
        reachable: false,
        error: 'Dify 服务不可达，请检查网络连接和服务状态',
      };
    }
  }

  /**
   * 执行工作流(流式模式)
   * 调用 POST /v1/workflows/run,response_mode=streaming
   *
   * @param inputs 工作流输入变量
   * @param user 用户标识
   * @returns AsyncGenerator 逐个 yield SSE 事件
   * @throws InternalServerErrorException 当 Dify 未配置或调用失败时
   */
  async *runWorkflowStream(
    inputs: Record<string, any>,
    user: string,
    target: DifyExecutionTarget = {},
    sensitiveValues: readonly string[] = [],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<DifySSEEvent> {
    // 二次校验配置
    if (!(await this.isConfigured(target))) {
      throw new InternalServerErrorException({
        code: 'dify_not_configured',
        message: this.getNotConfiguredMessage(),
      });
    }

    const apiBase = this.difyConfig.getApiBase();
    const apiKey = await this.resolveApiKey(target);
    const url = `${apiBase}/workflows/run`;

    this.logger.log(
      `调用 Dify 工作流: ${url}, user=${user}, target=${target.workflowId ? `${target.workflowId}@v${target.workflowVersion}` : 'legacy'}`,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs,
          response_mode: 'streaming',
          user,
        }),
        signal: abortSignal
          ? AbortSignal.any([AbortSignal.timeout(120000), abortSignal])
          : AbortSignal.timeout(120000), // 2 分钟超时
      });
    } catch (err) {
      this.logger.error(
        `Dify 连接失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'Dify 服务连接失败，请确认服务已启动且配置地址可达。',
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(
        `Dify API 错误: ${response.status} ${errorText.slice(0, 500)}`,
      );

      // 友好的错误消息
      let friendlyMessage: string;
      switch (response.status) {
        case 401:
          friendlyMessage = 'Dify 访问凭据无效或已过期，请重新发布工作流或更新 Dify 配置。';
          break;
        case 404:
          friendlyMessage = 'Dify 工作流应用不存在，请重新发布工作流后再试。';
          break;
        case 500:
          friendlyMessage = 'Dify 服务内部错误，请稍后重试。';
          break;
        default:
          friendlyMessage = `Dify 请求失败（状态码 ${response.status}），请检查服务状态后重试。`;
      }

      throw new InternalServerErrorException({
        code: 'dify_api_error',
        status: response.status,
        message: friendlyMessage,
      });
    }

    if (!response.body) {
      throw new InternalServerErrorException('Dify 返回空响应体');
    }

    // 解析 SSE 流
    for await (const event of this.parseSSEStream(response.body)) {
      yield this.localizeExecutionEvent(event, sensitiveValues);
    }
  }

  private localizeExecutionEvent(
    event: DifySSEEvent,
    sensitiveValues: readonly string[] = [],
  ): DifySSEEvent {
    // Dify emits resolved inputs on workflow/node events. Hide every input
    // value regardless of its user-defined name, while keeping the object
    // shape useful for diagnostics. Outputs remain the intentional result.
    const hasOutputs = event.data
      && Object.prototype.hasOwnProperty.call(event.data, 'outputs');
    const isStartNode = event.data?.node_type === 'start';
    const hasExecutionDetails = event.data
      && (
        Object.prototype.hasOwnProperty.call(event.data, 'inputs')
        || Object.prototype.hasOwnProperty.call(event.data, 'process_data')
        || hasOutputs
      );
    const safeEvent = hasExecutionDetails
      ? {
          ...event,
          data: {
            ...(event.data || {}),
            inputs: redactInputValues(event.data?.inputs),
            process_data: sanitizeSensitiveData(event.data?.process_data, 'process_data'),
            outputs: isStartNode
              ? redactInputValues(event.data?.outputs)
              : sanitizeSensitiveData(event.data?.outputs, 'outputs'),
          },
        }
      : event;

    let localizedEvent = safeEvent;
    if (safeEvent.event === 'error') {
      localizedEvent = {
        ...safeEvent,
        data: {
          ...(safeEvent.data || {}),
          message: 'Dify 执行失败，请检查节点配置或服务状态后重试。',
        },
      };
    } else if (
      (safeEvent.event === 'node_finished' || safeEvent.event === 'workflow_finished')
      && safeEvent.data?.status !== 'succeeded'
      && safeEvent.data?.error
    ) {
      localizedEvent = {
        ...safeEvent,
        data: {
          ...safeEvent.data,
          error: safeEvent.event === 'node_finished'
            ? '节点执行失败，请检查该节点配置后重试。'
            : '工作流执行失败，请检查失败节点配置后重试。',
        },
      };
    }

    return redactSensitiveValues(localizedEvent, sensitiveValues);
  }

  /**
   * 解析 SSE 流(text/event-stream)
   * Dify SSE 格式:每条消息为 `data: {json}\n\n`
   */
  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<DifySSEEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按双换行分割 SSE 消息
        const messages = buffer.split(/\r?\n\r?\n/);
        buffer = messages.pop() || '';
        if (Buffer.byteLength(buffer, 'utf8') > this.maxSseEventBytes) {
          throw new InternalServerErrorException({
            code: 'dify_sse_event_too_large',
            message: 'Dify 返回的单个事件超过安全大小限制',
          });
        }

        for (const message of messages) {
          const jsonStr = message
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (!jsonStr) continue;
          yield this.parseSseEvent(jsonStr);
        }
      }

      buffer += decoder.decode();
      // SSE 事件必须由空行结束；EOF 时仍有内容说明响应被截断。
      if (buffer.trim()) {
        throw new InternalServerErrorException({
          code: 'dify_sse_truncated',
          message: 'Dify 事件流提前结束，最后一条事件不完整',
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseEvent(jsonStr: string): DifySSEEvent {
    if (Buffer.byteLength(jsonStr, 'utf8') > this.maxSseEventBytes) {
      throw new InternalServerErrorException({
        code: 'dify_sse_event_too_large',
        message: 'Dify 返回的单个事件超过安全大小限制',
      });
    }

    let event: unknown;
    try {
      event = JSON.parse(jsonStr);
    } catch {
      this.logger.warn(`Dify SSE JSON 解析失败（${jsonStr.length} 字符）`);
      throw new InternalServerErrorException({
        code: 'dify_sse_malformed',
        message: 'Dify 返回了格式损坏的事件流',
      });
    }

    if (
      !event
      || typeof event !== 'object'
      || typeof (event as DifySSEEvent).event !== 'string'
      || !(event as DifySSEEvent).event.trim()
    ) {
      throw new InternalServerErrorException({
        code: 'dify_sse_invalid_event',
        message: 'Dify 返回了缺少事件类型的无效数据',
      });
    }
    return event as DifySSEEvent;
  }

  /**
   * 从 SSE 事件流中提取执行结果汇总
   */
  extractResult(events: DifySSEEvent[]): WorkflowExecutionResult {
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

    const data = workflowFinished?.data || {};
    return {
      workflowRunId: workflowFinished?.workflow_run_id || '',
      taskId: workflowFinished?.task_id || '',
      status: data.status || 'unknown',
      totalTokens: data.total_tokens || 0,
      totalSteps: data.total_steps || 0,
      elapsedTime: data.elapsed_time || 0,
      outputs: data.outputs || {},
      error: data.error,
    };
  }

  /**
   * 从 SSE 事件流中累计 token 用量
   */
  accumulateTokenUsage(events: DifySSEEvent[]): number {
    let totalTokens = 0;
    for (const event of events) {
      if (event.event === 'node_finished') {
        const metadata = event.data?.execution_metadata;
        if (metadata?.total_tokens) {
          totalTokens += metadata.total_tokens;
        }
      }
    }
    return totalTokens;
  }

  private async resolveApiKey(target: DifyExecutionTarget = {}): Promise<string> {
    if (target.workflowId && target.workflowVersion) {
      // Never fall back to a global app for a published workflow. Doing so
      // could execute a different workflow after an unrelated import.
      return this.integration.resolveWorkflowOrLegacyApiKey(
        target.workflowId,
        target.workflowVersion,
        this.difyConfig.getApiKey(),
      );
    }
    return this.integration.resolveServiceApiKey(this.difyConfig.getApiKey());
  }
}
