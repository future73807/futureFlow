import { Injectable, Logger, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import * as YAML from 'yaml';
import {
  FlowGramJSON,
  FlowNodeJSON,
  FlowInputValue,
  DifyDSL,
  DifyNode,
  DifyEdge,
  DifyVariable,
  DifyPromptItem,
} from './types';
import { validateWorkflowReferences } from './workflow-reference-validator';
import {
  assertSynchronousJavaScript,
  buildOutputContractRuntime,
  normalizeCodeOutputSchema,
  uniqueJavaScriptIdentifier,
} from './javascript-contract';
import {
  NATIVE_MEDIA_OUTPUTS,
  isNativeMediaNode,
  prepareNativeMediaNodes,
  validateNativeMediaNode,
} from './native-media-bridge';
import { collectMcpServerIds, prepareMcpNodes } from './mcp-bridge';

// Dify 0.15.x parses template selectors with these exact segment limits.
// Enforcing them before import prevents a workflow from publishing with
// literal, silently-unexpanded {{#...#}} references.
const DIFY_NODE_ID = /^[a-zA-Z0-9_]{1,50}$/;
const DIFY_SELECTOR_PROPERTY = /^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/;
const DIFY_MAX_SELECTOR_PROPERTY_SEGMENTS = 10;
const FLOWGRAM_NODE_ID_MAX_LENGTH = 255;

/**
 * DSL 转换器:FlowGram JSON → Dify DSL
 *
 * 这是网关层的核心组件(README 标注的"核心开发点")。
 * 负责:
 *  - 将 FlowGram 的 nodes/edges 映射为 Dify DSL 的 nodes/edges
 *  - 将 LLM 节点配置(modelName/systemPrompt/prompt/temperature)转为 Dify 格式
 *  - 处理变量引用(两边均使用 {{#nodeId.variable#}} 格式,天然兼容)
 */
@Injectable()
export class DifyConverterService {
  private readonly logger = new Logger(DifyConverterService.name);

  /**
   * ConfigService 允许为空：单元测试直接 new DifyConverterService() 时退回
   * 节点上的模型名；生产环境通过注入读取 LLM_DEFAULT_MODEL / LLM_API_HOST。
   */
  constructor(@Optional() private readonly config?: ConfigService) {}

  /** 服务端统一配置的执行模型（优先于画布上的展示名） */
  private configuredModelName(): string {
    return (this.config?.get<string>('LLM_DEFAULT_MODEL', '') || '').trim();
  }

  private configuredApiHost(): string {
    return (this.config?.get<string>('LLM_API_HOST', '') || '').trim();
  }

  /** 常见模型名 → Dify provider 映射 */
  private readonly MODEL_PROVIDER_MAP: Record<string, string> = {
    'gpt-3.5-turbo': 'openai',
    'gpt-4': 'openai',
    'gpt-4o': 'openai',
    'gpt-4o-mini': 'openai',
    'gpt-4-turbo': 'openai',
    'claude-3-opus': 'anthropic',
    'claude-3-sonnet': 'anthropic',
    'claude-3-haiku': 'anthropic',
    'claude-3.5-sonnet': 'anthropic',
    'deepseek-chat': 'deepseek',
    'deepseek-reasoner': 'deepseek',
    'deepseek-v4-pro': 'deepseek',
    'deepseek-v4-flash': 'deepseek',
    'gemini-pro': 'google',
    'gemini-1.5-pro': 'google',
    'gemini-1.5-flash': 'google',
    'qwen-turbo': 'tongyi',
    'qwen-plus': 'tongyi',
    'qwen-max': 'tongyi',
  };

  /**
   * 将 FlowGram JSON 转换为 Dify DSL YAML 字符串
   */
  toDifyDSL(flowgram: FlowGramJSON): DifyDSL {
    flowgram = this.stripCanvasDecorations(flowgram);
    // 循环类型归一化要在校验前完成：指定次数/无限循环会补一个生成轮次数组的
    // 上游代码节点，之后的引用校验、支配关系与 iteration 转换都只面对数组循环。
    flowgram = this.normalizeLoopTypes(flowgram);
    // 变量聚合编译成等价的代码节点，后续校验/转换只面对普通节点。
    flowgram = this.normalizeAggregatorNodes(flowgram);
    this.validateFlowGram(flowgram);
    // 子工作流必须在引用校验前展开：inlinedGraph 内部的引用属于子图，
    // 展开后（前缀化）才会出现在统一的图引用校验里。
    flowgram = this.expandSubworkflows(flowgram);
    validateWorkflowReferences(flowgram);
    flowgram = prepareNativeMediaNodes(flowgram);
    flowgram = prepareMcpNodes(flowgram);
    // The saved semantic media node expands into a trusted Gateway request and
    // a parser node only after the user-authored graph has passed admission.
    validateWorkflowReferences(flowgram);
    flowgram = this.prepareVariableAssignments(flowgram);
    validateWorkflowReferences(flowgram);
    // Dify's graph accepts broader IDs, but its workflow template parser only
    // interpolates node IDs matching [A-Za-z0-9_]{1,50}.  Old futureFlow
    // drafts used nanoid's '-' character, so remap the fully prepared graph at
    // the export boundary instead of forcing users to recreate those nodes.
    // Keep this after native-media expansion: its invocation-only Start input
    // names are derived from the saved (original) media node IDs.
    flowgram = this.remapDifyNodeIds(flowgram);
    this.assertDifyGraphNodeIds(flowgram);
    validateWorkflowReferences(flowgram);

    const startNode = flowgram.nodes.find((n) => n.type === 'start');
    const endNode = flowgram.nodes.find((n) => n.type === 'end');

    if (!startNode) {
      throw new BadRequestException('工作流缺少开始节点');
    }

    // Dify 的 iteration 子节点与父节点同处 graph.nodes，需要把 FlowGram
    // 容器子画布展平；block-end 只用于本地运行时，不导出到 Dify。
    const difyNodes: DifyNode[] = flowgram.nodes.flatMap((node) =>
      node.type === 'loop'
        ? this.convertBatchLoopNodes(node, flowgram)
        : [this.convertNode(node, startNode, flowgram)],
    );

    // 转换所有边
    const difyEdges: DifyEdge[] = [
      ...flowgram.edges.map((edge) => this.convertEdge(edge, flowgram.nodes)),
      ...flowgram.nodes
        .filter((node) => node.type === 'loop')
        .flatMap((node) => this.convertBatchLoopEdges(node)),
    ];

    // 如果没有 End 节点,自动补充一个指向最后一个可执行节点的输出
    // （画布上有「退出节点」时它本身就是终点，不再补自动结束节点）
    const hasExitNode = flowgram.nodes.some((node) => node.type === 'exit');
    if (!endNode && !hasExitNode) {
      const executableNodes = flowgram.nodes.filter((n) =>
        ['llm', 'http', 'code', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'loop', 'knowledge', 'subworkflow', 'mcp'].includes(n.type),
      );
      if (executableNodes.length > 0) {
        const lastNode = executableNodes[executableNodes.length - 1];
        const endId = 'end_auto';
        difyNodes.push(
          this.createEndNode(
            endId,
            1200,
            0,
            this.resolveAutoEndOutputs(lastNode, flowgram.nodes),
          ),
        );
        difyEdges.push(
          this.createEdge(lastNode.id, endId, lastNode.type, 'end'),
        );
      }
    }

    const dsl: DifyDSL = {
      app: {
        description: 'Generated by futureFlow gateway',
        icon: '🤖',
        icon_background: '#FFEAD5',
        mode: 'workflow',
        name: 'futureflow_workflow',
      },
      kind: 'app',
      version: '0.1.5',
      workflow: {
        features: {
          file_upload: { image: { enabled: false } },
          opening_statement: '',
          retriever_resource: { enabled: true },
          sensitive_word_avoidance: { enabled: false },
          speech_to_text: { enabled: false },
          suggested_questions: [],
          suggested_questions_after_answer: { enabled: false },
          text_to_speech: { enabled: false },
        },
        graph: {
          nodes: difyNodes,
          edges: difyEdges,
          viewport: { x: 0, y: 0, zoom: 0.7 },
        },
      },
    };

    this.logger.log(
      `DSL 转换完成: ${flowgram.nodes.length} 节点 → ${difyNodes.length} Dify节点, ${difyEdges.length} 边`,
    );
    return dsl;
  }

  /** 转换为 YAML 字符串(用于 Dify Console API 导入) */
  toDifyDSLYaml(flowgram: FlowGramJSON): string {
    const dsl = this.toDifyDSL(flowgram);
    const document = new YAML.Document(dsl);

    // Dify 0.15.3 uses PyYAML to import the DSL. In YAML 1.1 an unquoted
    // standalone "=" is interpreted as the !!value tag rather than a string,
    // even though yaml@2 emits it as a plain scalar by default. Quote every
    // comparison operator explicitly so numeric equality conditions remain
    // importable without changing the more readable block style of code nodes.
    YAML.visit(document, {
      Pair(_key, pair) {
        if (
          YAML.isScalar(pair.key)
          && pair.key.value === 'comparison_operator'
          && YAML.isScalar(pair.value)
        ) {
          pair.value.type = 'QUOTE_DOUBLE';
        }
      },
    });

    return document.toString({ indentSeq: false });
  }

  /** 校验 FlowGram JSON 基本结构 */
  validateFlowGram(json: FlowGramJSON) {
    if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.edges)) {
      throw new BadRequestException('FlowGram JSON 必须包含 nodes 和 edges 数组');
    }
    json = this.stripCanvasDecorations(json);
    // 指定次数 / 无限循环在校验前先补上轮次数组节点，避免执行路径拿到未归一化的图
    json = this.normalizeLoopTypes(json);
    // 变量聚合在校验等价代码节点，规则与本地运行时一致
    json = this.normalizeAggregatorNodes(json);
    if (json.nodes.length === 0) {
      throw new BadRequestException('工作流至少需要一个节点');
    }
    if (json.nodes.filter((node) => node?.type === 'loop').length > 1) {
      throw new BadRequestException('循环节点每个工作流最多只能使用一个');
    }

    const nodeIds = new Set<string>();
    const startNodeIds: string[] = [];
    for (const node of json.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id.trim()) {
        throw new BadRequestException('每个节点都必须包含有效的 id');
      }
      if (node.id.length > FLOWGRAM_NODE_ID_MAX_LENGTH) {
        throw new BadRequestException(
          `节点 id 长度不能超过 ${FLOWGRAM_NODE_ID_MAX_LENGTH} 位`,
        );
      }
      if (nodeIds.has(node.id)) {
        throw new BadRequestException(`节点 id 重复: ${node.id}`);
      }
      nodeIds.add(node.id);
      if (
        typeof node.type !== 'string'
        || !node.type
        || !node.data
        || typeof node.data !== 'object'
        || Array.isArray(node.data)
      ) {
        throw new BadRequestException(`节点 ${node.id} 缺少 type 或 data`);
      }
      if (node.type === 'start') startNodeIds.push(node.id);
      if (node.type === 'loop') this.validateBatchLoopNode(node, json.nodes);
      if (node.type !== 'loop' && (node.blocks !== undefined || node.edges !== undefined)) {
        throw new BadRequestException(`节点 ${node.id} 不能包含子画布`);
      }
      if (node.type === 'variable') this.validateVariableNode(node, json.nodes);
      if (node.type === 'break' || node.type === 'continue') {
        throw new BadRequestException(
          `节点 ${node.id} 使用了已下线的「中断/继续」节点，请改用「退出节点」`,
        );
      }
      if (node.type === 'exit') this.validateExitNode(node);
      if (node.type === 'condition' || node.type === 'multi-condition') {
        this.validateConditionNode(node, json.nodes);
      }
      if (node.type === 'http') this.validateHttpNode(node, json.nodes);
      if (node.type === 'code') this.validateCodeNode(node);
      if (['text', 'image', 'video'].includes(node.type)) this.validateContentNode(node);
      if (node.type === 'knowledge') this.validateKnowledgeNode(node, json.nodes);
      if (node.type === 'subworkflow') this.validateSubworkflowNode(node, json.nodes);
      if (
        node.data.failBranchEnabled !== undefined
        && typeof node.data.failBranchEnabled !== 'boolean'
      ) {
        throw new BadRequestException(`节点 ${node.id} 的失败分支开关必须是布尔值`);
      }
      if (
        node.data.failBranchEnabled === true
        && !['llm', 'http', 'code'].includes(node.type)
      ) {
        throw new BadRequestException(
          `节点 ${node.id} 的类型不支持失败分支，仅大语言模型、API 请求和代码执行节点可用`,
        );
      }
    }

    // Dify 会把 iteration 子节点展平到 graph.nodes；顶层与全部子节点 ID
    // 因此必须全局唯一，避免导入后选择器指向错误节点。
    const allNodeIds = new Set(nodeIds);
    for (const node of json.nodes.filter((candidate) => candidate.type === 'loop')) {
      for (const block of node.blocks || []) {
        if (block.id.length > FLOWGRAM_NODE_ID_MAX_LENGTH) {
          throw new BadRequestException(
            `节点 id 长度不能超过 ${FLOWGRAM_NODE_ID_MAX_LENGTH} 位`,
          );
        }
        if (allNodeIds.has(block.id)) {
          throw new BadRequestException(`节点 id 重复: ${block.id}`);
        }
        allNodeIds.add(block.id);
      }
    }

    for (const edge of json.edges) {
      if (!edge || !nodeIds.has(edge.sourceNodeID) || !nodeIds.has(edge.targetNodeID)) {
        throw new BadRequestException('工作流包含指向不存在节点的连线');
      }
      const source = json.nodes.find((node) => node.id === edge.sourceNodeID);
      if (source && (source.type === 'condition' || source.type === 'multi-condition')) {
        const ports = new Set([
          ...this.getConditionCases(source).map((entry) => entry.key),
          'else',
        ]);
        if (!edge.sourcePortID || !ports.has(edge.sourcePortID)) {
          throw new BadRequestException(`条件节点 ${source.id} 的连线必须使用有效分支端口`);
        }
      }
      if (edge.sourcePortID === 'onError') {
        const failBranchAllowed =
          source
          && ['llm', 'http', 'code'].includes(source.type)
          && source.data.failBranchEnabled === true;
        if (!failBranchAllowed) {
          throw new BadRequestException(
            `节点 ${edge.sourceNodeID} 未开启失败分支，不能使用失败分支连线`,
          );
        }
      }
    }

    if (startNodeIds.length !== 1) {
      throw new BadRequestException('工作流必须且只能包含一个开始节点');
    }

    const edgeIds = new Set<string>();
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const nodeId of nodeIds) {
      adjacency.set(nodeId, []);
      inDegree.set(nodeId, 0);
    }
    for (const edge of json.edges) {
      if (edge.sourceNodeID === edge.targetNodeID) {
        throw new BadRequestException('工作流不能包含自环连线');
      }
      if (edge.targetNodeID === startNodeIds[0]) {
        throw new BadRequestException('开始节点不能包含入口连线');
      }
      const edgeId = [
        edge.sourceNodeID,
        edge.targetNodeID,
        edge.sourcePortID || '',
        edge.targetPortID || '',
      ].join('\u0000');
      if (edgeIds.has(edgeId)) {
        throw new BadRequestException('工作流不能包含重复连线');
      }
      edgeIds.add(edgeId);
      adjacency.get(edge.sourceNodeID)!.push(edge.targetNodeID);
      inDegree.set(edge.targetNodeID, (inDegree.get(edge.targetNodeID) || 0) + 1);
    }

    // Dify executes a DAG. Reject cyclic graphs before conversion so neither
    // Dify nor the direct fallback sees order-dependent work.
    const queue = [...nodeIds].filter((nodeId) => inDegree.get(nodeId) === 0);
    let visitedCount = 0;
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      visitedCount += 1;
      for (const targetId of adjacency.get(nodeId) || []) {
        const nextDegree = (inDegree.get(targetId) || 0) - 1;
        inDegree.set(targetId, nextDegree);
        if (nextDegree === 0) queue.push(targetId);
      }
    }
    if (visitedCount !== nodeIds.size) {
      throw new BadRequestException('工作流不能包含循环连线');
    }

    // A disconnected executable node is invisible to the canvas path but can
    // still be exported or billed. Reject it at the admission boundary.
    const reachable = new Set<string>([startNodeIds[0]]);
    const pending = [startNodeIds[0]];
    while (pending.length > 0) {
      const nodeId = pending.shift()!;
      for (const targetId of adjacency.get(nodeId) || []) {
        if (!reachable.has(targetId)) {
          reachable.add(targetId);
          pending.push(targetId);
        }
      }
    }
    const orphan = [...nodeIds].find((nodeId) => !reachable.has(nodeId));
    if (orphan) {
      throw new BadRequestException(`节点 ${orphan} 未连接到开始节点`);
    }
    for (const loop of json.nodes.filter((candidate) => candidate.type === 'loop')) {
      const selector = this.getBatchLoopSelector(loop);
      if (!this.isTopLevelReachable(selector[0], loop.id, adjacency)) {
        throw new BadRequestException(`循环节点 ${loop.id} 只能引用它上游的数组变量`);
      }
      if (
        selector[0] !== startNodeIds[0]
        && this.isTopLevelReachable(startNodeIds[0], loop.id, adjacency, selector[0])
      ) {
        throw new BadRequestException(
          `循环节点 ${loop.id} 的输入数组必须来自所有执行路径都会经过的上游节点`,
        );
      }
      this.validateBatchLoopInnerReferences(loop);
    }
    const executableNodes = json.nodes.filter((n) =>
      ['llm', 'http', 'code', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'loop', 'knowledge', 'subworkflow', 'mcp'].includes(n.type),
    );
    if (executableNodes.length === 0) {
      throw new BadRequestException(
        '工作流至少需要一个可执行节点（大语言模型、API、代码、变量或内容处理）',
      );
    }
  }

  /** Comment/Group 仅用于画布展示，不应进入 Dify 图或执行图校验。 */
  private stripCanvasDecorations(flowgram: FlowGramJSON): FlowGramJSON {
    if (!flowgram || !Array.isArray(flowgram.nodes) || !Array.isArray(flowgram.edges)) {
      return flowgram;
    }
    const decorationIds = new Set(
      flowgram.nodes
        .filter((node) => node?.type === 'comment' || node?.type === 'group')
        .map((node) => node.id),
    );
    if (decorationIds.size === 0) return flowgram;
    return {
      ...flowgram,
      nodes: flowgram.nodes.filter((node) => !decorationIds.has(node.id)),
      edges: flowgram.edges.filter(
        (edge) =>
          !decorationIds.has(edge.sourceNodeID) &&
          !decorationIds.has(edge.targetNodeID),
      ),
    };
  }

  /**
   * Remap legacy canvas IDs only at the Dify export boundary.  Dify's graph
   * engine accepts arbitrary non-empty IDs, but references embedded in prompt
   * and HTTP templates are parsed with the stricter DIFY_NODE_ID grammar.
   *
   * The hash-based name is deterministic across publishes.  A salted retry
   * makes the transformation collision-safe even if a user-created safe ID
   * happens to equal the first generated candidate.  Every graph reference is
   * rewritten on a clone so the saved canvas and local runtime keep their
   * original IDs.
   */
  private remapDifyNodeIds(flowgram: FlowGramJSON): FlowGramJSON {
    const allNodes: FlowNodeJSON[] = [];
    const collectNodes = (nodes: FlowNodeJSON[]) => {
      for (const node of nodes) {
        allNodes.push(node);
        if (Array.isArray(node.blocks)) collectNodes(node.blocks);
      }
    };
    collectNodes(flowgram.nodes);

    const unsafeIds = Array.from(new Set(
      allNodes
        .map((node) => node.id)
        .filter((id): id is string => typeof id === 'string' && !DIFY_NODE_ID.test(id)),
    )).sort();
    if (unsafeIds.length === 0) return flowgram;

    const usedIds = new Set(
      allNodes
        .map((node) => node.id)
        .filter((id): id is string => typeof id === 'string' && DIFY_NODE_ID.test(id)),
    );
    const idMap = new Map<string, string>();
    for (const originalId of unsafeIds) {
      let salt = 0;
      let candidate = '';
      do {
        const digest = createHash('sha256')
          .update(`${originalId}\u0000${salt}`, 'utf8')
          .digest('hex')
          .slice(0, 40);
        candidate = `legacy_${digest}`;
        salt += 1;
      } while (usedIds.has(candidate));
      idMap.set(originalId, candidate);
      usedIds.add(candidate);
    }

    const loopLocalMaps = new Map<string, Map<string, string>>();
    for (const loop of allNodes.filter((node) => node.type === 'loop')) {
      const mappedLoopId = idMap.get(loop.id);
      if (mappedLoopId) {
        loopLocalMaps.set(
          loop.id,
          new Map([[`${loop.id}_locals`, `${mappedLoopId}_locals`]]),
        );
      }
    }
    const remapSelectorSource = (
      source: unknown,
      localMap?: Map<string, string>,
    ): unknown => typeof source === 'string'
      ? localMap?.get(source) || idMap.get(source) || source
      : source;

    const rewriteTemplate = (
      template: string,
      localMap?: Map<string, string>,
    ): string => {
      const selectorSourceMap = new Map([...idMap, ...(localMap || [])]);
      const selectorSources = Array.from(selectorSourceMap.keys())
        .sort((left, right) => right.length - left.length);
      return template.replace(
        /\{\{(#?)([^{}#]+)(#?)\}\}/g,
        (match, openingHash: string, inner: string, closingHash: string) => {
          if ((openingHash === '#') !== (closingHash === '#')) return match;
          const selector = inner.trim();
          const matchingSource = selectorSources
            .find((source) => selector.startsWith(`${source}.`));
          if (!matchingSource) return match;
          const mappedSource = selectorSourceMap.get(matchingSource)!;
          const rewritten = `${mappedSource}${selector.slice(matchingSource.length)}`;
          return openingHash === '#'
            ? `{{#${rewritten}#}}`
            : `{{${rewritten}}}`;
        },
      );
    };

    const cloneJsonValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(cloneJsonValue);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          cloneJsonValue(child),
        ]),
      );
    };

    const rewriteEmbeddedReferences = (
      value: unknown,
      localMap?: Map<string, string>,
      allowBareTemplates = true,
    ): unknown => {
      if (typeof value === 'string') {
        return allowBareTemplates ? rewriteTemplate(value, localMap) : value;
      }
      if (Array.isArray(value)) {
        return value.map((child) =>
          rewriteEmbeddedReferences(child, localMap, allowBareTemplates),
        );
      }
      if (!value || typeof value !== 'object') return value;

      const source = value as Record<string, unknown>;
      // Constants, JSON schemas, scripts and display-only fields are explicitly
      // excluded by the reference validator and must keep literal braces.
      if (source.type === 'constant') return cloneJsonValue(source);
      if (source.type === 'ref' && Array.isArray(source.content)) {
        const rewritten = cloneJsonValue(source) as Record<string, unknown>;
        rewritten.content = source.content.map((part, index) =>
          index === 0
            ? remapSelectorSource(part, localMap)
            : cloneJsonValue(part),
        );
        return rewritten;
      }
      if (
        (source.type === 'template' || source.type === 'expression')
        && typeof source.content === 'string'
      ) {
        const rewritten = cloneJsonValue(source) as Record<string, unknown>;
        rewritten.content = rewriteTemplate(source.content, localMap);
        return rewritten;
      }

      return Object.fromEntries(
        Object.entries(source).map(([key, child]) => {
          if (
            ['inputs', 'outputs', 'script', 'blocks', 'title', 'description', 'desc']
              .includes(key)
          ) {
            return [key, cloneJsonValue(child)];
          }
          return [
            key,
            rewriteEmbeddedReferences(
              child,
              localMap,
              allowBareTemplates && key !== 'loopOutputs',
            ),
          ];
        }),
      );
    };

    const rewriteEdge = (edge: FlowGramJSON['edges'][number]) => ({
      ...edge,
      sourceNodeID: idMap.get(edge.sourceNodeID) || edge.sourceNodeID,
      targetNodeID: idMap.get(edge.targetNodeID) || edge.targetNodeID,
    });
    const rewriteNode = (
      node: FlowNodeJSON,
      localMap?: Map<string, string>,
    ): FlowNodeJSON => ({
      ...node,
      id: idMap.get(node.id) || node.id,
      data: rewriteEmbeddedReferences(node.data, localMap) as FlowNodeJSON['data'],
      ...(Array.isArray(node.blocks)
        ? {
            blocks: node.blocks.map((block) =>
              rewriteNode(block, loopLocalMaps.get(node.id)),
            ),
          }
        : {}),
      ...(Array.isArray(node.edges)
        ? { edges: node.edges.map(rewriteEdge) }
        : {}),
    });

    return {
      ...flowgram,
      nodes: flowgram.nodes.map((node) => rewriteNode(node)),
      edges: flowgram.edges.map(rewriteEdge),
    };
  }

  private assertDifyGraphNodeIds(flowgram: FlowGramJSON): void {
    const assertNodes = (nodes: FlowNodeJSON[]) => {
      for (const node of nodes) {
        this.assertDifyNodeId(node.id);
        if (Array.isArray(node.blocks)) assertNodes(node.blocks);
      }
    };
    assertNodes(flowgram.nodes);
  }

  /**
   * FlowGram 的 assign 操作会原地更新已有变量，而 Dify 0.15.3 的稳定 DSL
   * 没有可依赖的同等节点。发布前把赋值结果转成变量节点的内部输出，并将
   * 后续引用静态改写为该输出。只接受赋值节点支配使用节点的图，避免条件
   * 分支中某些路径没有执行赋值却仍引用其输出。
   */
  private prepareVariableAssignments(flowgram: FlowGramJSON): FlowGramJSON {
    const assignmentNodes = flowgram.nodes.filter((node) =>
      node.type === 'variable' && this.getVariableRows(node).some((row) => row.operator === 'assign'),
    );
    if (assignmentNodes.length === 0) return flowgram;

    const prepared = JSON.parse(JSON.stringify(flowgram)) as FlowGramJSON;
    const adjacency = new Map(prepared.nodes.map((node) => [node.id, [] as string[]]));
    for (const edge of prepared.edges) adjacency.get(edge.sourceNodeID)?.push(edge.targetNodeID);

    const reachability = new Map<string, boolean>();
    const isReachable = (source: string, target: string, skipped?: string): boolean => {
      if (source === skipped || target === skipped) return false;
      const key = skipped
        ? `${source}\u0000${target}\u0000${skipped}`
        : `${source}\u0000${target}`;
      const cached = reachability.get(key);
      if (cached !== undefined) return cached;
      const seen = new Set<string>([source]);
      const pending = [source];
      while (pending.length > 0) {
        const current = pending.shift()!;
        for (const next of adjacency.get(current) || []) {
          if (next === skipped || seen.has(next)) continue;
          if (next === target) {
            reachability.set(key, true);
            return true;
          }
          seen.add(next);
          pending.push(next);
        }
      }
      reachability.set(key, false);
      return false;
    };

    const start = prepared.nodes.find((node) => node.type === 'start')!;
    const dominates = (dominator: string, consumer: string): boolean =>
      !isReachable(start.id, consumer, dominator);
    const assignments: Array<{
      nodeId: string;
      target: string[];
      outputName: string;
    }> = [];

    for (const node of prepared.nodes.filter((candidate) => candidate.type === 'variable')) {
      this.getVariableRows(node).forEach((row, index) => {
        if (row.operator !== 'assign') return;
        const target = (row.left?.content as unknown[]).map(String);
        const source = prepared.nodes.find((candidate) => candidate.id === target[0]);
        if (!source || !isReachable(source.id, node.id) || !dominates(source.id, node.id)) {
          throw new BadRequestException(
            `变量节点 ${node.id} 的目标 ${target.join('.')} 必须来自所有执行路径都会经过的上游节点`,
          );
        }
        assignments.push({
          nodeId: node.id,
          target,
          outputName: this.variableRowOutputName(row, index),
        });
      });
    }

    const rewriteSelector = (selector: string[], consumerId: string): string[] => {
      const candidates = assignments.filter(
        (assignment) =>
          assignment.target.every((part, index) => selector[index] === part) &&
          isReachable(assignment.nodeId, consumerId),
      );
      if (candidates.length === 0) return selector;
      const latest = candidates.filter(
        (candidate) =>
          !candidates.some(
            (other) => other !== candidate && isReachable(candidate.nodeId, other.nodeId),
          ),
      );
      if (latest.length !== 1 || !dominates(latest[0].nodeId, consumerId)) {
        throw new BadRequestException(
          `变量 ${selector.slice(0, 2).join('.')} 在分支汇合处的赋值不明确；请在汇合后重新设置变量`,
        );
      }
      const selected = latest[0];
      return [
        selected.nodeId,
        selected.outputName,
        ...selector.slice(selected.target.length),
      ];
    };

    const rewriteFlowValues = (value: unknown, consumerId: string): unknown => {
      if (Array.isArray(value)) {
        return value.map((entry) => rewriteFlowValues(entry, consumerId));
      }
      if (!value || typeof value !== 'object') return value;
      const record = value as Record<string, any>;
      if (record.type === 'ref' && Array.isArray(record.content)) {
        return {
          ...record,
          content: rewriteSelector(record.content.map(String), consumerId),
        };
      }
      if (
        (record.type === 'template' || record.type === 'expression') &&
        typeof record.content === 'string'
      ) {
        return {
          ...record,
          content: record.content.replace(
            /\{\{#?([^{}#]+)#?\}\}/g,
            (match: string, inner: string) => {
              const selector = inner.trim().split('.').filter(Boolean);
              if (selector.length < 2) return match;
              return `{{${rewriteSelector(selector, consumerId).join('.')}}}`;
            },
          ),
        };
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, child]) => [
          key,
          rewriteFlowValues(child, consumerId),
        ]),
      );
    };

    for (const node of prepared.nodes) {
      if (node.type !== 'variable') {
        node.data = rewriteFlowValues(node.data, node.id) as FlowNodeJSON['data'];
        continue;
      }
      const rows = this.getVariableRows(node);
      const otherData = Object.fromEntries(
        Object.entries(node.data).filter(([key]) => key !== 'assign'),
      );
      node.data = {
        ...(rewriteFlowValues(otherData, node.id) as FlowNodeJSON['data']),
        assign: rows.map((row) => ({
          ...row,
          left: row.left,
          right: rewriteFlowValues(row.right, node.id),
        })),
      };
    }

    return prepared;
  }

  /**
   * FlowGram 容器保存 block-start → 内部节点链 → block-end；Dify 0.15.3 则
   * 要求 iteration 父节点、iteration-start 虚拟节点和扁平化的内部节点链
   * （block-end 只用于本地运行时，不导出）。
   */
  private convertBatchLoopNodes(node: FlowNodeJSON, flowgram: FlowGramJSON): DifyNode[] {
    const position = node.meta?.position || { x: 0, y: 0 };
    const blocks = node.blocks!;
    const blockStart = blocks[0];
    const innerNodes = blocks.slice(1, -1);
    // 迭代输出：优先取用户在循环节点上选择的输出（循环体内某节点的字段），
    // 否则退回链尾节点的第一个输出。
    const declaredOutput = Object.values(
      (node.data.loopOutputs || {}) as Record<string, FlowInputValue | undefined>,
    ).find(
      (value) =>
        value?.type === 'ref' && Array.isArray(value.content) && value.content.length === 2,
    );
    const innerIds = new Set(innerNodes.map((block) => block.id));
    const declaredOutputNodeId = declaredOutput ? String(declaredOutput.content[0]) : '';
    const outputNode = innerIds.has(declaredOutputNodeId)
      ? innerNodes.find((block) => block.id === declaredOutputNodeId)!
      : innerNodes[innerNodes.length - 1];
    const outputProperties = (outputNode.data.outputs?.properties || {}) as Record<string, any>;
    const codeOutputName = outputNode.id === declaredOutputNodeId
      ? String(declaredOutput!.content[1])
      : Object.keys(outputProperties)[0];
    const codeOutputType = String(outputProperties[codeOutputName]?.type || 'string').toLowerCase();
    const outputType = codeOutputType === 'string' ? 'array[string]' : 'array[number]';
    const iteratorSelector = this.normalizeDifySelector(
      this.getBatchLoopSelector(node),
      flowgram.nodes,
    );

    const parent: DifyNode = {
      id: node.id,
      type: 'custom',
      position,
      positionAbsolute: { ...position },
      sourcePosition: 'right',
      targetPosition: 'left',
      width: 620,
      height: 240,
      selected: false,
      zIndex: 1,
      data: {
        type: 'iteration',
        title: node.data.title || '循环',
        desc: '串行处理字符串或数字数组，最多 20 项',
        selected: false,
        iterator_selector: iteratorSelector,
        output_selector: [outputNode.id, codeOutputName],
        output_type: outputType,
        start_node_id: blockStart.id,
        startNodeType: innerNodes[0].type,
        is_parallel: false,
        parallel_nums: 1,
        error_handle_mode: 'terminated',
        width: 620,
        height: 240,
      },
    };

    const iterationStart: DifyNode = {
      id: blockStart.id,
      type: 'custom-iteration-start',
      position: { x: 72, y: 96 },
      positionAbsolute: { x: position.x + 72, y: position.y + 96 },
      sourcePosition: 'right',
      targetPosition: 'left',
      width: 44,
      height: 48,
      parentId: node.id,
      extent: 'parent',
      selected: false,
      draggable: false,
      selectable: false,
      zIndex: 1002,
      data: {
        type: 'iteration-start',
        title: '批处理开始',
        desc: '',
        selected: false,
        isInIteration: true,
        iteration_id: node.id,
      },
    };

    const iterationNodes: DifyNode[] = innerNodes.map((innerNode) =>
      innerNode.type === 'code'
        ? this.convertLoopCodeNode(innerNode, node, flowgram, position)
        : this.convertLoopInnerNode(innerNode, node, flowgram, position),
    );

    return [parent, iterationStart, ...iterationNodes];
  }

  /** 循环体内非代码节点：复用常规转换器，补上 iteration 子图所需的父子/定位字段。 */
  private convertLoopInnerNode(
    innerNode: FlowNodeJSON,
    loopNode: FlowNodeJSON,
    flowgram: FlowGramJSON,
    loopPosition: { x: number; y: number },
  ): DifyNode {
    const startNode = flowgram.nodes.find((candidate) => candidate.type === 'start');
    if (!startNode) {
      throw new BadRequestException('工作流缺少开始节点');
    }
    const converted = this.convertNode(innerNode, startNode, flowgram);
    const nodePosition = innerNode.meta?.position || { x: 0, y: 0 };
    const position = { x: Math.max(160, nodePosition.x), y: Math.max(84, nodePosition.y) };
    return {
      ...converted,
      position,
      positionAbsolute: { x: loopPosition.x + position.x, y: loopPosition.y + position.y },
      parentId: loopNode.id,
      extent: 'parent',
      selected: false,
      zIndex: 1002,
      data: {
        ...converted.data,
        selected: false,
        isInIteration: true,
        iteration_id: loopNode.id,
      },
    };
  }

  /** 循环体内的同步 JavaScript 代码节点：包一层 20 项守卫并校验输出契约。 */
  private convertLoopCodeNode(
    codeNode: FlowNodeJSON,
    loopNode: FlowNodeJSON,
    flowgram: FlowGramJSON,
    loopPosition: { x: number; y: number },
  ): DifyNode {
    const codeOutputs = (codeNode.data.outputs?.properties || {}) as Record<string, any>;
    const codeOutputName = Object.keys(codeOutputs)[0];
    const codeOutputType = String(codeOutputs[codeOutputName]?.type || 'string').toLowerCase();
    const variables: Array<{ variable: string; value_selector: string[] }> = [];
    const paramsEntries = Object.entries(codeNode.data.inputsValues || {}).map(([key, value]) => {
      const expression = this.compileFlowValueExpression(
        value,
        variables,
        key,
        flowgram.nodes,
      );
      return `${JSON.stringify(key)}: ${expression}`;
    });
    for (const variable of variables) {
      if (variable.value_selector[0] === `${loopNode.id}_locals`) {
        variable.value_selector = [loopNode.id, variable.value_selector[1]];
      } else if (
        variable.value_selector[0] === loopNode.id
        && ['item', 'index'].includes(variable.value_selector[1])
      ) {
        // 已被 id 映射改写为循环节点选择器（item/index 由 iteration 节点暴露）
        variable.value_selector = [loopNode.id, variable.value_selector[1]];
      }
    }
    const guardVariable = '__ff_iteration_index';
    variables.push({ variable: guardVariable, value_selector: [loopNode.id, 'index'] });

    const sourceCode = String(codeNode.data.script?.content || '');
    const analysis = assertSynchronousJavaScript(sourceCode, `代码节点 ${codeNode.id}`);
    const identifiers = new Set(analysis.identifiers);
    const originalMainBinding = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowOriginalBatchMain',
    );
    const userMainName = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowBatchMain',
    );
    const rawResultName = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowBatchResult',
    );
    // 保持既有批处理 DSL 的局部变量名，便于版本回归比较；它位于适配器
    // 函数作用域，不会与用户脚本的顶层声明冲突。
    const valueName = '__ffValue';
    const outputContract = buildOutputContractRuntime(
      identifiers,
      normalizeCodeOutputSchema(codeNode.data.outputs, `代码节点 ${codeNode.id}`),
      `代码节点 ${codeNode.id}`,
    );
    const normalizeOutput = codeOutputType === 'boolean'
      ? `Number(Boolean(${valueName}))`
      : valueName;
    const asyncError = JSON.stringify(
      `循环节点 ${loopNode.id} 的代码仅支持同步执行，不能返回 Promise/thenable`,
    );
    const code = `${sourceCode}
${outputContract.declarations}

const ${originalMainBinding} = main;
function ${userMainName}(args) {
  return ${originalMainBinding}(args);
}

main = function(args) {
  const __ffIndex = Number(args[${JSON.stringify(guardVariable)}]);
  if (!Number.isInteger(__ffIndex) || __ffIndex < 0 || __ffIndex >= 20) {
    throw new Error('循环最多支持 20 项，输入不会被截断');
  }
  const params = { ${paramsEntries.join(', ')} };
  const ${rawResultName} = ${userMainName}({ params });
  if (
    ${rawResultName} !== null
    && (typeof ${rawResultName} === 'object' || typeof ${rawResultName} === 'function')
    && typeof ${rawResultName}.then === 'function'
  ) {
    throw new Error(${asyncError});
  }
  ${outputContract.validateExpression(rawResultName)};
  const ${valueName} = ${rawResultName}[${JSON.stringify(codeOutputName)}];
  return { ${JSON.stringify(codeOutputName)}: ${normalizeOutput} };
};`;

    const codePosition = codeNode.meta?.position || { x: 180, y: 0 };
    const innerCode: DifyNode = {
      id: codeNode.id,
      type: 'custom',
      position: { x: Math.max(160, codePosition.x), y: Math.max(84, codePosition.y) },
      positionAbsolute: {
        x: loopPosition.x + Math.max(160, codePosition.x),
        y: loopPosition.y + Math.max(84, codePosition.y),
      },
      sourcePosition: 'right',
      targetPosition: 'left',
      width: 300,
      height: 90,
      parentId: loopNode.id,
      extent: 'parent',
      selected: false,
      zIndex: 1002,
      data: {
        type: 'code',
        title: codeNode.data.title || '逐项处理',
        desc: '',
        selected: false,
        isInIteration: true,
        iteration_id: loopNode.id,
        code_language: 'javascript',
        code,
        variables,
        outputs: {
          [codeOutputName]: this.toDifyCodeOutputSchema(codeOutputs[codeOutputName]),
        },
      },
    };

    return innerCode;
  }

  /** 循环体内部连线：块开始 → 内部节点链（单链）；块结束不导出到 Dify。 */
  private convertBatchLoopEdges(node: FlowNodeJSON): DifyEdge[] {
    const blocks = node.blocks!;
    const endBlock = blocks[blocks.length - 1];
    const typeOf = (id: string) => {
      if (id === blocks[0].id) return 'iteration-start';
      const block = blocks.find((candidate) => candidate.id === id);
      return block?.type || 'code';
    };
    return (node.edges || [])
      .filter((edge) => edge.targetNodeID !== endBlock.id)
      .map((edge) => ({
        id: `${encodeURIComponent(edge.sourceNodeID)}-source-${encodeURIComponent(edge.targetNodeID)}-target`,
        source: edge.sourceNodeID,
        sourceHandle: 'source',
        target: edge.targetNodeID,
        targetHandle: 'target',
        type: 'custom' as const,
        zIndex: 1002,
        data: {
          isInIteration: true,
          iteration_id: node.id,
          sourceType: typeOf(edge.sourceNodeID),
          targetType: typeOf(edge.targetNodeID),
        },
      }));
  }

  /** 转换单个节点 */
  private convertNode(
    node: FlowNodeJSON,
    startNode: FlowNodeJSON,
    flowgram: FlowGramJSON,
  ): DifyNode {
    const position = node.meta?.position || { x: 0, y: 0 };
    const base = {
      id: node.id,
      type: 'custom' as const,
      position,
      positionAbsolute: { ...position },
      sourcePosition: 'right' as const,
      targetPosition: 'left' as const,
      width: 244,
      height: 168,
    };

    switch (node.type) {
      case 'start':
        return { ...base, height: 168, data: this.convertStartNode(node) };
      case 'llm':
        return { ...base, height: 98, data: this.convertLLMNode(node, flowgram.nodes) };
      case 'end':
        return {
          ...base,
          height: 90,
          data: this.convertEndNode(node, flowgram),
        };
      case 'exit':
        return {
          ...base,
          height: 90,
          data: this.convertExitNode(node, flowgram),
        };
      case 'http':
        return { ...base, height: 120, data: this.convertHttpNode(node, flowgram.nodes) };
      case 'code':
        return { ...base, height: 120, data: this.convertCodeNode(node, flowgram.nodes) };
      case 'variable':
        return { ...base, height: 120, data: this.convertVariableNode(node, flowgram.nodes) };
      case 'text':
      case 'image':
      case 'video':
        return { ...base, height: 120, data: this.convertContentNode(node, flowgram.nodes) };
      case 'condition':
      case 'multi-condition':
        return { ...base, height: 180, data: this.convertConditionNode(node, flowgram.nodes) };
      case 'knowledge':
        return { ...base, height: 140, data: this.convertKnowledgeNode(node, flowgram.nodes) };
      case 'database':
        throw new BadRequestException('SQL 查询节点暂不支持发布到云端执行；请在画布中使用本地试运行');
      case 'python':
        throw new BadRequestException('Python 执行节点暂不支持发布到云端执行；请在画布中使用本地试运行');
      default:
        throw new BadRequestException(
          `暂不支持的节点类型: ${node.type}`,
        );
    }
  }

  /** 转换 Start 节点 */
  private convertStartNode(node: FlowNodeJSON): any {
    // FlowGram 的 Start 节点用 outputs.properties 定义暴露的变量
    const properties = (node.data.outputs?.properties || {}) as Record<
      string,
      any
    >;
    const outputSchema = node.data.outputs as any;
    const required = new Set<string>(
      Array.isArray(outputSchema?.required)
        ? outputSchema.required.map(String)
        : [],
    );
    const variables: DifyVariable[] = Object.entries(properties).map(([key, schema]) => {
      this.assertDifySelectorProperty(key, `开始节点输入 ${key}`);
      const schemaType = String(schema?.type || 'string').toLowerCase();
      // 类型映射：布尔按 1/0 的数字输入传递（与循环输出里布尔按 1/0 兼容的约定一致），
      // 时间（string + format:date-time）与文件（string + format:file）在云端按文本传递。
      const format = String(schema?.format || '').toLowerCase();
      // 文件有两种写法：type:'file'，或 string + format:'file'（媒体节点输出用后者）
      const isTimeOrFile = schemaType === 'file'
        || (schemaType === 'string' && ['date-time', 'file'].includes(format));
      if (!['string', 'number', 'integer', 'boolean'].includes(schemaType) && !isTimeOrFile) {
        throw new BadRequestException(
          `开始节点输入 ${key} 暂不支持 ${schemaType} 类型，仅支持字符串、数字、整数、布尔、时间或文件`,
        );
      }
      // 布尔按 1/0 的数字输入传递（与循环输出里布尔按 1/0 兼容的约定一致）。
      const isNumber = ['number', 'integer', 'boolean'].includes(schemaType);
      return {
        variable: key,
        label: schema?.title ? String(schema.title) : key,
        type: isNumber ? 'number' : 'paragraph',
        required: required.has(key),
        max_length: isNumber ? 48 : 50000,
        options: [],
      };
    });

    return {
      type: 'start',
      title: node.data.title || '开始',
      desc: '',
      selected: false,
      variables,
    };
  }

  /** 转换 LLM 节点 */
  private convertLLMNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const inputsValues = node.data.inputsValues || {};

    const requestedModel = String(this.getInputValue(inputsValues.modelName, 'gpt-3.5-turbo'));
    // 执行模型由服务端统一配置（与本地试运行同一语义：画布模型名仅作展示），
    // 未配置时保留节点上的模型名，兼容旧的 Dify Provider 绑定。
    const modelName = this.configuredModelName() || requestedModel;
    const temperature = parseFloat(
      String(this.getInputValue(inputsValues.temperature, 0.5)),
    );
    const systemPrompt = this.flowValueToDifyTemplate(inputsValues.systemPrompt, nodes);
    const userPrompt = this.flowValueToDifyTemplate(inputsValues.prompt, nodes);

    const provider = this.inferProvider(String(modelName));

    // 构建 prompt_template
    // 同时将 FlowGram 变量引用 {{nodeId.var}} 转为 Dify 格式 {{#nodeId.var#}}
    const promptTemplate: DifyPromptItem[] = [];
    if (systemPrompt) {
      promptTemplate.push({
        id: uuidv4(),
        role: 'system',
        text: systemPrompt,
      });
    }
    promptTemplate.push({
      id: uuidv4(),
      role: 'user',
      text: userPrompt,
    });

    const data: Record<string, unknown> = {
      type: 'llm',
      title: node.data.title || 'LLM',
      desc: '',
      selected: false,
      model: {
        provider,
        name: String(modelName),
        mode: 'chat',
        completion_params: {
          temperature,
        },
      },
      prompt_template: promptTemplate,
      context: {
        enabled: false,
        variable_selector: [],
      },
      vision: {
        enabled: false,
      },
      variables: [],
    };
    this.applyFailBranch(data, node);
    return data;
  }

  /** 失败分支开关映射为 Dify 0.15.3 的 error_strategy（仅 LLM/HTTP/代码节点）。 */
  private applyFailBranch(data: Record<string, unknown>, node: FlowNodeJSON): void {
    if (node.data.failBranchEnabled === true) {
      data.error_strategy = 'fail-branch';
    }
  }

  private static readonly SUBFLOW_MAX_DEPTH = 3;

  /**
   * 子工作流编译期内联：把每个 subworkflow 节点替换为其已发布子图快照。
   * 发布服务负责解析 targetWorkflowId → 快照并做环检测（写入 inlinedGraph），
   * 这里只做同步展开：子图节点 ID 前缀化、开始节点替换为参数注入代码节点、
   * 结束节点删除并把父图引用重定向到子图产出节点。
   */
  private expandSubworkflows(flowgram: FlowGramJSON, depth = 0): FlowGramJSON {
    const subNodes = (flowgram.nodes || []).filter((n) => n?.type === 'subworkflow');
    if (subNodes.length === 0) return flowgram;
    if (depth > DifyConverterService.SUBFLOW_MAX_DEPTH) {
      throw new BadRequestException('子工作流嵌套层数超过上限（最多 3 层）');
    }

    let nodes = [...flowgram.nodes];
    let edges = [...flowgram.edges];
    for (const sub of subNodes) {
      const expanded = this.expandOneSubworkflow(sub, nodes, edges, depth);
      nodes = expanded.nodes;
      edges = expanded.edges;
    }
    return { ...flowgram, nodes, edges };
  }

  private expandOneSubworkflow(
    sub: FlowNodeJSON,
    parentNodes: FlowNodeJSON[],
    parentEdges: FlowGramJSON['edges'],
    depth: number,
  ): { nodes: FlowNodeJSON[]; edges: FlowGramJSON['edges'] } {
    const inlined = sub.data?.inlinedGraph as
      | { nodes?: FlowNodeJSON[]; edges?: FlowGramJSON['edges'] }
      | undefined;
    if (
      !inlined
      || !Array.isArray(inlined.nodes)
      || !Array.isArray(inlined.edges)
      || inlined.nodes.length === 0
    ) {
      throw new BadRequestException(
        `子工作流节点 ${sub.id} 缺少已发布的子图快照，请重新保存并发布`,
      );
    }
    // 子图自身可能也包含 subworkflow 节点（其快照带各自的 inlinedGraph），先递归展开。
    const childGraph = this.expandSubworkflows(
      {
        nodes: this.cloneValue(inlined.nodes),
        edges: this.cloneValue(inlined.edges),
      } as FlowGramJSON,
      depth + 1,
    );

    const childStarts = childGraph.nodes.filter((n) => n.type === 'start');
    if (childStarts.length !== 1) {
      throw new BadRequestException(`子工作流节点 ${sub.id} 引用的子图必须恰好有一个开始节点`);
    }
    const childStart = childStarts[0];
    const childEnds = childGraph.nodes.filter((n) => n.type === 'end');
    if (childEnds.length !== 1) {
      throw new BadRequestException(
        `子工作流节点 ${sub.id} 引用的子图必须恰好有一个结束节点，多结束分支请拆分后引用`,
      );
    }
    const childEnd = childEnds[0];
    const incomingToEnd = childGraph.edges.filter((e) => e.targetNodeID === childEnd.id);
    if (incomingToEnd.length !== 1) {
      throw new BadRequestException(`子工作流节点 ${sub.id} 的子图结束节点必须恰好有一个上游`);
    }
    const endSourceId = incomingToEnd[0].sourceNodeID;

    const prefix = `sw_${this.subflowPrefix(sub.id)}`;
    const idMap = new Map<string, string>();
    for (const child of childGraph.nodes) {
      idMap.set(child.id, `${prefix}_${child.id}`);
    }

    // 入参映射校验 + 参数注入节点（替代子图开始节点）。
    const startProperties = (childStart.data?.outputs?.properties || {}) as Record<string, any>;
    const varNames = Object.keys(startProperties);
    const mappings = (sub.data?.inputMappings || {}) as Record<string, any>;
    const inputsValues: Record<string, any> = {};
    for (const name of varNames) {
      const mapping = mappings[name];
      if (
        !mapping
        || mapping.type !== 'ref'
        || !Array.isArray(mapping.content)
        || mapping.content.length < 2
      ) {
        throw new BadRequestException(
          `子工作流节点 ${sub.id} 的入参 ${name} 必须映射一个上游变量`,
        );
      }
      // 类型约束：数组只能迭代、对象只能取属性，结构性类型不能互相混用
      const expectedType = String((startProperties[name] as any)?.type || 'string').toLowerCase();
      const sourceSchema = this.resolveSelectorSchema(mapping.content.map(String), parentNodes);
      const sourceType = String(sourceSchema?.type || 'string').toLowerCase();
      const isStructural = (type: string) => type === 'array' || type === 'object';
      if (isStructural(expectedType) !== isStructural(sourceType)) {
        throw new BadRequestException(
          `子工作流节点 ${sub.id} 的入参 ${name} 需要${expectedType === 'array' ? '数组' : expectedType === 'object' ? '对象' : '标量'}类型，`
          + `但引用的是 ${sourceType} 类型`,
        );
      }
      inputsValues[name] = mapping;
    }
    const injectId = `${prefix}__in`;
    const injectNode: FlowNodeJSON = {
      id: injectId,
      type: 'code',
      meta: { position: { x: 0, y: 0 } },
      data: {
        title: `${sub.data?.title || '子工作流'} · 参数注入`,
        inputsValues,
        script: {
          language: 'javascript',
          content: `function main({ params }) {\n  return { ${varNames
            .map((name) => `${JSON.stringify(name)}: params[${JSON.stringify(name)}]`)
            .join(', ')} };\n}`,
        },
        outputs: {
          type: 'object',
          properties: this.cloneValue(startProperties) as Record<string, any>,
        },
      },
    };

    // 子图节点重命名 + 引用重写（开始引用 → 注入节点）。
    const referenceMap = new Map(idMap);
    referenceMap.set(childStart.id, injectId);
    const rewrittenChildNodes = childGraph.nodes
      .filter((n) => n.type !== 'start' && n.type !== 'end')
      .map((n) => this.rewriteIdsDeep({ ...n, id: idMap.get(n.id) || n.id }, referenceMap) as FlowNodeJSON);

    const childEdges: FlowGramJSON['edges'] = [];
    for (const edge of childGraph.edges) {
      if (edge.sourceNodeID === childEnd.id || edge.targetNodeID === childEnd.id) continue;
      childEdges.push({
        ...edge,
        sourceNodeID: referenceMap.get(edge.sourceNodeID) || edge.sourceNodeID,
        targetNodeID: referenceMap.get(edge.targetNodeID) || edge.targetNodeID,
      });
    }

    // 父图引用重写：子工作流输出按子图 End 的输出映射展开到真实来源节点。
    // 例：父图 [sub_1, result]，子图 End 声明 result ← [c_text, text]，
    // 则重写为 [前缀化 c_text, text]。
    const endInputs = (childEnd.data?.inputsValues || {}) as Record<string, any>;
    const outputMap = new Map<string, { nodeId: string; field: string }>();
    for (const [outVar, ref] of Object.entries(endInputs)) {
      if (ref?.type === 'ref' && Array.isArray(ref.content) && ref.content.length >= 2) {
        outputMap.set(outVar, {
          nodeId: idMap.get(String(ref.content[0])) || String(ref.content[0]),
          field: String(ref.content[1]),
        });
      }
    }
    const rewrittenParentNodes = parentNodes
      .filter((n) => n.id !== sub.id)
      .map((n) => this.rewriteSubflowOutputsDeep(n, sub.id, outputMap) as FlowNodeJSON);

    const rewrittenParentEdges: FlowGramJSON['edges'] = [];
    for (const edge of parentEdges) {
      if (edge.sourceNodeID === sub.id) {
        rewrittenParentEdges.push({ ...edge, sourceNodeID: idMap.get(endSourceId)! });
      } else if (edge.targetNodeID === sub.id) {
        rewrittenParentEdges.push({ ...edge, targetNodeID: injectId });
      } else {
        rewrittenParentEdges.push(edge);
      }
    }

    return {
      nodes: [...rewrittenParentNodes, injectNode, ...rewrittenChildNodes],
      edges: [...rewrittenParentEdges, ...childEdges],
    };
  }

  /**
   * 模板串里的变量引用：同时匹配 FlowGram 原生的 {{node.var}} 与已包装的
   * {{#node.var#}}。画布的提示词编辑器插入的是前一种，两种都必须改写，
   * 否则子工作流展开后引用会指向已被替换掉的节点。
   */
  private static readonly TEMPLATE_REF_PATTERN = /\{\{#?([A-Za-z0-9_-]+)\.([^#}]+)#?\}\}/g;

  /**
   * 按 resolve 的返回值重写模板串中的引用；无法解析的引用原样保留，
   * 交给统一的引用校验报错。改写结果统一为 Dify 的 {{#node.field#}} 写法。
   */
  private rewriteTemplateRefs(
    text: string,
    resolve: (nodeId: string, field: string) => { nodeId: string; field: string } | null,
  ): string {
    return text.replace(
      DifyConverterService.TEMPLATE_REF_PATTERN,
      (match, id: string, path: string) => {
        const [field, ...rest] = String(path).split('.');
        const target = resolve(String(id), field);
        if (!target) return match;
        return `{{#${[target.nodeId, target.field, ...rest].join('.')}#}}`;
      },
    );
  }

  /** 深度遍历节点数据，重写变量选择器与模板中的节点 ID。 */
  private rewriteIdsDeep(value: any, idMap: Map<string, string>): any {
    if (Array.isArray(value)) {
      if (
        value.length >= 2
        && typeof value[0] === 'string'
        && idMap.has(value[0])
        && value.slice(1).every((part) => typeof part === 'string')
      ) {
        return [idMap.get(value[0])!, ...value.slice(1)];
      }
      return value.map((item) => this.rewriteIdsDeep(item, idMap));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.rewriteIdsDeep(item, idMap);
      }
      return result;
    }
    if (typeof value === 'string' && idMap.size > 0 && value.includes('{{')) {
      return this.rewriteTemplateRefs(value, (id, field) => {
        const nextId = idMap.get(id);
        return nextId ? { nodeId: nextId, field } : null;
      });
    }
    return value;
  }

  /**
   * 深度重写父图中对子工作流节点输出的引用：
   * [subId, outVar] → [End 映射的来源节点, 来源字段]；模板串同理。
   * 未在 End 输出映射中的变量名保持原样，由统一引用校验报错。
   */
  private rewriteSubflowOutputsDeep(
    value: any,
    subId: string,
    outputMap: Map<string, { nodeId: string; field: string }>,
  ): any {
    if (Array.isArray(value)) {
      if (
        value.length >= 2
        && value[0] === subId
        && typeof value[1] === 'string'
        && outputMap.has(value[1])
      ) {
        const target = outputMap.get(value[1])!;
        return [target.nodeId, target.field, ...value.slice(2)];
      }
      return value.map((item) => this.rewriteSubflowOutputsDeep(item, subId, outputMap));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.rewriteSubflowOutputsDeep(item, subId, outputMap);
      }
      return result;
    }
    if (typeof value === 'string' && value.includes('{{')) {
      return this.rewriteTemplateRefs(value, (id, field) => {
        if (id !== subId) return null;
        return outputMap.get(field) ?? null;
      });
    }
    return value;
  }

  private subflowPrefix(nodeId: string): string {
    return createHash('sha256').update(nodeId).digest('hex').slice(0, 8);
  }

  private cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /** 转换 End 节点 */
  /**
   * 退出节点（退出整个工作流）→ Dify 的 end 节点：
   * 运行执行到它就在这一点结束，并把这里声明的值作为运行结果返回。
   * FlowGram 侧只声明「输出名 → 上游变量」，所以每个输出都必须是引用。
   */
  private convertExitNode(node: FlowNodeJSON, flowgram: FlowGramJSON): any {
    const scope = String(node.data.scope || 'workflow');
    if (scope === 'loop') {
      throw new BadRequestException(
        `退出节点 ${node.id} 的退出范围是「跳出当前循环」，Dify 的循环不支持中途跳出；`
        + '请在画布上改用本地试运行，或先用「条件分支」把要跳过的项排除掉',
      );
    }

    const outputs = Object.entries(node.data.inputsValues || {}).map(([variable, value]) => {
      if (
        !value
        || (value as any).type !== 'ref'
        || !Array.isArray((value as any).content)
        || (value as any).content.length < 2
      ) {
        throw new BadRequestException(
          `退出节点 ${node.id} 的输出 ${variable} 必须引用一个上游节点变量`,
        );
      }
      const valueSelector = this.normalizeDifySelector(
        ((value as any).content as unknown[]).map(String),
        flowgram.nodes,
      );
      const referencedNode = flowgram.nodes.find(
        (candidate) => candidate.id === valueSelector[0],
      );
      if (!referencedNode || referencedNode.type === 'end' || referencedNode.type === 'exit') {
        throw new BadRequestException(
          `退出节点 ${node.id} 的输出 ${variable} 引用了不存在或无效的节点`,
        );
      }
      return { variable, value_selector: valueSelector };
    });

    return {
      type: 'end',
      title: node.data.title || '退出节点',
      desc: '提前结束运行',
      selected: false,
      outputs,
    };
  }

  /** 退出节点的发布前校验：范围合法，且「跳出循环」不能出现在主画布上 */
  private validateExitNode(node: FlowNodeJSON) {
    const scope = String(node.data.scope || 'workflow');
    if (!['workflow', 'loop'].includes(scope)) {
      throw new BadRequestException(`退出节点 ${node.id} 的退出范围不合法`);
    }
    if (scope === 'loop') {
      throw new BadRequestException(
        `退出节点 ${node.id} 的退出范围是「跳出当前循环」，必须放在循环体内；`
        + '放在主画布上时请改成「退出整个工作流」',
      );
    }
  }

  private convertEndNode(node: FlowNodeJSON, flowgram: FlowGramJSON): any {
    const incoming = flowgram.edges.filter(
      (edge) => edge.targetNodeID === node.id,
    );
    if (incoming.length !== 1) {
      throw new BadRequestException(
        incoming.length === 0
          ? `End 节点 ${node.id} 必须连接一个上游执行节点`
          : `End 节点 ${node.id} 不能合并多个分支输出；请为每个分支分别连接 End 节点`,
      );
    }

    const sourceNode = flowgram.nodes.find(
      (candidate) => candidate.id === incoming[0].sourceNodeID,
    );
    if (
      !sourceNode ||
      !['llm', 'http', 'code', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'loop', 'knowledge', 'subworkflow', 'mcp'].includes(sourceNode.type)
    ) {
      throw new BadRequestException(
        `结束节点 ${node.id} 仅能连接可输出结果的执行节点`,
      );
    }

    // 真实画布的 End 节点通过 inputsValues 保存每个返回值的来源。
    // 必须优先使用这些引用；仅对不含 inputsValues 的旧草稿执行单上游推断。
    const explicitInputs = Object.entries(node.data.inputsValues || {});
    const outputList = explicitInputs.length > 0
      ? explicitInputs.map(([variable, value]) => {
          if (
            !value ||
            value.type !== 'ref' ||
            !Array.isArray(value.content) ||
            value.content.length < 2
          ) {
            throw new BadRequestException(
              `End 节点 ${node.id} 的输出 ${variable} 必须引用一个上游节点变量`,
            );
          }
          const valueSelector = this.normalizeDifySelector(
            value.content.map(String),
            flowgram.nodes,
          );
          const referencedNode = flowgram.nodes.find(
            (candidate) => candidate.id === valueSelector[0],
          );
          if (!referencedNode || referencedNode.type === 'end') {
            throw new BadRequestException(
              `End 节点 ${node.id} 的输出 ${variable} 引用了不存在或无效的节点`,
            );
          }
          return {
            variable,
            value_selector: valueSelector,
          };
        })
      : (() => {
          const declaredOutputs =
            (node.data.outputs?.properties as Record<string, any>) ||
            (node.data.inputs?.properties as Record<string, any>) ||
            {};
          const outputNames = Object.keys(declaredOutputs);
          if (outputNames.length === 0) outputNames.push('result');
          return outputNames.map((variable) => ({
            variable,
            value_selector: [
              sourceNode.id,
              this.resolveEndOutputKey(sourceNode, variable, outputNames.length),
            ],
          }));
        })();

    return {
      type: 'end',
      title: node.data.title || '结束',
      desc: '',
      selected: false,
      outputs: outputList,
    };
  }

  /**
   * Dify End outputs must point at a concrete upstream variable. FlowGram's
   * End node only declares output names, so infer the selector only where it
   * is unambiguous. This avoids exporting a DSL that validates but returns an
   * arbitrary branch's result at runtime.
   */
  private resolveEndOutputKey(
    sourceNode: FlowNodeJSON,
    endOutputName: string,
    outputCount: number,
  ): string {
    if (sourceNode.type === 'llm') return 'text';
    if (sourceNode.type === 'http') {
      if (endOutputName === 'statusCode') return 'status_code';
      if (endOutputName === 'headers') return 'headers';
      return 'body';
    }
    if (sourceNode.type === 'text') return 'text';
    if (sourceNode.type === 'loop') return 'output';
    if (sourceNode.type === 'image' || sourceNode.type === 'video') {
      const contentOutputs = Object.keys(
        (sourceNode.data.outputs?.properties as Record<string, any>) || {},
      );
      if (contentOutputs.includes(endOutputName)) return endOutputName;
      if (outputCount === 1 && endOutputName === 'result') return 'url';
      throw new BadRequestException(
        `End 节点输出 ${endOutputName} 无法对应内容节点 ${sourceNode.id} 的变量`,
      );
    }

    const codeOutputs = this.getNodeOutputNames(sourceNode);
    if (codeOutputs.includes(endOutputName)) return endOutputName;
    if (codeOutputs.length === 1) return codeOutputs[0];
    if (codeOutputs.length === 0 && outputCount === 1) return 'result';

    throw new BadRequestException(
      `End 节点输出 ${endOutputName} 无法对应代码节点 ${sourceNode.id} 的变量；请使用相同的输出名`,
    );
  }

  /** 转换 HTTP 请求节点 */
  private convertHttpNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const inputsValues = node.data.inputsValues || {};
    const api = node.data.api || {};
    const method = String(
      api.method || this.getInputValue(inputsValues.method, 'GET'),
    ).toLowerCase();
    const url = this.flowValueToDifyTemplate(api.url || inputsValues.url, nodes);

    const headerLines: string[] = [];
    const legacyHeaders = this.flowValueToDifyTemplate(inputsValues.headers, nodes);
    if (legacyHeaders) {
      headerLines.push(legacyHeaders);
    }
    // Dify 0.15.3 parses HTTP headers as RFC-style `Name: Value` lines.
    // A missing space after the colon is accepted by some fields but can drop
    // templated custom headers entirely (including an idempotency key).
    headerLines.push(...this.flowMapToLines(node.data.headersValues, nodes, ': '));
    const authorization = this.authorizationToDifyConfig(node.data.authorization, nodes);

    const paramLines = this.flowMapToLines(node.data.paramsValues, nodes);
    const bodyConfig = node.data.body || {};
    const legacyBody = this.getInputValue(inputsValues.body, '');
    const methodAllowsBody = method !== 'get' && method !== 'head';
    const legacyBodyValue = methodAllowsBody && legacyBody
      ? this.flowValueToDifyTemplate(inputsValues.body, nodes)
      : '';
    const bodyType = methodAllowsBody
      ? bodyConfig.bodyType || (legacyBody ? 'raw-text' : 'none')
      : 'none';
    const bodyValue = bodyType === 'JSON'
      ? this.flowValueToDifyTemplate(bodyConfig.json, nodes) || legacyBodyValue
      : bodyType === 'raw-text'
        ? this.flowValueToDifyTemplate(bodyConfig.rawText ?? bodyConfig.json, nodes) || legacyBodyValue
        : '';
    const timeoutMs = Number(node.data.timeout?.timeout || 30000);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const retryTimes = Math.max(0, Math.min(10, Number(node.data.timeout?.retryTimes || 0)));

    const data: Record<string, unknown> = {
      type: 'http-request',
      title: node.data.title || 'HTTP 请求',
      desc: '',
      selected: false,
      method,
      url,
      authorization,
      headers: headerLines.filter(Boolean).join('\n'),
      params: paramLines.join('\n'),
      body: bodyValue
        ? {
            type: bodyType === 'JSON' ? 'json' : 'raw-text',
            data: [
              {
                key: '',
                type: 'text',
                value: bodyValue,
              },
            ],
          }
        : { type: 'none', data: [] },
      timeout: {
        connect: timeoutSeconds,
        read: timeoutSeconds,
        write: timeoutSeconds,
      },
      retry_config: {
        retry_enabled: retryTimes > 0,
        max_retries: retryTimes,
        retry_interval: 100,
      },
    };
    this.applyFailBranch(data, node);
    return data;
  }

  /** 转换代码执行节点 */
  private convertCodeNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const inputsValues = node.data.inputsValues || {};
    const codeLanguage = String(
      node.data.script?.language || this.getInputValue(inputsValues.codeLanguage, 'javascript'),
    );
    const sourceCode = String(
      node.data.script?.content || this.getInputValue(inputsValues.code, ''),
    );
    const variables: Array<{ variable: string; value_selector: string[] }> = [];
    const paramsEntries = Object.entries(inputsValues).map(([key, value]) => {
      const expression = this.compileFlowValueExpression(value, variables, key, nodes);
      return `${JSON.stringify(key)}: ${expression}`;
    });
    const analysis = assertSynchronousJavaScript(sourceCode, `代码节点 ${node.id}`);
    const identifiers = new Set(analysis.identifiers);
    const originalMainBinding = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowOriginalUserMain',
    );
    const userMainName = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowUserMain',
    );
    const rawResultName = uniqueJavaScriptIdentifier(
      identifiers,
      '__futureFlowUserResult',
    );
    const outputContract = buildOutputContractRuntime(
      identifiers,
      normalizeCodeOutputSchema(node.data.outputs, `代码节点 ${node.id}`),
      `代码节点 ${node.id}`,
    );
    const asyncError = JSON.stringify(
      `代码节点 ${node.id} 仅支持同步执行，不能返回 Promise/thenable`,
    );
    const code = `${sourceCode}
${outputContract.declarations}

const ${originalMainBinding} = main;
function ${userMainName}(args) {
  return ${originalMainBinding}(args);
}

main = function(args) {
  const params = { ${paramsEntries.join(', ')} };
  const ${rawResultName} = ${userMainName}({ params });
  if (
    ${rawResultName} !== null
    && (typeof ${rawResultName} === 'object' || typeof ${rawResultName} === 'function')
    && typeof ${rawResultName}.then === 'function'
  ) {
    throw new Error(${asyncError});
  }
  ${outputContract.validateExpression(rawResultName)};
  return ${rawResultName};
};`;

    // 从 outputs.properties 提取输出变量定义
    const outputsProps =
      (node.data.outputs?.properties as Record<string, any>) || {};
    const outputNames = Object.keys(outputsProps);
    if (outputNames.length === 0) outputNames.push('result');
    const outputs = Object.fromEntries(
      outputNames.map((key) => [
        key,
        this.toDifyCodeOutputSchema(outputsProps[key]),
      ]),
    );

    const data: Record<string, unknown> = {
      type: 'code',
      title: node.data.title || '代码执行',
      desc: '',
      selected: false,
      code_language: codeLanguage === 'javascript' ? 'javascript' : 'python3',
      code,
      variables,
      outputs,
    };
    this.applyFailBranch(data, node);
    return data;
  }

  /** 变量节点编译为 Dify 0.15.3 稳定支持的 JavaScript Code 节点。 */
  private convertVariableNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const rows = this.getVariableRows(node);
    const variables: Array<{ variable: string; value_selector: string[] }> = [];
    const existingOutputs =
      (node.data.outputs?.properties as Record<string, any>) || {};
    const outputs: Record<string, { type: string; children: Record<string, any> | null }> = {};
    const returnEntries = rows.map((row, index) => {
      const outputName = this.variableRowOutputName(row, index);
      const targetSelector = row.operator === 'assign'
        ? (row.left.content as unknown[]).map(String)
        : undefined;
      const fallbackSchema = targetSelector
        ? this.resolveSelectorSchema(targetSelector, nodes)
        : existingOutputs[outputName];
      const outputSchema = existingOutputs[outputName]
        || fallbackSchema
        || this.resolveFlowValueSchema(row.right, nodes);
      outputs[outputName] = this.toDifyCodeOutputSchema(outputSchema);
      const expression = this.compileFlowValueExpression(
        row.right as FlowInputValue,
        variables,
        outputName,
        nodes,
      );
      return `${JSON.stringify(outputName)}: ${expression}`;
    });

    return {
      type: 'code',
      title: node.data.title || '变量赋值',
      desc: '',
      selected: false,
      code_language: 'javascript',
      code: `function main(args) {\n  return { ${returnEntries.join(', ')} };\n}`,
      variables,
      outputs,
    };
  }

  /** 文本/图片/视频节点在 Dify 中编译为轻量 JavaScript 代码节点。 */
  private convertContentNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const inputsValues = node.data.inputsValues || {};
    const variables: Array<{ variable: string; value_selector: string[] }> = [];
    const expression = (key: string) =>
      this.compileFlowValueExpression(inputsValues[key], variables, key, nodes);
    const returned = node.type === 'text'
      ? `{ text: String(${expression('text')} ?? '') }`
      : node.type === 'image'
        ? `{
    url: String(${expression('url')} ?? ''),
    caption: String(${expression('caption')} ?? ''),
    mediaType: 'image'
  }`
        : `{
    url: String(${expression('url')} ?? ''),
    poster: String(${expression('poster')} ?? ''),
    caption: String(${expression('caption')} ?? ''),
    mediaType: 'video'
  }`;

    const outputKeys = node.type === 'text'
      ? ['text']
      : node.type === 'image'
        ? ['url', 'caption', 'mediaType']
        : ['url', 'poster', 'caption', 'mediaType'];

    return {
      type: 'code',
      title: node.data.title || this.contentNodeTitle(node.type),
      desc: '',
      selected: false,
      code_language: 'javascript',
      code: `function main(args) {
  return ${returned};
}`,
      variables,
      outputs: Object.fromEntries(outputKeys.map((key) => [key, { type: 'string' }])),
    };
  }

  private validateHttpNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]) {
    const candidate = node.data.api?.url || node.data.inputsValues?.url;
    // Structural validation runs before legacy node IDs are remapped.  Parse
    // references here without applying Dify's template-ID grammar; the final
    // export performs that check after the deterministic remap.
    const url = this.flowValueToDifyTemplate(candidate, nodes, false).trim();
    if (!url) throw new BadRequestException(`API 节点 ${node.id} 的请求地址不能为空`);
    if (!/^https?:\/\//i.test(url) && !url.includes('{{#')) {
      throw new BadRequestException(`API 节点 ${node.id} 仅支持 HTTP 或 HTTPS 地址`);
    }
    if (!url.includes('{{#')) {
      try {
        const hostname = new URL(url).hostname;
        if (this.isBlockedHttpHostname(hostname)) {
          throw new BadRequestException(`API 节点 ${node.id} 不能访问本机、私网或云元数据地址`);
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(`API 节点 ${node.id} 的请求地址格式无效`);
      }
    }
    const method = String(
      node.data.api?.method ||
      this.getInputValue(node.data.inputsValues?.method, 'GET'),
    ).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      throw new BadRequestException(`API 节点 ${node.id} 使用了不支持的请求方法`);
    }

    for (const headerName of Object.keys(node.data.headersValues || {})) {
      if (!this.isValidHttpHeaderName(headerName)) {
        throw new BadRequestException(
          `API 节点 ${node.id} 的自定义请求头名称不能为空或包含非法字符`,
        );
      }
    }
    for (const paramName of Object.keys(node.data.paramsValues || {})) {
      if (!paramName || /\s/u.test(paramName)) {
        throw new BadRequestException(
          `API 节点 ${node.id} 的查询参数名称不能为空，也不能包含空白或换行符`,
        );
      }
    }

    const authorization = node.data.authorization || { type: 'none' };
    if (authorization.type === 'bearer') {
      if (!this.isNonEmptyFlowValue(authorization.token)) {
        throw new BadRequestException(`API 节点 ${node.id} 的 Bearer 令牌不能为空`);
      }
    } else if (authorization.type === 'api-key') {
      if (authorization.headerName?.type !== 'constant') {
        throw new BadRequestException(`API 节点 ${node.id} 的 API 密钥请求头名称必须使用常量`);
      }
      const headerName = String(authorization.headerName.content ?? '');
      if (!this.isValidHttpHeaderName(headerName)) {
        throw new BadRequestException(`API 节点 ${node.id} 的 API 密钥请求头名称格式无效`);
      }
      if (!this.isNonEmptyFlowValue(authorization.apiKey)) {
        throw new BadRequestException(`API 节点 ${node.id} 的 API 密钥不能为空`);
      }
    } else if (authorization.type === 'basic') {
      if (!this.isNonEmptyConstant(authorization.username)) {
        throw new BadRequestException(`API 节点 ${node.id} 的 Basic 用户名必须使用非空常量`);
      }
      if (!this.isNonEmptyConstant(authorization.password)) {
        throw new BadRequestException(`API 节点 ${node.id} 的 Basic 密码必须使用非空常量`);
      }
    } else if (authorization.type !== 'none') {
      throw new BadRequestException(`API 节点 ${node.id} 的身份认证类型无效`);
    }

    const timeout = node.data.timeout || {};
    if (
      timeout.timeout !== undefined &&
      (
        typeof timeout.timeout !== 'number' ||
        !Number.isInteger(timeout.timeout) ||
        timeout.timeout < 1 ||
        timeout.timeout > 120000
      )
    ) {
      throw new BadRequestException(`API 节点 ${node.id} 的超时时间必须是 1 到 120000 之间的整数`);
    }
    if (
      timeout.retryTimes !== undefined &&
      (
        typeof timeout.retryTimes !== 'number' ||
        !Number.isInteger(timeout.retryTimes) ||
        timeout.retryTimes < 0 ||
        timeout.retryTimes > 10
      )
    ) {
      throw new BadRequestException(`API 节点 ${node.id} 的重试次数必须是 0 到 10 之间的整数`);
    }

    if (method !== 'GET' && method !== 'HEAD') {
      const body = node.data.body || {};
      const bodyType = body.bodyType || 'none';
      if (!['none', 'JSON', 'raw-text'].includes(bodyType)) {
        throw new BadRequestException(`API 节点 ${node.id} 的请求体类型无效`);
      }
      if (bodyType === 'JSON' && !this.isNonEmptyFlowValue(body.json)) {
        throw new BadRequestException(`API 节点 ${node.id} 选择 JSON 请求体后内容不能为空`);
      }
      if (
        bodyType === 'raw-text' &&
        !this.isNonEmptyFlowValue(body.rawText ?? body.json)
      ) {
        throw new BadRequestException(`API 节点 ${node.id} 选择纯文本请求体后内容不能为空`);
      }
    }
  }

  private isValidHttpHeaderName(value: string): boolean {
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
  }

  private isNonEmptyFlowValue(value: any): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (!value || typeof value !== 'object') return false;
    if (value.type === 'ref') {
      return Array.isArray(value.content) &&
        value.content.length >= 2 &&
        value.content.every((segment: unknown) => String(segment).trim().length > 0);
    }
    if (value.content === undefined || value.content === null) return false;
    return String(value.content).trim().length > 0;
  }

  private isNonEmptyConstant(value: any): boolean {
    return value?.type === 'constant' && this.isNonEmptyFlowValue(value);
  }

  /** 快速拒绝显式私网目标；域名解析后的最终拦截由 Squid `dst` ACL 执行。 */
  private isBlockedHttpHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return true;
    }

    const octets = host.split('.').map(Number);
    if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      const [a, b] = octets;
      return a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224;
    }

    if (host.includes(':')) {
      return host === '::' ||
        host === '::1' ||
        host.startsWith('::ffff:') ||
        /^f[cd]/.test(host) ||
        /^fe[89ab]/.test(host);
    }
    return false;
  }

  /**
   * 变量聚合节点归一化：编译成等价的同步 JavaScript 代码节点（保留原节点 id）。
   * 取值规则与画布/本地运行时一致：每个分组返回第一个非空的值，
   * 全为空时返回该类型的安全空值（'' / 0 / false / [] / {}）。
   */
  private normalizeAggregatorNodes(flowgram: FlowGramJSON): FlowGramJSON {
    if (!flowgram || !Array.isArray(flowgram.nodes)) return flowgram;
    if (!flowgram.nodes.some((node) => node.type === 'variable-aggregator')) return flowgram;
    const working = this.cloneValue(flowgram) as FlowGramJSON;
    const nodes = working.nodes.map((node) => {
      if (node.type !== 'variable-aggregator') return node;
      const groups = (node.data?.groups || []) as Array<{ key?: string; values?: FlowInputValue[] }>;
      if (!Array.isArray(groups) || groups.length === 0) {
        throw new BadRequestException(`变量聚合节点 ${node.id} 至少需要一个分组`);
      }
      const inputsValues: Record<string, FlowInputValue> = {};
      const inputsProperties: Record<string, any> = {};
      const groupTypes: Record<string, string> = {};
      const seen = new Set<string>();
      groups.forEach((group, groupIndex) => {
        const key = String(group?.key || '').trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new BadRequestException(
            `变量聚合节点 ${node.id} 的分组输出名需以字母或下划线开头，仅包含字母、数字和下划线`,
          );
        }
        if (seen.has(key)) {
          throw new BadRequestException(`变量聚合节点 ${node.id} 的分组输出名重复：${key}`);
        }
        seen.add(key);
        const values = Array.isArray(group?.values) ? group.values : [];
        if (values.length === 0) {
          throw new BadRequestException(`变量聚合节点 ${node.id} 的分组 ${key} 至少需要一个变量`);
        }
        values.forEach((value, valueIndex) => {
          if (!value || value.type !== 'ref' || !Array.isArray(value.content) || value.content.length < 2) {
            throw new BadRequestException(`变量聚合节点 ${node.id} 的分组 ${key} 里有未选择的变量`);
          }
          const source = working.nodes.find((candidate) => candidate.id === value.content[0]);
          const schema = (source?.data?.outputs as any)?.properties?.[String(value.content[1])];
          const type = DifyConverterService.normalizeAggregateType(schema?.type);
          if (!groupTypes[key]) groupTypes[key] = type;
          else if (groupTypes[key] !== type) {
            throw new BadRequestException(
              `变量聚合节点 ${node.id} 的分组 ${key} 内变量类型必须一致（${groupTypes[key]} 与 ${type}）`,
            );
          }
          const name = `v${groupIndex}_${valueIndex}`;
          inputsValues[name] = value;
          inputsProperties[name] = { type, title: name };
        });
      });

      const fallback = (type: string) => {
        switch (type) {
          case 'number': return '0';
          case 'boolean': return 'false';
          case 'array': return '[]';
          case 'object': return '{}';
          default: return "''";
        }
      };
      const lines = [
        'function main({ params }) {',
        '  const pickFirst = (values, fallback) => {',
        '    for (const value of values) {',
        '      if (value === null || value === undefined) continue;',
        "      if (typeof value === 'string' && value.trim() === '') continue;",
        '      if (Array.isArray(value) && value.length === 0) continue;',
        '      return value;',
        '    }',
        '    return fallback;',
        '  };',
        '  return {',
        ...groups.map((group, groupIndex) => {
          const key = String(group?.key || '').trim();
          const params = (group.values || [])
            .map((_value, valueIndex) => `params[${JSON.stringify(`v${groupIndex}_${valueIndex}`)}]`)
            .join(', ');
          return `    ${JSON.stringify(key)}: pickFirst([${params}], ${fallback(groupTypes[key] || 'string')}),`;
        }),
        '  };',
        '}',
      ];
      const outputs = {
        type: 'object',
        properties: Object.fromEntries(
          groups.map((group) => {
            const key = String(group?.key || '').trim();
            return [key, { type: groupTypes[key] || 'string', title: key }];
          }),
        ),
      };
      return {
        ...node,
        type: 'code',
        data: {
          ...node.data,
          inputsValues,
          inputs: { type: 'object', properties: inputsProperties },
          script: { language: 'javascript', content: lines.join(String.fromCharCode(10)) },
          outputs,
        },
      } as FlowNodeJSON;
    });
    return { ...working, nodes };
  }

  /** 类型归一化：integer 与 number 视为同类，未知类型按字符串处理 */
  private static normalizeAggregateType(type: unknown): string {
    const normalized = String(type || 'string').toLowerCase();
    if (normalized === 'integer' || normalized === 'number') return 'number';
    return ['string', 'boolean', 'object', 'array'].includes(normalized) ? normalized : 'string';
  }

  /** 循环类型上限：单次运行最多 20 轮，与画布/本地运行时保持一致。 */
  private static readonly LOOP_MAX_ROUNDS = 20;

  /**
   * 循环类型归一化：
   *  - array   ：不变，数组来自上游变量；
   *  - count   ：在循环上游插入生成 [1..N] 的代码节点，循环数组指向它；
   *  - infinite：同上，N 取「最大轮数」（循环体是同步 JS，必须有上限）。
   * 同时把循环节点的「中间变量」注入循环体代码节点入参（对应 iteration 的中间变量）。
   */
  private normalizeLoopTypes(flowgram: FlowGramJSON): FlowGramJSON {
    // 结构非法的图（例如 nodes 不是数组）交给 validateFlowGram 报 400，
    // 这里只做归一化，不能把结构错误变成 TypeError。
    if (!flowgram || !Array.isArray(flowgram.nodes) || !Array.isArray(flowgram.edges)) {
      return flowgram;
    }
    if (!flowgram.nodes.some((node) => node.type === 'loop')) return flowgram;
    // 深拷贝后再改写：归一化只是转换期的临时图，绝不能把「指向临时节点」的
    // loopFor 写回调用方（否则草稿会引用一个并不存在的节点）。
    const working = this.cloneValue(flowgram) as FlowGramJSON;
    const loops = (working.nodes || []).filter((node) => node.type === 'loop');
    if (loops.length === 0) return working;
    const nodes = [...working.nodes];
    const edges = [...working.edges];
    const injected: FlowNodeJSON[] = [];

    for (const loop of loops) {
      this.applyLoopMiddleValues(loop, nodes);
      this.applyLoopItemType(loop, nodes);
      const loopType = String(loop.data?.loopType || 'array');
      if (!['count', 'infinite'].includes(loopType)) continue;
      const rawRounds = loopType === 'count' ? loop.data?.loopCount : loop.data?.loopMaxRounds;
      const parsed = Number(rawRounds);
      const rounds = Number.isFinite(parsed)
        ? Math.min(DifyConverterService.LOOP_MAX_ROUNDS, Math.max(1, Math.trunc(parsed)))
        : DifyConverterService.LOOP_MAX_ROUNDS;
      const rangeId = `${loop.id}_range`;
      // 幂等：validateFlowGram 会重复归一化同一张图，轮次数组只能插入一次
      if (nodes.some((node) => node.id === rangeId)) {
        loop.data = loop.data || {};
        loop.data.loopFor = { type: 'ref', content: [rangeId, 'items'] };
        continue;
      }
      const position = loop.meta?.position || { x: 0, y: 0 };
      injected.push({
        id: rangeId,
        type: 'code',
        meta: { position: { x: Number(position.x) - 300, y: Number(position.y) } },
        data: {
          title: `${loop.data?.title || '循环'} · 轮次数组`,
          inputsValues: {},
          inputs: { type: 'object', properties: {} },
          script: {
            language: 'javascript',
            content: `function main() {
  return { items: Array.from({ length: ${rounds} }, (_, index) => index + 1) };
}`,
          },
          outputs: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'number' }, title: '轮次数组' } },
          },
        },
      });
      for (let index = 0; index < edges.length; index += 1) {
        if (edges[index]?.targetNodeID === loop.id) {
          edges[index] = { ...edges[index], targetNodeID: rangeId };
        }
      }
      edges.push({ sourceNodeID: rangeId, targetNodeID: loop.id });
      loop.data = loop.data || {};
      loop.data.loopFor = { type: 'ref', content: [rangeId, 'items'] };
    }

    if (injected.length === 0) return { ...working, edges };
    return { ...working, nodes: [...nodes, ...injected], edges };
  }

  /**
   * 让循环体的 item 类型跟随数组元素类型：数组元素是对象时，
   * 循环体里就能通过 item.<属性> 取字段（与本地运行时同一套规则）。
   */
  private applyLoopItemType(loop: FlowNodeJSON, nodes: FlowNodeJSON[]): void {
    const loopFor = loop.data?.loopFor as FlowInputValue | undefined;
    if (!loopFor || loopFor.type !== 'ref' || !Array.isArray(loopFor.content) || loopFor.content.length < 2) {
      return;
    }
    const source = nodes.find((candidate) => candidate.id === loopFor.content[0]);
    const schema = (source?.data?.outputs as any)?.properties?.[String(loopFor.content[1])];
    const items = schema?.type === 'array' ? schema.items : null;
    if (!items || typeof items !== 'object') return;
    const codeNodes = (loop.blocks || []).filter((block) => block.type === 'code');
    for (const codeNode of codeNodes) {
      const current = (codeNode?.data?.inputs as any)?.properties?.item;
      if (!codeNode?.data?.inputs?.properties || !current) continue;
      codeNode.data.inputs.properties = {
        ...codeNode.data.inputs.properties,
        item: { ...current, ...this.cloneValue(items) },
      };
    }
  }

  /** 把循环节点的中间变量写进循环体内所有代码节点的入参，循环体里用 params.<名字> 读取。 */
  private applyLoopMiddleValues(loop: FlowNodeJSON, nodes: FlowNodeJSON[]): void {
    const middleValues = loop.data?.loopMiddleValues as Record<string, FlowInputValue> | undefined;
    const codeNodes = (loop.blocks || []).filter((block) => block.type === 'code');
    if (codeNodes.length === 0 || !middleValues) return;
    for (const codeNode of codeNodes) {
      for (const [name, mapping] of Object.entries(middleValues)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        if (!mapping || mapping.type !== 'ref' || !Array.isArray(mapping.content) || mapping.content.length < 2) {
          continue;
        }
        const source = nodes.find((candidate) => candidate.id === mapping.content[0]);
        const schema = (source?.data?.outputs as any)?.properties?.[String(mapping.content[1])];
        codeNode.data = codeNode.data || {};
        codeNode.data.inputsValues = { ...(codeNode.data.inputsValues || {}), [name]: mapping };
        codeNode.data.inputs = codeNode.data.inputs || { type: 'object', properties: {} };
        codeNode.data.inputs.properties = {
          ...(codeNode.data.inputs.properties || {}),
          [name]: schema && typeof schema === 'object' ? { ...schema } : { type: 'string' },
        };
      }
    }
  }

  /** 循环体是「块开始 → 若干内部节点（单链）→ 块结束」的子画布。 */
  private validateBatchLoopNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]) {
    if (!Array.isArray(node.blocks) || node.blocks.length < 3) {
      throw new BadRequestException(
        `循环节点 ${node.id} 的循环体至少需要一个节点（块开始 → … → 块结束）`,
      );
    }
    if (!Array.isArray(node.edges)) {
      throw new BadRequestException(`循环节点 ${node.id} 的内部连线缺失`);
    }

    for (const block of node.blocks) {
      if (
        !block
        || typeof block.id !== 'string'
        || !block.id.trim()
        || typeof block.type !== 'string'
        || !block.data
        || typeof block.data !== 'object'
        || Array.isArray(block.data)
      ) {
        throw new BadRequestException(`循环节点 ${node.id} 包含无效的子节点`);
      }
    }

    const blockStart = node.blocks[0];
    const blockEnd = node.blocks[node.blocks.length - 1];
    const innerNodes = node.blocks.slice(1, -1);
    if (blockStart.type !== 'block-start' || blockEnd.type !== 'block-end') {
      throw new BadRequestException(
        `循环节点 ${node.id} 的循环体必须以块开始/块结束包住内部节点`,
      );
    }
    for (const block of node.blocks) {
      if (block.blocks !== undefined || block.edges !== undefined) {
        throw new BadRequestException(`循环节点 ${node.id} 不支持嵌套子画布`);
      }
    }
    for (const block of innerNodes) {
      if (block.type === 'loop') {
        throw new BadRequestException(`循环节点 ${node.id} 暂不支持嵌套循环`);
      }
      if (block.type === 'condition' || block.type === 'multi-condition') {
        throw new BadRequestException(
          `循环节点 ${node.id} 的循环体内暂不支持分支节点，请使用单链结构`,
        );
      }
      if (['start', 'end', 'block-start', 'block-end'].includes(block.type)) {
        throw new BadRequestException(
          `循环节点 ${node.id} 的循环体包含不允许的节点类型 ${block.type}`,
        );
      }
      if (block.type === 'exit' || block.type === 'break' || block.type === 'continue') {
        throw new BadRequestException(
          `循环节点 ${node.id} 的「退出节点（跳出当前循环）」暂不支持发布到云端（Dify 的循环无法中途跳出），请使用本地试运行`,
        );
      }
    }

    // 内部连线必须是「块开始 → 内部节点…（单链）→ 块结束」：
    // 每个节点最多一条出线，从块开始一路串到块结束且覆盖全部节点。
    if (node.edges.length !== innerNodes.length + 1) {
      throw new BadRequestException(
        `循环节点 ${node.id} 的内部连线必须是「块开始 → … → 块结束」的单链`,
      );
    }
    const chainError = `循环节点 ${node.id} 的内部连线必须是「块开始 → … → 块结束」的单链`;
    const nextOf = new Map<string, string>();
    const blockIds = new Set(node.blocks.map((block) => block.id));
    for (const edge of node.edges) {
      if (
        edge.sourcePortID
        || edge.targetPortID
        || !blockIds.has(edge.sourceNodeID)
        || !blockIds.has(edge.targetNodeID)
        || nextOf.has(edge.sourceNodeID)
      ) {
        throw new BadRequestException(chainError);
      }
      nextOf.set(edge.sourceNodeID, edge.targetNodeID);
    }
    const visited = new Set<string>([blockStart.id]);
    let cursor = blockStart.id;
    while (cursor !== blockEnd.id) {
      const next = nextOf.get(cursor);
      if (!next || visited.has(next)) {
        throw new BadRequestException(chainError);
      }
      visited.add(next);
      cursor = next;
    }
    if (visited.size !== node.blocks.length || nextOf.has(blockEnd.id)) {
      throw new BadRequestException(chainError);
    }

    // 循环体内的代码节点：同步 JavaScript、且必须且只能声明一个输出
    //（循环体按单链传递，代码节点输出数是链式适配的约束）。
    for (const block of innerNodes) {
      if (block.type !== 'code') continue;
      this.validateCodeNode(block);
      const codeOutputs = (block.data.outputs?.properties || {}) as Record<string, any>;
      const codeOutputNames = Object.keys(codeOutputs);
      if (codeOutputNames.length !== 1) {
        throw new BadRequestException(
          `循环节点 ${node.id} 的代码节点 ${block.id} 必须且只能声明一个输出`,
        );
      }
      const scalarType = String(codeOutputs[codeOutputNames[0]]?.type || '').toLowerCase();
      if (!['string', 'number', 'integer', 'boolean'].includes(scalarType)) {
        throw new BadRequestException(
          `循环节点 ${node.id} 的代码节点 ${block.id} 输出仅支持字符串或数字（布尔值按数字 1/0 兼容）`,
        );
      }
    }

    const selector = this.getBatchLoopSelector(node);
    const source = nodes.find((candidate) => candidate.id === selector[0]);
    if (!source || source.type === 'end' || !this.getNodeOutputNames(source).includes(selector[1])) {
      throw new BadRequestException(`循环节点 ${node.id} 引用了不存在的数组变量`);
    }
    const inputSchema = this.resolveSelectorSchema(selector, nodes);
    const inputItemType = String(inputSchema?.items?.type || '').toLowerCase();
    // 数组元素可以是标量，也可以是对象：对象数组时循环体通过 item.<属性> 取字段
    if (inputSchema?.type !== 'array' || !['string', 'number', 'integer', 'boolean', 'object'].includes(inputItemType)) {
      throw new BadRequestException(
        `循环节点 ${node.id} 的输入仅支持字符串、数字或对象数组`,
      );
    }

    const loopOutputs = Object.entries(node.data.loopOutputs || {}) as Array<[
      string,
      FlowInputValue | undefined,
    ]>;
    if (loopOutputs.length !== 1) {
      throw new BadRequestException(`循环节点 ${node.id} 必须且只能设置一个输出`);
    }
    const [loopOutputName, loopOutput] = loopOutputs[0];
    const innerIds = new Set(innerNodes.map((block) => block.id));
    const outputNode = innerNodes.find(
      (block) => block.id === String(loopOutput?.content?.[0]),
    );
    if (
      !loopOutputName
      || !loopOutput
      || loopOutput.type !== 'ref'
      || !Array.isArray(loopOutput.content)
      || loopOutput.content.length !== 2
      || !innerIds.has(String(loopOutput.content[0]))
      || !outputNode
      || !this.getNodeOutputNames(outputNode).includes(String(loopOutput.content[1]))
    ) {
      throw new BadRequestException(
        `循环节点 ${node.id} 的输出必须引用循环体内某个节点的输出`,
      );
    }
    const outputSchema = (outputNode.data.outputs?.properties || {})[
      String(loopOutput.content[1])
    ] as Record<string, any> | undefined;
    const scalarType = String(outputSchema?.type || '').toLowerCase();
    if (!['string', 'number', 'integer', 'boolean'].includes(scalarType)) {
      throw new BadRequestException(
        `循环节点 ${node.id} 的输出仅支持字符串或数字（布尔值按数字 1/0 兼容）`,
      );
    }

    const declaredOutputs = (node.data.outputs?.properties || {}) as Record<string, any>;
    if (Object.keys(declaredOutputs).length > 0) {
      const expectedItemType = scalarType === 'string' ? 'string' : 'number';
      const declaredItemType = String(
        declaredOutputs[loopOutputName]?.items?.type || '',
      ).toLowerCase();
      const normalizedDeclaredItemType = ['number', 'integer', 'boolean'].includes(declaredItemType)
        ? 'number'
        : declaredItemType;
      if (
        Object.keys(declaredOutputs).length !== 1
        || !declaredOutputs[loopOutputName]
        || declaredOutputs[loopOutputName].type !== 'array'
        || normalizedDeclaredItemType !== expectedItemType
      ) {
        throw new BadRequestException(`循环节点 ${node.id} 的输出声明与批处理结果不一致`);
      }
    }
  }

  private getBatchLoopSelector(node: FlowNodeJSON): string[] {
    const loopFor = node.data.loopFor;
    if (
      !loopFor
      || loopFor.type !== 'ref'
      || !Array.isArray(loopFor.content)
      || loopFor.content.length !== 2
    ) {
      throw new BadRequestException(`循环节点 ${node.id} 必须选择一个上游数组变量`);
    }
    return loopFor.content.map(String);
  }

  private isTopLevelReachable(
    sourceId: string,
    targetId: string,
    adjacency: Map<string, string[]>,
    skippedId?: string,
  ): boolean {
    if (
      sourceId === targetId
      || sourceId === skippedId
      || targetId === skippedId
      || !adjacency.has(sourceId)
    ) return false;
    const seen = new Set<string>([sourceId]);
    const pending = [sourceId];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const next of adjacency.get(current) || []) {
        if (next === skippedId) continue;
        if (next === targetId) return true;
        if (!seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
    return false;
  }

  private getFlowValueSelectors(value: unknown): string[][] {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, any>;
    if (record.type === 'ref' && Array.isArray(record.content)) {
      return [record.content.map(String)];
    }
    if (
      (record.type === 'template' || record.type === 'expression')
      && typeof record.content === 'string'
    ) {
      return [...record.content.matchAll(/\{\{#?([^{}#]+)#?\}\}/g)]
        .map((match) => match[1].trim().split('.').filter(Boolean));
    }
    return [];
  }

  private validateBatchLoopInnerReferences(loop: FlowNodeJSON) {
    const blocks = loop.blocks || [];
    const innerNodes = blocks.slice(1, -1);
    const innerIds = new Set(innerNodes.map((block) => block.id));
    // 循环节点的「中间变量」允许循环体读取循环外的值，这里放行这些在循环节点上
    // 显式声明的入参；代码节点的其余外部引用仍然禁止，保持循环体可预测。
    const middleNames = new Set(
      Object.keys((loop.data?.loopMiddleValues || {}) as Record<string, unknown>),
    );
    for (const block of innerNodes) {
      const isCode = block.type === 'code';
      for (const [name, value] of Object.entries(block.data.inputsValues || {})) {
        for (const selector of this.getFlowValueSelectors(value)) {
          if (selector[0] === `${loop.id}_locals`) {
            // 循环项/序号仅代码节点可通过 params 读取：非代码节点的模板引用
            // 在 Dify 里无法解析，提前拦截
            if (!isCode || selector.length !== 2 || !['item', 'index'].includes(selector[1])) {
              throw new BadRequestException(
                `循环节点 ${loop.id} 的循环项 item / 序号 index 只能在循环体内的代码节点里通过 params 读取`,
              );
            }
            continue;
          }
          if (innerIds.has(selector[0])) {
            // 循环体内单链数据传递：允许引用内部其它节点的输出
            continue;
          }
          if (!isCode) {
            // 非代码节点允许引用循环体外变量（由各类型自身的校验器把关）
            continue;
          }
          if (middleNames.has(name)) continue;
          throw new BadRequestException(
            `循环节点 ${loop.id} 的代码节点 ${block.id} 只能引用当前项 item、序号 index、循环体内其它节点或节点的中间变量`,
          );
        }
      }
    }
  }

  private validateCodeNode(node: FlowNodeJSON) {
    const inputsValues = node.data.inputsValues || {};
    const language = String(
      node.data.script?.language || this.getInputValue(inputsValues.codeLanguage, 'javascript'),
    );
    const code = String(node.data.script?.content || this.getInputValue(inputsValues.code, ''));
    if (language !== 'javascript') {
      throw new BadRequestException(`代码节点 ${node.id} 当前仅支持 JavaScript`);
    }
    if (!code.trim()) throw new BadRequestException(`代码节点 ${node.id} 的脚本不能为空`);
    try {
      assertSynchronousJavaScript(code, `代码节点 ${node.id}`);
      normalizeCodeOutputSchema(node.data.outputs, `代码节点 ${node.id}`);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private validateVariableNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]) {
    const rows = this.getVariableRows(node);
    if (rows.length === 0) {
      throw new BadRequestException(`变量节点 ${node.id} 至少需要设置一个变量`);
    }

    const outputNames = new Set<string>();
    const assignedTargets = new Set<string>();
    rows.forEach((row, index) => {
      const outputName = this.variableRowOutputName(row, index);
      if (row.operator === 'declare') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(outputName)) {
          throw new BadRequestException(
            `变量节点 ${node.id} 的变量名“${outputName || '空'}”格式无效；需以字母或下划线开头`,
          );
        }
      } else if (row.operator === 'assign') {
        const target = row.left?.content;
        if (
          row.left?.type !== 'ref'
          || !Array.isArray(target)
          || target.length !== 2
          || target.some((part: unknown) => !String(part))
        ) {
          throw new BadRequestException(
            `变量节点 ${node.id} 的赋值目标必须是一个顶层流程变量`,
          );
        }
        const normalizedTarget = target.map(String);
        if (normalizedTarget[0] === 'global') {
          throw new BadRequestException(
            `变量节点 ${node.id} 暂不支持修改 global 全局变量`,
          );
        }
        const source = nodes.find((candidate) => candidate.id === normalizedTarget[0]);
        if (!source || source.type === 'end') {
          throw new BadRequestException(
            `变量节点 ${node.id} 的赋值目标引用了不存在或无效的节点`,
          );
        }
        if (!this.getNodeOutputNames(source).includes(normalizedTarget[1])) {
          throw new BadRequestException(
            `变量节点 ${node.id} 的赋值目标 ${normalizedTarget.join('.')} 不存在`,
          );
        }
        const targetKey = normalizedTarget.join('\u0000');
        if (assignedTargets.has(targetKey)) {
          throw new BadRequestException(`变量节点 ${node.id} 不能重复修改同一个变量`);
        }
        assignedTargets.add(targetKey);
      } else {
        throw new BadRequestException(`变量节点 ${node.id} 包含不支持的操作`);
      }

      if (outputNames.has(outputName)) {
        throw new BadRequestException(`变量节点 ${node.id} 包含重复的变量名称`);
      }
      outputNames.add(outputName);

      const right = row.right;
      if (!right || !['constant', 'ref', 'template'].includes(right.type)) {
        throw new BadRequestException(`变量节点 ${node.id} 的变量值不能为空或类型不受支持`);
      }
      if (right.type === 'constant' && !Object.prototype.hasOwnProperty.call(right, 'content')) {
        throw new BadRequestException(`变量节点 ${node.id} 的变量值不能为空`);
      }
      if (right.type === 'ref') {
        const selector = right.content;
        if (!Array.isArray(selector) || selector.length < 2) {
          throw new BadRequestException(`变量节点 ${node.id} 的变量引用格式无效`);
        }
        this.normalizeDifySelector(selector.map(String), nodes);
      }
      if (right.type === 'template' && typeof right.content !== 'string') {
        throw new BadRequestException(`变量节点 ${node.id} 的模板值格式无效`);
      }
    });
  }

  private getVariableRows(node: FlowNodeJSON): any[] {
    return Array.isArray(node.data.assign) ? node.data.assign : [];
  }

  private variableRowOutputName(row: any, index: number): string {
    return row.operator === 'declare'
      ? String(row.left || '')
      : `assigned_${index + 1}`;
  }

  private getNodeOutputNames(node: FlowNodeJSON): string[] {
    if (isNativeMediaNode(node)) return Object.keys(NATIVE_MEDIA_OUTPUTS);
    const declared = Object.keys(
      (node.data.outputs?.properties as Record<string, any>) || {},
    );
    if (node.type === 'variable') {
      const variableOutputs = this.getVariableRows(node).map((row, index) =>
        this.variableRowOutputName(row, index),
      );
      return [...new Set([...declared, ...variableOutputs])];
    }
    if (node.type === 'loop') {
      const loopOutputs = Object.keys(node.data.loopOutputs || {});
      return [...new Set([...declared, ...loopOutputs])];
    }
    if (declared.length > 0) return declared;
    if (node.type === 'llm') return ['result', 'text'];
    if (node.type === 'http') return ['body', 'statusCode', 'status_code', 'headers'];
    if (node.type === 'text') return ['text'];
    if (node.type === 'image') return ['url', 'caption', 'mediaType'];
    if (node.type === 'video') return ['url', 'poster', 'caption', 'mediaType'];
    if (node.type === 'code') return ['result'];
    return [];
  }

  private resolveFlowValueSchema(
    value: any,
    nodes: FlowNodeJSON[],
    seen: Set<string> = new Set(),
  ): any {
    if (value?.schema?.type) return value.schema;
    if (value?.type === 'ref' && Array.isArray(value.content)) {
      return this.resolveSelectorSchema(value.content.map(String), nodes, seen);
    }
    if (value?.type === 'template' || value?.type === 'expression') {
      return { type: 'string' };
    }
    if (value?.type === 'constant') return this.inferJsonSchema(value.content);
    return { type: 'string' };
  }

  private resolveSelectorSchema(
    selector: string[],
    nodes: FlowNodeJSON[],
    seen: Set<string> = new Set(),
  ): any {
    if (selector.length < 2) return { type: 'string' };
    const cacheKey = selector.join('\u0000');
    if (seen.has(cacheKey)) return { type: 'string' };
    const nextSeen = new Set(seen).add(cacheKey);
    const source = nodes.find((node) => node.id === selector[0]);
    if (!source) return { type: 'string' };

    let schema = (source.data.outputs?.properties as Record<string, any> | undefined)?.[
      selector[1]
    ];
    if (!schema && source.type === 'variable') {
      const row = this.getVariableRows(source).find(
        (candidate, index) => this.variableRowOutputName(candidate, index) === selector[1],
      );
      if (row) {
        const fallback = row.operator === 'assign'
          ? this.resolveSelectorSchema(row.left.content.map(String), nodes, nextSeen)
          : undefined;
        schema = fallback || this.resolveFlowValueSchema(row.right, nodes, nextSeen);
      }
    }
    if (!schema && source.type === 'loop') {
      const loopOutput = Object.entries(source.data.loopOutputs || {})
        .find(([name]) => name === selector[1])?.[1] as any;
      const innerNodes = ((source.blocks || []) as FlowNodeJSON[]).slice(1, -1);
      if (loopOutput?.type === 'ref' && Array.isArray(loopOutput.content)) {
        const outputNode = innerNodes.find(
          (block) => block.id === String(loopOutput.content[0]),
        );
        const scalar = (outputNode?.data.outputs?.properties as Record<string, any> | undefined)?.[
          String(loopOutput.content[1])
        ];
        if (scalar) {
          schema = {
            type: 'array',
            items: String(scalar.type).toLowerCase() === 'boolean'
              ? { ...scalar, type: 'number' }
              : scalar,
          };
        }
      }
    }
    if (!schema) {
      if (source.type === 'llm' && ['text', 'result'].includes(selector[1])) {
        schema = { type: 'string' };
      } else if (source.type === 'http') {
        schema = { type: selector[1] === 'statusCode' || selector[1] === 'status_code' ? 'integer' : 'string' };
      } else if (source.type === 'text') {
        schema = { type: 'string' };
      } else if (source.type === 'image' || source.type === 'video') {
        schema = { type: 'string' };
      }
    }

    for (const segment of selector.slice(2)) {
      schema = schema?.type === 'array'
        ? schema.items
        : schema?.properties?.[segment];
      if (!schema) return { type: 'string' };
    }
    return schema || { type: 'string' };
  }

  private inferJsonSchema(value: unknown): any {
    if (Array.isArray(value)) {
      return {
        type: 'array',
        items: value.length > 0 ? this.inferJsonSchema(value[0]) : { type: 'string' },
      };
    }
    if (value !== null && typeof value === 'object') {
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, child]) => [
            key,
            this.inferJsonSchema(child),
          ]),
        ),
      };
    }
    if (typeof value === 'boolean') return { type: 'boolean' };
    if (typeof value === 'number') {
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    }
    return { type: 'string' };
  }

  private validateContentNode(node: FlowNodeJSON) {
    if (node.type === 'image' || node.type === 'video') {
      validateNativeMediaNode(node);
      if (isNativeMediaNode(node)) return;
    }
    const requiredKey = node.type === 'text' ? 'text' : 'url';
    const value = node.data.inputsValues?.[requiredKey];
    if (this.getInputValue(value, '') === '') {
      throw new BadRequestException(`${this.contentNodeTitle(node.type)} ${node.id} 的${requiredKey === 'url' ? '资源地址' : '文本内容'}不能为空`);
    }
  }

  private flowValueToDifyTemplate(
    input: FlowInputValue | string | undefined,
    nodes: FlowNodeJSON[],
    enforceTemplateContract = true,
  ): string {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') {
      return this.convertVariableRefs(input, nodes, enforceTemplateContract);
    }
    if (input.type === 'constant') return String(input.content ?? '');
    if (input.type === 'ref' && Array.isArray(input.content)) {
      const selector = enforceTemplateContract
        ? this.normalizeDifyTemplateSelector(input.content.map(String), nodes)
        : this.normalizeDifySelector(input.content.map(String), nodes);
      return `{{#${selector.join('.')}#}}`;
    }
    return this.convertVariableRefs(
      String(input.content ?? ''),
      nodes,
      enforceTemplateContract,
    );
  }

  private flowMapToLines(
    values: Record<string, FlowInputValue> | undefined,
    nodes: FlowNodeJSON[],
    separator = ':',
  ): string[] {
    if (!values) return [];
    return Object.entries(values)
      .filter(([key]) => key.trim())
      .map(([key, value]) => `${key}${separator}${this.flowValueToDifyTemplate(value, nodes)}`);
  }

  /**
   * Dify 0.15.3 only masks credentials in HTTP execution logs when they use
   * the native `api-key` authorization schema. Never flatten secrets into the
   * ordinary header block: that block is copied verbatim into process_data.
   */
  private authorizationToDifyConfig(authorization: any, nodes: FlowNodeJSON[]): any {
    if (!authorization || authorization.type === 'none') return { type: 'no-auth' };
    if (authorization.type === 'bearer') {
      return {
        type: 'api-key',
        config: {
          type: 'bearer',
          api_key: this.flowValueToDifyTemplate(authorization.token, nodes),
          header: 'Authorization',
        },
      };
    }
    if (authorization.type === 'api-key') {
      const name = this.flowValueToDifyTemplate(authorization.headerName, nodes) || 'X-API-Key';
      return {
        type: 'api-key',
        config: {
          type: 'custom',
          api_key: this.flowValueToDifyTemplate(authorization.apiKey, nodes),
          header: name,
        },
      };
    }
    if (authorization.type === 'basic') {
      const username = this.flowValueToDifyTemplate(authorization.username, nodes);
      const password = this.flowValueToDifyTemplate(authorization.password, nodes);
      if (username.includes('{{#') || password.includes('{{#')) {
        throw new BadRequestException('Basic 认证暂不支持变量用户名或密码，请改用请求头认证');
      }
      return {
        type: 'api-key',
        config: {
          type: 'basic',
          api_key: Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
          header: 'Authorization',
        },
      };
    }
    return { type: 'no-auth' };
  }

  private compileFlowValueExpression(
    input: FlowInputValue | undefined,
    variables: Array<{ variable: string; value_selector: string[] }>,
    hint: string,
    nodes: FlowNodeJSON[],
  ): string {
    if (!input) return `''`;
    if (input.type === 'ref' && Array.isArray(input.content)) {
      return this.addCodeVariable(input.content.map(String), variables, hint, nodes);
    }
    if (input.type === 'constant' || typeof input.content !== 'string') {
      return JSON.stringify(input.content ?? '');
    }

    const source = input.content;
    const matcher = /\{\{#?([^{}#]+)#?\}\}/g;
    const expressions: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(source))) {
      if (match.index > cursor) expressions.push(JSON.stringify(source.slice(cursor, match.index)));
      const selector = match[1].trim().split('.').filter(Boolean);
      if (selector.length >= 2) {
        // 对象/数组（例如知识检索结果）用 JSON 呈现，避免模板里出现 [object Object]
        expressions.push(
          `((value) => (value === null || value === undefined`
          + ` ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)))(${this.addCodeVariable(selector, variables, hint, nodes)})`,
        );
      } else {
        expressions.push(JSON.stringify(match[0]));
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) expressions.push(JSON.stringify(source.slice(cursor)));
    return expressions.length ? expressions.join(' + ') : JSON.stringify(source);
  }

  private addCodeVariable(
    selector: string[],
    variables: Array<{ variable: string; value_selector: string[] }>,
    hint: string,
    nodes: FlowNodeJSON[],
  ): string {
    const safeHint = hint.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) || 'value';
    const variable = `__ff_${safeHint}_${variables.length}`;
    variables.push({ variable, value_selector: this.normalizeDifySelector(selector, nodes) });
    return `args[${JSON.stringify(variable)}]`;
  }

  /** 将 FlowGram 输出名按源节点类型转换为 Dify 的实际变量名。 */
  private normalizeDifySelector(
    selector: string[],
    nodes: FlowNodeJSON[],
  ): string[] {
    const normalized = selector.map(String);
    if (normalized[0] === 'global') {
      throw new BadRequestException(
        'Dify 发布暂不支持 global 全局变量引用；请改为引用开始节点输入',
      );
    }
    if (normalized.length < 2) return normalized;

    const sourceNode = nodes.find((node) => node.id === normalized[0]);
    if (sourceNode?.type === 'llm' && normalized[1] === 'result') {
      normalized[1] = 'text';
    } else if (sourceNode?.type === 'http' && normalized[1] === 'statusCode') {
      normalized[1] = 'status_code';
    } else if (
      sourceNode?.type === 'loop'
      && this.getNodeOutputNames(sourceNode).includes(normalized[1])
    ) {
      normalized[1] = 'output';
    }
    return normalized;
  }

  /**
   * Array selectors are native structured data in Dify and accept arbitrary
   * string segments.  Only selectors serialized into {{#node.property#}}
   * templates are subject to the workflow template parser's 50/30/10 limits.
   */
  private normalizeDifyTemplateSelector(
    selector: string[],
    nodes: FlowNodeJSON[],
  ): string[] {
    const normalized = this.normalizeDifySelector(selector, nodes);
    this.assertDifySelector(normalized);
    return normalized;
  }

  private assertDifyNodeId(nodeId: string): void {
    if (typeof nodeId === 'string' && DIFY_NODE_ID.test(nodeId)) return;
    throw new BadRequestException(
      `节点 ${nodeId} 的内部标识映射失败：Dify 模板节点标识只能使用 1-50 位英文字母、数字或下划线。`,
    );
  }

  private assertDifySelectorProperty(property: string, label: string): void {
    if (DIFY_SELECTOR_PROPERTY.test(property)) return;
    throw new BadRequestException(
      `${label} 的变量名不兼容 Dify：必须以英文字母或下划线开头，且只能包含英文字母、数字或下划线（最多 30 位）。`,
    );
  }

  private assertDifySelector(selector: string[]): void {
    this.assertDifyNodeId(selector[0]);
    const properties = selector.slice(1);
    if (properties.length > DIFY_MAX_SELECTOR_PROPERTY_SEGMENTS) {
      throw new BadRequestException(
        `变量引用 ${selector.join('.')} 的属性层级超过 Dify 支持的 ${DIFY_MAX_SELECTOR_PROPERTY_SEGMENTS} 层。`,
      );
    }
    for (const property of properties) {
      this.assertDifySelectorProperty(property, `变量引用 ${selector.join('.')}`);
    }
  }

  private contentNodeTitle(type: string): string {
    if (type === 'text') return '文本处理';
    if (type === 'image') return '图片处理';
    if (type === 'video') return '视频处理';
    return '内容处理';
  }

  private defaultOutputKey(type: string): string {
    if (type === 'llm' || type === 'text') return 'text';
    if (type === 'http') return 'body';
    if (type === 'image' || type === 'video') return 'url';
    if (type === 'loop') return 'output';
    return 'result';
  }

  /** 子工作流节点的画布层校验；快照存在性与环检测由发布服务负责。 */
  private validateSubworkflowNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): void {
    const targetWorkflowId = String(node.data.targetWorkflowId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetWorkflowId)) {
      throw new BadRequestException(`子工作流节点 ${node.id} 尚未选择目标工作流`);
    }
    if (targetWorkflowId === node.id || nodes.some((candidate) => candidate.id === targetWorkflowId)) {
      throw new BadRequestException(`子工作流节点 ${node.id} 不能引用自身所在画布中的节点`);
    }
    const mappings = (node.data.inputMappings || {}) as Record<string, unknown>;
    for (const [name, mapping] of Object.entries(mappings)) {
      const value = mapping as FlowInputValue | undefined;
      if (!value || value.type !== 'ref' || !Array.isArray(value.content) || value.content.length < 2) {
        throw new BadRequestException(
          `子工作流节点 ${node.id} 的入参 ${name} 必须引用一个上游变量`,
        );
      }
      const referenced = this.normalizeDifySelector(value.content.map(String), nodes);
      const referencedNode = nodes.find((candidate) => candidate.id === referenced[0]);
      if (!referencedNode || referencedNode.id === node.id) {
        throw new BadRequestException(
          `子工作流节点 ${node.id} 的入参 ${name} 引用了不存在或无效的节点`,
        );
      }
    }
  }

  /** 知识检索节点：查询引用必须显式选择，数据集使用平台受控 Dify 数据集 UUID。 */
  private validateKnowledgeNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): void {
    const datasetId = String(node.data.datasetId || '').trim();
    if (!datasetId) {
      throw new BadRequestException(`知识检索节点 ${node.id} 尚未选择知识库`);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(datasetId)) {
      throw new BadRequestException(`知识检索节点 ${node.id} 的知识库 ID 格式无效`);
    }
    const queryValue = node.data.queryValue as FlowInputValue | undefined;
    if (!queryValue || queryValue.type !== 'ref' || !Array.isArray(queryValue.content) || queryValue.content.length < 2) {
      throw new BadRequestException(`知识检索节点 ${node.id} 必须引用一个上游变量作为检索语句`);
    }
    const selector = this.normalizeDifySelector(queryValue.content.map(String), nodes);
    const referencedNode = nodes.find((candidate) => candidate.id === selector[0]);
    if (!referencedNode || referencedNode.id === node.id) {
      throw new BadRequestException(`知识检索节点 ${node.id} 的检索语句引用了不存在或无效的节点`);
    }
    const topK = Number(node.data.topK ?? 4);
    if (!Number.isInteger(topK) || topK < 1 || topK > 10) {
      throw new BadRequestException(`知识检索节点 ${node.id} 的返回数量必须是 1 到 10 之间的整数`);
    }
  }

  /** 知识检索节点编译为 Dify knowledge-retrieval 节点；结果输出为 result 数组。 */
  private convertKnowledgeNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    const datasetId = String(node.data.datasetId || '').trim();
    const queryValue = node.data.queryValue as FlowInputValue | undefined;
    const querySelector = this.normalizeDifySelector(
      (queryValue?.content as unknown[]).map(String),
      nodes,
    );
    const topK = Number(node.data.topK ?? 4);

    return {
      type: 'knowledge-retrieval',
      title: node.data.title || '知识检索',
      desc: '',
      selected: false,
      dataset_ids: [datasetId],
      query_variable_selector: querySelector,
      // multiple（多路）模式在 economy 关键索引下直接取 top_k，不依赖
      // 任何 LLM；single 模式必须配置路由模型，免模型部署会立即失败。
      retrieval_mode: 'multiple',
      multiple_retrieval_config: {
        top_k: topK,
        score_threshold: null,
        reranking_enable: false,
      },
    };
  }

  /** 将 FlowGram JSON Schema 完整转换为 Dify Code 节点输出 schema。 */
  private toDifyCodeOutputSchema(schema: any): {
    type: string;
    children: Record<string, any> | null;
  } {
    const rawType = String(schema?.type || 'string').toLowerCase();
    if (rawType === 'object') {
      const properties = schema?.properties && typeof schema.properties === 'object'
        ? schema.properties as Record<string, any>
        : {};
      const children = Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          this.toDifyCodeOutputSchema(child),
        ]),
      );
      return {
        type: 'object',
        children: Object.keys(children).length > 0 ? children : null,
      };
    }

    if (rawType === 'array') {
      const itemSchema = schema?.items || {};
      const itemType = String(itemSchema.type || 'string').toLowerCase();
      if (itemType === 'object') {
        const objectSchema = this.toDifyCodeOutputSchema(itemSchema);
        return { type: 'array[object]', children: objectSchema.children };
      }
      if (itemType === 'number' || itemType === 'integer') {
        return { type: 'array[number]', children: null };
      }
      if (itemType === 'boolean') {
        // Dify 0.15.3 的 CodeNodeData 不接受 array[boolean]，但会按
        // array[number] 将 JSON boolean 稳定归一为 1/0。
        return { type: 'array[number]', children: null };
      }
      return { type: 'array[string]', children: null };
    }

    const aliases: Record<string, string> = {
      'array[string]': 'array[string]',
      'string[]': 'array[string]',
      'array[number]': 'array[number]',
      'number[]': 'array[number]',
      'array[boolean]': 'array[number]',
      'boolean[]': 'array[number]',
      'array[object]': 'array[object]',
      'object[]': 'array[object]',
      // Dify 0.15.3 的代码节点输出 schema 没有 boolean；声明为 number
      // 时 Sandbox 会把 true/false 归一为 1/0，避免 DSL 在运行前被拒绝。
      boolean: 'number',
      integer: 'number',
      number: 'number',
      string: 'string',
    };
    return { type: aliases[rawType] || 'string', children: null };
  }

  /** Translate FlowGram condition ports to Dify if-else case handles. */
  private convertConditionNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]): any {
    return {
      type: 'if-else',
      title: node.data.title || '条件分支',
      desc: '',
      selected: false,
      cases: this.getConditionCases(node).map((entry) => ({
        case_id: entry.key,
        logical_operator: entry.logic,
        conditions: entry.conditions.map((condition) => this.convertConditionAtom(condition.value, nodes)),
      })),
    };
  }

  private validateConditionNode(node: FlowNodeJSON, nodes: FlowNodeJSON[]) {
    const cases = this.getConditionCases(node);
    if (cases.length === 0) {
      throw new BadRequestException(`条件节点 ${node.id} 至少需要一个分支`);
    }
    const caseKeys = new Set<string>();
    for (const entry of cases) {
      if (
        typeof entry.key !== 'string'
        || !entry.key.trim()
        || !Array.isArray(entry.conditions)
        || entry.conditions.length === 0
      ) {
        throw new BadRequestException(`条件节点 ${node.id} 包含无效分支`);
      }
      const normalizedKey = entry.key.trim().toLowerCase();
      if (normalizedKey === 'else' || normalizedKey === 'false') {
        throw new BadRequestException(
          `条件节点 ${node.id} 的分支不能使用保留端口 ${normalizedKey}`,
        );
      }
      if (caseKeys.has(entry.key)) {
        throw new BadRequestException(`条件节点 ${node.id} 包含重复的分支 key: ${entry.key}`);
      }
      caseKeys.add(entry.key);
      for (const condition of entry.conditions) {
        this.convertConditionAtom(condition?.value, nodes);
      }
    }
  }

  private getConditionCases(node: FlowNodeJSON): Array<{
    key: string;
    logic: 'and' | 'or';
    conditions: NonNullable<FlowNodeJSON['data']['conditions']>;
  }> {
    // Older multi-condition canvases were serialized as type=condition with
    // data.branch. Keep those saved drafts executable during the UI fix.
    if (Array.isArray(node.data.branch) && node.data.branch.length > 0) {
      return node.data.branch.map((branch, index) => ({
        key: branch?.key || `branch.${index}`,
        logic: branch?.logic === 'or' ? 'or' : 'and',
        conditions: Array.isArray(branch?.conditions) ? branch.conditions : [],
      }));
    }
    const conditions = Array.isArray(node.data.conditions) ? node.data.conditions : [];
    return conditions.map((condition) => ({
      key: condition.key,
      logic: 'and',
      conditions: [condition],
    }));
  }

  private convertConditionAtom(value: any, nodes: FlowNodeJSON[]) {
    const left = value?.left;
    const right = value?.right;
    const flowSelector = this.refSelector(left);
    const selector = this.normalizeDifySelector(flowSelector, nodes);
    const flowOperator = String(value?.operator || '').trim().toLowerCase();
    // Resolve the FlowGram output schema before aliases such as
    // loop.<name> -> loop.output or http.statusCode -> http.status_code are
    // applied for Dify. Otherwise the alias can hide the declared type and
    // weaken the operator gate to the string fallback.
    const selectorSchema = this.resolveSelectorSchema(flowSelector, nodes);
    const comparisonOperator = this.normalizeComparisonOperator(
      flowOperator,
      selectorSchema?.type,
    );
    this.validateConditionOperator(
      selector,
      selectorSchema,
      flowOperator,
      comparisonOperator,
    );
    const result: Record<string, any> = {
      variable_selector: selector,
      comparison_operator: comparisonOperator,
    };
    if (flowOperator === 'is_true' || flowOperator === 'is_false') {
      // Dify 0.15.3 没有布尔工作流变量；代码节点的 boolean 输出会被
      // futureFlow 归一为 number，因此条件也必须用 number 的 1/0 契约。
      result.value = flowOperator === 'is_true' ? '1' : '0';
    } else if (!['empty', 'not empty', 'null', 'not null'].includes(comparisonOperator)) {
      if (!right || right.type !== 'constant') {
        throw new BadRequestException('条件右值当前仅支持常量');
      }
      result.value = this.toDifyConditionValue(
        right.content,
        comparisonOperator,
        selectorSchema,
        right.schema,
      );
    }
    return result;
  }

  /** Dify 0.15.3 的 Condition.value 只接受 str 或 list[str]。 */
  private toDifyConditionValue(
    value: any,
    operator: string,
    selectorSchema: any,
    valueSchema?: any,
  ) {
    const schemaType = String(selectorSchema?.type || 'string').toLowerCase();
    const itemType = schemaType === 'array'
      ? String(selectorSchema?.items?.type || 'string').toLowerCase()
      : schemaType;
    const stringify = (item: any): string => {
      if (item === undefined || item === null) {
        throw new BadRequestException('条件常量不能是 undefined 或 null');
      }
      if (typeof item === 'object') {
        throw new BadRequestException('条件常量仅支持字符串、数字、布尔值或其数组');
      }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new BadRequestException('条件数字常量必须是有限值');
      }
      if (itemType === 'boolean' && typeof item === 'boolean') return item ? '1' : '0';
      return String(item);
    };

    if (value === undefined || value === null) {
      throw new BadRequestException('条件常量不能是 undefined 或 null');
    }
    if (
      typeof value === 'string'
      && (operator === 'in' || operator === 'not in'
        || String(valueSchema?.type || '').toLowerCase() === 'array')
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new BadRequestException('数组条件常量必须是合法的 JSON 数组');
      }
    }
    if (operator === 'in' || operator === 'not in') {
      if (!Array.isArray(value)) {
        throw new BadRequestException(`${operator} 条件的右值必须是数组常量`);
      }
      return value.map(stringify);
    }
    if (Array.isArray(value)) {
      throw new BadRequestException(`${operator} 条件的右值必须是标量常量`);
    }
    if (['number', 'integer'].includes(schemaType)) {
      if (typeof value === 'boolean') {
        throw new BadRequestException('数字条件的右值不能使用布尔值');
      }
      const numeric = typeof value === 'string' && value.trim() === ''
        ? Number.NaN
        : Number(value);
      if (!Number.isFinite(numeric)) {
        throw new BadRequestException('数字条件的右值必须是有限数字');
      }
      if (schemaType === 'integer' && !Number.isInteger(numeric)) {
        throw new BadRequestException('整数条件的右值不能包含小数');
      }
      return String(numeric);
    }
    if (schemaType === 'boolean') {
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (value === 1 || value === '1') return '1';
      if (value === 0 || value === '0') return '0';
      throw new BadRequestException('布尔条件的右值只能是 true/false 或 1/0');
    }
    return stringify(value);
  }

  private validateConditionOperator(
    selector: string[],
    selectorSchema: any,
    flowOperator: string,
    comparisonOperator: string,
  ) {
    const schemaType = String(selectorSchema?.type || 'string').toLowerCase();
    if (
      (flowOperator === 'is_true' || flowOperator === 'is_false')
      && schemaType !== 'boolean'
    ) {
      throw new BadRequestException(
        `条件变量 ${selector.join('.')} 不是布尔值，不能使用“为真/为假”判断`,
      );
    }

    const allowedByType: Record<string, Set<string>> = {
      string: new Set([
        'is',
        'is not',
        'contains',
        'not contains',
        'in',
        'not in',
        'null',
        'not null',
      ]),
      number: new Set(['=', '≠', '>', '<', '≥', '≤', 'null', 'not null']),
      integer: new Set(['=', '≠', '>', '<', '≥', '≤', 'null', 'not null']),
      boolean: new Set(['=', '≠', 'null', 'not null']),
      array: new Set(['contains', 'not contains', 'null', 'not null']),
      object: new Set(['null', 'not null']),
      map: new Set(['null', 'not null']),
      'date-time': new Set(['null', 'not null']),
      null: new Set(['null', 'not null']),
    };
    const allowed = allowedByType[schemaType];
    if (!allowed || !allowed.has(comparisonOperator)) {
      throw new BadRequestException(
        `条件变量 ${selector.join('.')} 的 ${schemaType} 类型不支持 ${flowOperator} 比较`,
      );
    }
    if (
      schemaType === 'array'
      && ['contains', 'not contains'].includes(comparisonOperator)
      && String(selectorSchema?.items?.type || '').toLowerCase() !== 'string'
    ) {
      throw new BadRequestException(
        `条件变量 ${selector.join('.')} 当前仅支持字符串数组条件`,
      );
    }
  }

  private refSelector(value: any): string[] {
    if (!value || value.type !== 'ref' || !value.content) {
      throw new BadRequestException('条件左值必须引用已定义的工作流变量');
    }
    const selector = Array.isArray(value.content)
      ? value.content.map(String)
      : String(value.content).split('.');
    if (selector.length < 2 || selector.some((item) => !item)) {
      throw new BadRequestException('条件变量引用格式无效');
    }
    return selector;
  }

  private normalizeComparisonOperator(value: unknown, selectorType: unknown = 'string'): string {
    const normalized = String(value || '').trim().toLowerCase();
    const isNumber = ['number', 'integer', 'boolean'].includes(
      String(selectorType || 'string').toLowerCase(),
    );
    const aliases: Record<string, string> = {
      '=': 'is',
      '==': 'is',
      '===': 'is',
      eq: 'is',
      equal: 'is',
      equals: 'is',
      '!=': 'is not',
      '!==': 'is not',
      '≠': 'is not',
      neq: 'is not',
      'is not': 'is not',
      gt: '>',
      lt: '<',
      gte: '≥',
      lte: '≤',
      in: 'in',
      nin: 'not in',
      contains: 'contains',
      not_contains: 'not contains',
      'not contains': 'not contains',
      '>': '>',
      '<': '<',
      '>=': '≥',
      '≥': '≥',
      '<=': '≤',
      '≤': '≤',
      empty: 'null',
      is_empty: 'null',
      'is empty': 'null',
      null: 'null',
      is_not_empty: 'not null',
      'not empty': 'not null',
      'is not empty': 'not null',
      'not null': 'not null',
      is_true: 'is',
      is_false: 'is',
    };
    if (normalized === 'is_true' || normalized === 'is_false') return '=';
    const operator = normalized === 'is' ? 'is' : aliases[normalized];
    if (!operator) throw new BadRequestException(`不支持的条件比较符: ${String(value)}`);
    if (isNumber && operator === 'is') return '=';
    if (isNumber && operator === 'is not') return '≠';
    return operator;
  }

  /** 转换边 */
  private convertEdge(
    edge: FlowGramJSON['edges'][0],
    nodes: FlowNodeJSON[],
  ): DifyEdge {
    const sourceNode = nodes.find((n) => n.id === edge.sourceNodeID);
    const targetNode = nodes.find((n) => n.id === edge.targetNodeID);

    const sourcePort = edge.sourcePortID || 'source';
    const targetPort = edge.targetPortID || 'target';

    return {
      id: [edge.sourceNodeID, sourcePort, edge.targetNodeID, targetPort]
        .map((part) => encodeURIComponent(part))
        .join('-'),
      source: edge.sourceNodeID,
      sourceHandle:
        sourcePort === 'onError'
          ? 'fail-branch'
          : sourceNode?.type === 'condition' || sourceNode?.type === 'multi-condition'
            ? edge.sourcePortID === 'else'
              ? 'false'
              : edge.sourcePortID || 'false'
            : 'source',
      target: edge.targetNodeID,
      targetHandle: 'target',
      type: 'custom',
      zIndex: 0,
      data: {
        isInIteration: false,
        sourceType: this.toDifyNodeType(sourceNode?.type),
        targetType: this.toDifyNodeType(targetNode?.type),
      },
    };
  }

  /** 自动 End 暴露末节点声明的全部输出，避免多输出代码节点被误写为 result。 */
  private resolveAutoEndOutputs(
    sourceNode: FlowNodeJSON,
    nodes: FlowNodeJSON[],
  ): Array<{ variable: string; value_selector: string[] }> {
    const declaredOutputs = this.getNodeOutputNames(sourceNode);
    const outputNames = declaredOutputs.length > 0 ? declaredOutputs : ['result'];
    return outputNames.map((variable) => ({
      variable,
      value_selector: declaredOutputs.length > 0
        ? this.normalizeDifySelector([sourceNode.id, variable], nodes)
        : [sourceNode.id, this.defaultOutputKey(sourceNode.type)],
    }));
  }

  /** 创建 End 节点(自动补充) */
  private createEndNode(
    id: string,
    x: number,
    y: number,
    outputs: Array<{ variable: string; value_selector: string[] }>,
  ): DifyNode {
    return {
      id,
      type: 'custom',
      position: { x, y },
      positionAbsolute: { x, y },
      sourcePosition: 'right',
      targetPosition: 'left',
      width: 244,
      height: 90,
      data: {
        type: 'end',
        title: '结束',
        desc: '',
        selected: false,
        outputs,
      },
    };
  }

  /** 创建边(自动补充) */
  private createEdge(
    source: string,
    target: string,
    sourceType: string,
    targetType: string,
  ): DifyEdge {
    return {
      id: `${source}-source-${target}-target`,
      source,
      sourceHandle: 'source',
      target,
      targetHandle: 'target',
      type: 'custom',
      zIndex: 0,
      data: {
        isInIteration: false,
        sourceType: this.toDifyNodeType(sourceType),
        targetType: this.toDifyNodeType(targetType),
      },
    };
  }

  private toDifyNodeType(type?: string): string {
    if (type === 'http') return 'http-request';
    if (type === 'condition' || type === 'multi-condition') return 'if-else';
    if (type === 'loop') return 'iteration';
    if (type === 'knowledge') return 'knowledge-retrieval';
    if (type === 'text' || type === 'image' || type === 'video' || type === 'variable') return 'code';
    return type || 'custom';
  }

  /** 从 FlowInputValue 中提取值 */
  private getInputValue(
    input: FlowInputValue | undefined,
    defaultValue: any,
  ): any {
    if (!input) return defaultValue;
    return input.content !== undefined ? input.content : defaultValue;
  }

  /** 根据模型名推断 Dify provider */
  private inferProvider(modelName: string): string {
    // 精确匹配
    if (this.MODEL_PROVIDER_MAP[modelName]) {
      return this.MODEL_PROVIDER_MAP[modelName];
    }
    // 前缀匹配
    if (modelName.startsWith('gpt')) return 'openai';
    if (modelName.startsWith('claude')) return 'anthropic';
    if (modelName.startsWith('deepseek')) return 'deepseek';
    if (modelName.startsWith('gemini')) return 'google';
    if (modelName.startsWith('qwen')) return 'tongyi';
    // 其余模型（如 glm / 私有网关模型）走 OpenAI-API-compatible 供应商，
    // 它支持自定义 base_url 与任意模型名，与网关直连代理一致。
    return (this.configuredModelName() || this.configuredApiHost())
      ? 'openai_api_compatible'
      : 'openai';
  }

  /**
   * 将 FlowGram 变量引用语法转为 Dify 格式
   * FlowGram: {{nodeId.variable}}  或  {{nodeId.variable.subfield}}
   * Dify:     {{#nodeId.variable#}} 或 {{#nodeId.variable.subfield#}}
   */
  private convertVariableRefs(
    text: string,
    nodes: FlowNodeJSON[],
    enforceTemplateContract = true,
  ): string {
    if (!text) return text;
    // 同时接受 FlowGram {{node.output}} 与已包装的 {{#node.output#}}。
    return text.replace(/\{\{#?([^{}#]+)#?\}\}/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      const selector = enforceTemplateContract
        ? this.normalizeDifyTemplateSelector(trimmed.split('.'), nodes)
        : this.normalizeDifySelector(trimmed.split('.'), nodes);
      return `{{#${selector.join('.')}#}}`;
    });
  }

  /**
   * 从 FlowGram JSON 中提取工作流输入变量
   * 用于调用 Dify /v1/workflows/run 时填充 inputs
   * 从 Start 节点的 outputs.properties 中提取变量名和默认值
   */
  extractInputs(flowgram: FlowGramJSON): Record<string, any> {
    const startNode = flowgram.nodes.find((n) => n.type === 'start');
    if (!startNode) return {};

    const properties = (startNode.data.outputs?.properties || {}) as Record<
      string,
      any
    >;
    const inputsValues = startNode.data.inputsValues || {};
    const inputs: Record<string, any> = {};

    for (const key of Object.keys(properties)) {
      const schemaType = String(properties[key]?.type || 'string').toLowerCase();
      if (schemaType === 'boolean') {
        throw new BadRequestException(
          `开始节点输入 ${key} 使用了布尔值；当前 Dify 0.15.3 没有布尔输入类型，请改用整数 1/0 或字符串`,
        );
      }
      // 优先使用 inputsValues 中的值,否则用 schema default
      const val = inputsValues[key];
      if (val && val.content !== undefined) {
        inputs[key] = val.content;
      } else if (properties[key].default !== undefined) {
        inputs[key] = properties[key].default;
      } else {
        // 根据类型给默认值
        inputs[key] = ['number', 'integer'].includes(schemaType) ? 0 : '';
      }
    }
    return inputs;
  }

  /**
   * 预估工作流费用(元)
   * 基于节点配置粗略估算,实际费用由 Dify 返回的 token 用量决定
   */
  estimateCost(flowgram: FlowGramJSON): number {
    let cost = 0;
    for (const node of flowgram.nodes) {
      if (node.type === 'llm') {
        const modelName = String(
          this.getInputValue(
            node.data.inputsValues?.modelName,
            'gpt-3.5-turbo',
          ),
        );
        // 粗略预估:每次 LLM 调用约 1000 tokens
        const estimatedTokens = 1000;
        cost += this.estimateTokenCost(modelName, estimatedTokens);
      }
    }
    return Math.round(cost * 10000) / 10000; // 保留 4 位小数
  }

  /** 根据模型和 token 数估算费用(元) */
  private estimateTokenCost(modelName: string, tokens: number): number {
    // 简化的定价表(元/1K tokens),实际应从配置读取
    const pricing: Record<string, number> = {
      'gpt-3.5-turbo': 0.005,
      'gpt-4': 0.15,
      'gpt-4o': 0.03,
      'gpt-4o-mini': 0.001,
      'claude-3-sonnet': 0.02,
      'claude-3.5-sonnet': 0.02,
      'deepseek-chat': 0.001,
      'glm-5.3-flash': 0.001,
    };
    const pricePer1K = pricing[modelName] || 0.01;
    return (tokens / 1000) * pricePer1K;
  }
}
