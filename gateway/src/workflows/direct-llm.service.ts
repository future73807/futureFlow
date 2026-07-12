import { Injectable, Logger } from '@nestjs/common';
import { FlowGramJSON, FlowNodeJSON } from '../converter/types';
import { DifySSEEvent } from '../dify/dify-client.service';

/**
 * 直接 LLM 执行服务（绕过 Dify）
 * 从 FlowGram JSON 中提取 LLM 节点配置，直接调用 OpenAI 兼容 API
 * 以与 Dify SSE 相同的事件格式返回，前端无需改动
 */
@Injectable()
export class DirectLlmService {
  private readonly logger = new Logger(DirectLlmService.name);

  /**
   * 直接执行工作流（流式）
   * 遍历节点拓扑，按顺序执行 LLM 节点，以 SSE 事件返回
   */
  async *runDirect(
    flowgram: FlowGramJSON,
    user: string,
  ): AsyncGenerator<DifySSEEvent> {
    const startTime = Date.now();
    const runId = `direct-${Date.now()}`;
    let totalTokens = 0;
    let totalSteps = 0;

    // 1. workflow_started
    yield {
      event: 'workflow_started',
      task_id: runId,
      workflow_run_id: runId,
      data: { id: runId },
    };

    // 2. 按拓扑顺序执行节点
    const orderedNodes = this.topologicalSort(flowgram);
    let lastOutput = '';

    for (const node of orderedNodes) {
      if (node.type === 'start') {
        // start 节点：yield node_started + node_finished
        const nodeId = node.id;
        yield {
          event: 'node_started',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || 'Start',
            node_type: 'start',
          },
        };

        const startInputs = this.extractStartInputs(node);
        yield {
          event: 'node_finished',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || 'Start',
            node_type: 'start',
            status: 'succeeded',
            outputs: startInputs,
            execution_metadata: { total_tokens: 0 },
          },
        };
        totalSteps++;
      } else if (node.type === 'llm') {
        const nodeId = node.id;
        const nodeTitle = node.data.title || 'LLM';

        // node_started
        yield {
          event: 'node_started',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: nodeTitle,
            node_type: 'llm',
          },
        };

        // 调用 LLM API
        try {
          const llmConfig = this.extractLlmConfig(node, flowgram, lastOutput);
          this.logger.log(
            `直接调用 LLM: model=${llmConfig.model}, host=${llmConfig.apiHost}`,
          );

          const result = await this.callLlmApi(llmConfig);
          lastOutput = result.text;
          totalTokens += result.tokens;

          // text_chunk（流式输出模拟，一次性返回完整文本）
          yield {
            event: 'text_chunk',
            task_id: runId,
            data: { text: result.text },
          };

          // node_finished
          yield {
            event: 'node_finished',
            task_id: runId,
            data: {
              node_id: nodeId,
              title: nodeTitle,
              node_type: 'llm',
              status: 'succeeded',
              outputs: { text: result.text, result: result.text },
              execution_metadata: { total_tokens: result.tokens },
            },
          };
        } catch (err) {
          this.logger.error(`LLM 调用失败: ${err.message}`);
          yield {
            event: 'node_finished',
            task_id: runId,
            data: {
              node_id: nodeId,
              title: nodeTitle,
              node_type: 'llm',
              status: 'failed',
              outputs: {},
              error: err.message,
              execution_metadata: { total_tokens: 0 },
            },
          };
          throw err;
        }
        totalSteps++;
      } else if (node.type === 'end') {
        const nodeId = node.id;
        yield {
          event: 'node_started',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || 'End',
            node_type: 'end',
          },
        };

        yield {
          event: 'node_finished',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || 'End',
            node_type: 'end',
            status: 'succeeded',
            outputs: { result: lastOutput },
            execution_metadata: { total_tokens: 0 },
          },
        };
        totalSteps++;
      } else if (node.type === 'http' || node.type === 'code') {
        // http/code 节点暂不直接执行，跳过
        const nodeId = node.id;
        yield {
          event: 'node_started',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || node.type,
            node_type: node.type,
          },
        };
        yield {
          event: 'node_finished',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || node.type,
            node_type: node.type,
            status: 'succeeded',
            outputs: { result: '(skipped in direct mode)' },
            execution_metadata: { total_tokens: 0 },
          },
        };
        totalSteps++;
      }
    }

    // 3. workflow_finished
    const elapsedTime = (Date.now() - startTime) / 1000;
    yield {
      event: 'workflow_finished',
      task_id: runId,
      workflow_run_id: runId,
      data: {
        status: 'succeeded',
        total_tokens: totalTokens,
        total_steps: totalSteps,
        elapsed_time: parseFloat(elapsedTime.toFixed(2)),
        outputs: { result: lastOutput },
      },
    };
  }

  /**
   * 拓扑排序：根据 edges 确定节点执行顺序
   */
  private topologicalSort(flowgram: FlowGramJSON): FlowNodeJSON[] {
    const { nodes, edges } = flowgram;
    const inDegree: Record<string, number> = {};
    const adjList: Record<string, string[]> = {};

    for (const node of nodes) {
      inDegree[node.id] = 0;
      adjList[node.id] = [];
    }

    for (const edge of edges) {
      adjList[edge.sourceNodeID]?.push(edge.targetNodeID);
      inDegree[edge.targetNodeID] = (inDegree[edge.targetNodeID] || 0) + 1;
    }

    const queue: string[] = [];
    for (const node of nodes) {
      if (inDegree[node.id] === 0) queue.push(node.id);
    }

    const sorted: FlowNodeJSON[] = [];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = nodes.find((n) => n.id === nodeId);
      if (node) sorted.push(node);

      for (const neighbor of adjList[nodeId] || []) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) queue.push(neighbor);
      }
    }

    // 如果有环或未排序的节点，追加到末尾
    for (const node of nodes) {
      if (!sorted.find((n) => n.id === node.id)) {
        sorted.push(node);
      }
    }

    return sorted;
  }

  /**
   * 提取 Start 节点的输入变量
   */
  private extractStartInputs(node: FlowNodeJSON): Record<string, any> {
    const properties = (node.data.outputs?.properties || {}) as Record<
      string,
      any
    >;
    const inputsValues = node.data.inputsValues || {};
    const inputs: Record<string, any> = {};

    for (const key of Object.keys(properties)) {
      const val = inputsValues[key];
      if (val && val.content !== undefined) {
        inputs[key] = val.content;
      } else if (properties[key].default !== undefined) {
        inputs[key] = properties[key].default;
      } else {
        inputs[key] = properties[key].type === 'number' ? 0 : '';
      }
    }
    return inputs;
  }

  /**
   * 从 LLM 节点提取配置
   */
  private extractLlmConfig(
    node: FlowNodeJSON,
    flowgram: FlowGramJSON,
    lastOutput: string,
  ): {
    model: string;
    apiKey: string;
    apiHost: string;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
  } {
    const iv = node.data.inputsValues || {};
    const get = (key: string, def: any) => {
      const v = iv[key];
      return v && v.content !== undefined ? v.content : def;
    };

    let userPrompt = String(get('prompt', ''));
    // 替换变量引用 {{start_0.query}} → 用实际输入值
    userPrompt = this.resolveVariableRefs(userPrompt, flowgram);
    // 如果 prompt 为空但上游有输出，使用上游输出
    if (!userPrompt && lastOutput) userPrompt = lastOutput;

    return {
      model: String(get('modelName', 'deepseek-v4-pro')),
      apiKey: String(get('apiKey', '')),
      apiHost: String(get('apiHost', 'https://api.deepseek.com')),
      temperature: parseFloat(String(get('temperature', 0.7))),
      systemPrompt: String(get('systemPrompt', '')),
      userPrompt,
    };
  }

  /**
   * 解析变量引用 {{nodeId.variable}} → 实际值
   */
  private resolveVariableRefs(
    text: string,
    flowgram: FlowGramJSON,
  ): string {
    if (!text) return text;
    return text.replace(
      /\{\{([^}]+)\}\}/g,
      (match, inner: string) => {
        const parts = inner.trim().split('.');
        if (parts.length >= 2) {
          const nodeId = parts[0];
          const varName = parts[1];
          const node = flowgram.nodes.find((n) => n.id === nodeId);

          if (node?.type === 'start') {
            // 从 start 节点获取输入值
            const properties = (node.data.outputs?.properties || {}) as Record<
              string,
              any
            >;
            const inputsValues = node.data.inputsValues || {};
            const val = inputsValues[varName];
            if (val && val.content !== undefined) return String(val.content);
            if (properties[varName]?.default !== undefined)
              return String(properties[varName].default);
          }
        }
        return match; // 未找到，保留原样
      },
    );
  }

  /**
   * 调用 OpenAI 兼容 API（DeepSeek / OpenAI 等）
   */
  private async callLlmApi(config: {
    model: string;
    apiKey: string;
    apiHost: string;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string; tokens: number }> {
    const url = `${config.apiHost.replace(/\/$/, '')}/v1/chat/completions`;

    const messages: any[] = [];
    if (config.systemPrompt) {
      messages.push({ role: 'system', content: config.systemPrompt });
    }
    messages.push({ role: 'user', content: config.userPrompt || '你好' });

    this.logger.log(`调用 LLM API: ${url}, model=${config.model}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`LLM API 错误: ${response.status} ${errorText}`);
      throw new Error(
        `LLM API 调用失败 (${response.status}): ${errorText.slice(0, 200)}`,
      );
    }

    const data = await response.json();
    const text =
      data.choices?.[0]?.message?.content || '(空回复)';
    const tokens =
      data.usage?.total_tokens || data.usage?.completion_tokens || 0;

    this.logger.log(`LLM 返回: tokens=${tokens}, text=${text.slice(0, 80)}...`);

    return { text, tokens };
  }
}
