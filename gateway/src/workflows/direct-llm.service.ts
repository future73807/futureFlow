import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlowGramJSON, FlowNodeJSON } from '../converter/types';
import { DifySSEEvent } from '../dify/dify-client.service';

/**
 * 直接 LLM 执行服务（绕过 Dify）
 * 从环境变量读取 API Key 和 Host，直接调用 OpenAI 兼容 API
 * 以与 Dify SSE 相同的事件格式返回，前端无需改动
 *
 * 环境变量:
 *   LLM_API_KEY  - 大模型 API Key（默认 DeepSeek）
 *   LLM_API_HOST - 大模型 API 地址（默认 https://api.deepseek.com）
 */
@Injectable()
export class DirectLlmService {
  private readonly logger = new Logger(DirectLlmService.name);
  private readonly defaultApiKey: string;
  private readonly defaultApiHost: string;
  private readonly defaultModel: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.defaultApiKey = this.config.get<string>('LLM_API_KEY', '').trim();
    this.defaultApiHost = this.config
      .get<string>('LLM_API_HOST', 'https://api.deepseek.com')
      .trim();
    this.defaultModel = this.config
      .get<string>('LLM_DEFAULT_MODEL', 'deepseek-chat')
      .trim();
    this.requestTimeoutMs = Number.parseInt(
      this.config.get<string>('LLM_REQUEST_TIMEOUT_MS', '120000'),
      10,
    ) || 120000;
  }

  private isNodeReachable(
    node: FlowNodeJSON,
    flowgram: FlowGramJSON,
    executedNodes: Set<string>,
    selectedBranches: Map<string, string>,
  ) {
    if (node.type === 'start') return true;
    const incoming = flowgram.edges.filter((edge) => edge.targetNodeID === node.id);
    if (incoming.length === 0) return false;
    return incoming.some((edge) => {
      if (!executedNodes.has(edge.sourceNodeID)) return false;
      const selected = selectedBranches.get(edge.sourceNodeID);
      return !selected || selected === edge.sourcePortID;
    });
  }

  private evaluateConditionNode(
    node: FlowNodeJSON,
    outputs: Map<string, Record<string, unknown>>,
  ) {
    const cases = Array.isArray(node.data.branch) && node.data.branch.length > 0
      ? node.data.branch.map((branch, index) => ({
          key: branch.key || `branch.${index}`,
          logic: branch.logic === 'or' ? 'or' : 'and',
          conditions: branch.conditions || [],
        }))
      : (node.data.conditions || []).map((condition) => ({
          key: condition.key,
          logic: 'and' as const,
          conditions: [condition],
        }));

    for (const entry of cases) {
      const results = entry.conditions.map((condition) =>
        this.evaluateConditionAtom(condition.value, outputs),
      );
      const matched = entry.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
      if (matched) return entry.key;
    }
    return 'else';
  }

  private evaluateConditionAtom(
    value: any,
    outputs: Map<string, Record<string, unknown>>,
  ) {
    const left = this.resolveReference(value?.left, outputs);
    const operator = this.normalizeComparisonOperator(value?.operator);
    if (operator === 'empty') return left === '' || left === null || left === undefined;
    if (operator === 'not empty') return !(left === '' || left === null || left === undefined);
    if (!value?.right || value.right.type !== 'constant') {
      throw new Error('条件右值当前仅支持常量');
    }
    const right = value.right.content;
    switch (operator) {
      case 'is': return left === right || String(left) === String(right);
      case 'is not': return !(left === right || String(left) === String(right));
      case 'contains': return String(left ?? '').includes(String(right));
      case 'not contains': return !String(left ?? '').includes(String(right));
      case '>': return Number(left) > Number(right);
      case '<': return Number(left) < Number(right);
      case '≥': return Number(left) >= Number(right);
      case '≤': return Number(left) <= Number(right);
      default: throw new Error(`不支持的条件比较符: ${operator}`);
    }
  }

  private resolveReference(value: any, outputs: Map<string, Record<string, unknown>>): unknown {
    if (!value || value.type !== 'ref' || !value.content) {
      throw new Error('条件左值必须引用工作流变量');
    }
    const path = Array.isArray(value.content)
      ? value.content.map(String)
      : String(value.content).split('.');
    let result: unknown = outputs.get(path.shift() || '');
    for (const segment of path) {
      if (!result || typeof result !== 'object' || !(segment in result)) return undefined;
      result = (result as Record<string, unknown>)[segment];
    }
    return result;
  }

  private normalizeComparisonOperator(value: unknown): string {
    const operator = String(value || '').trim().toLowerCase();
    const aliases: Record<string, string> = {
      '=': 'is', '==': 'is', '===': 'is', equal: 'is', equals: 'is', is: 'is',
      '!=': 'is not', '!==': 'is not', '≠': 'is not', 'is not': 'is not',
      contains: 'contains', 'not contains': 'not contains',
      '>': '>', '<': '<', '>=': '≥', '≥': '≥', '<=': '≤', '≤': '≤',
      empty: 'empty', 'is empty': 'empty', 'not empty': 'not empty', 'is not empty': 'not empty',
    };
    if (!aliases[operator]) throw new Error(`不支持的条件比较符: ${String(value)}`);
    return aliases[operator];
  }

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
    const nodeOutputs = new Map<string, Record<string, unknown>>();
    const executedNodes = new Set<string>();
    const selectedBranches = new Map<string, string>();

    for (const node of orderedNodes) {
      if (!this.isNodeReachable(node, flowgram, executedNodes, selectedBranches)) {
        continue;
      }
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
        nodeOutputs.set(nodeId, startInputs);
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
        executedNodes.add(nodeId);
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
          const llmConfig = this.extractLlmConfig(node, nodeOutputs, lastOutput);
          this.logger.log(
            `直接调用 LLM: model=${llmConfig.model}, host=${llmConfig.apiHost}`,
          );

          const result = await this.callLlmApi(llmConfig);
          lastOutput = result.text;
          totalTokens += result.tokens;
          nodeOutputs.set(nodeId, {
            text: result.text,
            result: result.text,
          });

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
          executedNodes.add(nodeId);
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
      } else if (node.type === 'condition' || node.type === 'multi-condition') {
        const nodeId = node.id;
        const selectedBranch = this.evaluateConditionNode(node, nodeOutputs);
        selectedBranches.set(nodeId, selectedBranch);
        nodeOutputs.set(nodeId, { selectedBranch });
        yield {
          event: 'node_started',
          task_id: runId,
          data: { node_id: nodeId, title: node.data.title || '条件分支', node_type: 'if-else' },
        };
        yield {
          event: 'node_finished',
          task_id: runId,
          data: {
            node_id: nodeId,
            title: node.data.title || '条件分支',
            node_type: 'if-else',
            status: 'succeeded',
            outputs: { selectedBranch },
            execution_metadata: { total_tokens: 0 },
          },
        };
        totalSteps++;
        executedNodes.add(nodeId);
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
        executedNodes.add(nodeId);
      } else if (node.type === 'http' || node.type === 'code') {
        // 防御性兜底：WorkflowsService 会在冻结余额前拒绝这些节点。
        const nodeId = node.id;
        const errorMessage = `直接 LLM 模式不支持 ${node.type} 节点，请配置 Dify 执行引擎`;
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
            status: 'failed',
            outputs: {},
            error: errorMessage,
            execution_metadata: { total_tokens: 0 },
          },
        };
        throw new Error(errorMessage);
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
   * apiKey 和 apiHost 从环境变量读取，而非节点数据
   */
  private extractLlmConfig(
    node: FlowNodeJSON,
    nodeOutputs: Map<string, Record<string, unknown>>,
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
    // 将 {{nodeId.variable}} 替换为已执行上游节点的实际输出。
    userPrompt = this.resolveVariableRefs(userPrompt, nodeOutputs);
    // 如果 prompt 为空但上游有输出，使用上游输出
    if (!userPrompt && lastOutput) userPrompt = lastOutput;

    return {
      model: String(get('modelName', this.defaultModel)),
      // API Key 和 Host 从环境变量读取，用户无需在画布上配置
      apiKey: this.defaultApiKey,
      apiHost: this.defaultApiHost,
      temperature: parseFloat(String(get('temperature', 0.7))),
      systemPrompt: this.resolveVariableRefs(
        String(get('systemPrompt', '')),
        nodeOutputs,
      ),
      userPrompt,
    };
  }

  /**
   * 解析变量引用 {{nodeId.variable}} → 已执行节点的实际输出。
   * 支持 {{nodeId.variable.subfield}} 形式的对象字段访问。
   */
  private resolveVariableRefs(
    text: string,
    nodeOutputs: Map<string, Record<string, unknown>>,
  ): string {
    if (!text) return text;
    return text.replace(
      /\{\{([^}]+)\}\}/g,
      (match, inner: string) => {
        const [nodeId, ...path] = inner.trim().split('.');
        if (!nodeId || path.length === 0) return match;

        let value: unknown = nodeOutputs.get(nodeId);
        for (const segment of path) {
          if (!value || typeof value !== 'object' || !(segment in value)) {
            return match;
          }
          value = (value as Record<string, unknown>)[segment];
        }

        if (value === undefined) return match;
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
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
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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
