import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { DifyConfigService } from './dify-config.service';

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

/**
 * Dify 客户端服务
 * 负责调用 Dify 的 Service API,执行工作流并处理 SSE 流式响应
 *
 * 配置校验委托给 DifyConfigService:
 *  - isConfigured() 检查 API Key 是否为有效的 app- 前缀密钥
 *  - 未配置时返回友好错误信息，由 WorkflowsService 降级处理
 */
@Injectable()
export class DifyClientService {
  private readonly logger = new Logger(DifyClientService.name);

  constructor(private readonly difyConfig: DifyConfigService) {}

  /**
   * 检查 Dify 是否已配置有效的 API Key
   * 委托给 DifyConfigService 进行格式校验
   */
  isConfigured(): boolean {
    return this.difyConfig.isConfigured();
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
    if (!this.isConfigured()) {
      return {
        reachable: false,
        error: 'Dify API Key 未配置',
      };
    }

    const apiBase = this.difyConfig.getApiBase();
    const apiKey = this.difyConfig.getApiKey();
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
      return {
        reachable: false,
        error: `Dify 服务不可达: ${err.message}`,
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
  ): AsyncGenerator<DifySSEEvent> {
    // 二次校验配置
    if (!this.isConfigured()) {
      throw new InternalServerErrorException({
        code: 'dify_not_configured',
        message: this.getNotConfiguredMessage(),
      });
    }

    const apiBase = this.difyConfig.getApiBase();
    const apiKey = this.difyConfig.getApiKey();
    const url = `${apiBase}/workflows/run`;

    this.logger.log(`调用 Dify 工作流: ${url}, user=${user}`);

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
        signal: AbortSignal.timeout(120000), // 2 分钟超时
      });
    } catch (err) {
      this.logger.error(`Dify 连接失败: ${err.message}`);
      throw new InternalServerErrorException(
        `Dify 服务连接失败: ${err.message}。请确认 Dify 已启动且 ${apiBase} 可达。`,
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
          friendlyMessage = 'Dify API Key 无效或已过期，请检查 .env 中的 DIFY_API_KEY';
          break;
        case 404:
          friendlyMessage = `Dify 工作流应用不存在，请确认 API Key 对应的工作流已发布。URL: ${url}`;
          break;
        case 500:
          friendlyMessage = `Dify 内部错误: ${errorText.slice(0, 200)}`;
          break;
        default:
          friendlyMessage = `Dify API 返回错误 ${response.status}: ${errorText.slice(0, 200)}`;
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
    yield* this.parseSSEStream(response.body);
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
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const message of messages) {
          const line = message.trim();
          if (!line) continue;

          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const event: DifySSEEvent = JSON.parse(jsonStr);
              yield event;
            } catch {
              this.logger.warn(`SSE JSON 解析失败: ${jsonStr.slice(0, 100)}`);
            }
          }
        }
      }

      // 处理 buffer 中剩余的数据
      if (buffer.trim().startsWith('data:')) {
        const jsonStr = buffer.trim().slice(5).trim();
        if (jsonStr) {
          try {
            yield JSON.parse(jsonStr);
          } catch {
            // 忽略不完整的最后一条
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
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
}
