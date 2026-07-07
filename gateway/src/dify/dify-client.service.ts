import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 */
@Injectable()
export class DifyClientService {
  private readonly logger = new Logger(DifyClientService.name);
  private readonly apiBase: string;
  private readonly apiKey: string;

  constructor(private config: ConfigService) {
    this.apiBase = this.config.get<string>('DIFY_API_BASE', 'http://localhost/v1');
    this.apiKey = this.config.get<string>('DIFY_API_KEY', '');
  }

  /** 检查 Dify 是否已配置有效的 API Key */
  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey !== 'app-xxxxxxxxxxxxxxxx';
  }

  /**
   * 执行工作流(流式模式)
   * 调用 POST /v1/workflows/run,response_mode=streaming
   *
   * @param inputs 工作流输入变量
   * @param user 用户标识
   * @returns AsyncGenerator 逐个 yield SSE 事件
   */
  async *runWorkflowStream(
    inputs: Record<string, any>,
    user: string,
  ): AsyncGenerator<DifySSEEvent> {
    const url = `${this.apiBase}/workflows/run`;

    this.logger.log(`调用 Dify 工作流: ${url}, user=${user}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs,
        response_mode: 'streaming',
        user,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Dify API 错误: ${response.status} ${errorText}`);
      throw new InternalServerErrorException(
        `Dify 执行失败: ${response.status} ${errorText}`,
      );
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
        buffer = messages.pop() || ''; // 最后一段可能不完整,保留

        for (const message of messages) {
          const line = message.trim();
          if (!line) continue;

          // SSE 行格式: "data: {json}" 或 "event: xxx" 或 ": ping"
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const event: DifySSEEvent = JSON.parse(jsonStr);
              yield event;
            } catch (e) {
              this.logger.warn(`SSE JSON 解析失败: ${jsonStr}`);
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
   * 在流结束后调用
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
   * 用于执行过程中实时扣费
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
