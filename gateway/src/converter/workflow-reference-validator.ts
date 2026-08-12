import { BadRequestException } from '@nestjs/common';
import { FlowGramJSON, FlowNodeJSON } from './types';
import { NATIVE_MEDIA_OUTPUTS, isNativeMediaNode } from './native-media-bridge';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

type ReferenceUse = {
  consumerId: string;
  selector: string[];
  location: string;
};

const TEMPLATE_REFERENCE = /\{\{#?([^{}#]+)#?\}\}/g;

const inferSchema = (value: unknown): JsonSchema => {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? inferSchema(value[0]) : { type: 'string' },
    };
  }
  if (value !== null && typeof value === 'object') {
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          inferSchema(child),
        ]),
      ),
    };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  return { type: 'string' };
};

const variableOutputName = (row: any, index: number) =>
  row?.operator === 'declare' ? String(row.left || '') : `assigned_${index + 1}`;

const collectTemplateReferences = (
  content: string,
  consumerId: string,
  location: string,
  result: ReferenceUse[],
) => {
  for (const match of content.matchAll(TEMPLATE_REFERENCE)) {
    const selector = match[1].trim().split('.').map((part) => part.trim());
    if (selector.length < 2 || selector.some((part) => !part)) {
      throw new BadRequestException(
        `节点 ${consumerId} 的模板引用“${match[0]}”格式无效，应使用 {{节点.输出}}`,
      );
    }
    result.push({ consumerId, selector, location });
  }
};

const collectNodeReferences = (node: FlowNodeJSON): ReferenceUse[] => {
  const result: ReferenceUse[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === 'string') {
      collectTemplateReferences(value, node.id, path.join('.'), result);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }

    const record = value as Record<string, any>;
    if (record.type === 'ref') {
      if (!Array.isArray(record.content)) {
        throw new BadRequestException(`节点 ${node.id} 的变量引用格式无效`);
      }
      const selector = record.content.map(String).map((part: string) => part.trim());
      if (selector.length < 2 || selector.some((part: string) => !part)) {
        throw new BadRequestException(`节点 ${node.id} 的变量引用格式无效`);
      }
      result.push({ consumerId: node.id, selector, location: path.join('.') });
      return;
    }
    if (record.type === 'template' || record.type === 'expression') {
      if (typeof record.content !== 'string') {
        throw new BadRequestException(`节点 ${node.id} 的模板引用格式无效`);
      }
      collectTemplateReferences(record.content, node.id, path.join('.'), result);
      return;
    }
    if (record.type === 'constant') {
      // 常量中的花括号是普通文本；只有 template/expression 或旧版裸字符串
      // 会由转换器解释为变量模板。
      return;
    }

    for (const [key, child] of Object.entries(record)) {
      // JSON Schema、用户脚本和循环子画布分别由它们自己的校验器处理。
      if (['inputs', 'outputs', 'script', 'blocks', 'loopOutputs'].includes(key)) continue;
      // 标题和说明即使包含花括号也只是展示文本，不会被转换为 Dify 模板。
      if (['title', 'description', 'desc'].includes(key)) continue;
      visit(child, [...path, key]);
    }
  };

  visit(node.data || {}, ['data']);
  return result;
};

const resolveOutputSchema = (
  node: FlowNodeJSON,
  outputName: string,
  nodes: FlowNodeJSON[],
  seen = new Set<string>(),
): JsonSchema | undefined => {
  const key = `${node.id}\u0000${outputName}`;
  if (seen.has(key)) return undefined;
  const nextSeen = new Set(seen).add(key);
  const declared = (node.data.outputs?.properties as Record<string, JsonSchema> | undefined)?.[
    outputName
  ];
  if (declared) return declared;

  if (node.type === 'llm' && ['result', 'text'].includes(outputName)) {
    return { type: 'string' };
  }
  if (node.type === 'http') {
    if (['statusCode', 'status_code'].includes(outputName)) return { type: 'integer' };
    if (outputName === 'body') return { type: 'string' };
    if (outputName === 'headers') return { type: 'object' };
  }
  if (node.type === 'text' && outputName === 'text') return { type: 'string' };
  if (isNativeMediaNode(node) && outputName in NATIVE_MEDIA_OUTPUTS) {
    return (NATIVE_MEDIA_OUTPUTS as Record<string, JsonSchema>)[outputName];
  }
  if (node.type === 'image' && ['url', 'caption', 'mediaType'].includes(outputName)) {
    return { type: 'string' };
  }
  if (
    node.type === 'video'
    && ['url', 'poster', 'caption', 'mediaType'].includes(outputName)
  ) {
    return { type: 'string' };
  }
  if (node.type === 'code' && outputName === 'result') return { type: 'string' };

  if (node.type === 'variable') {
    const rows = Array.isArray(node.data.assign) ? node.data.assign : [];
    const row = rows.find(
      (candidate: any, index: number) => variableOutputName(candidate, index) === outputName,
    );
    if (!row) return undefined;
    if (row.right?.schema?.type) return row.right.schema;
    if (row.right?.type === 'constant') return inferSchema(row.right.content);
    if (row.right?.type === 'template' || row.right?.type === 'expression') {
      return { type: 'string' };
    }
    const sourceSelector = row.operator === 'assign' ? row.left?.content : row.right?.content;
    if (Array.isArray(sourceSelector) && sourceSelector.length >= 2) {
      const source = nodes.find((candidate) => candidate.id === String(sourceSelector[0]));
      if (source) {
        return resolveOutputSchema(source, String(sourceSelector[1]), nodes, nextSeen);
      }
    }
  }

  if (node.type === 'loop') {
    const loopOutput = (node.data.loopOutputs || {})[outputName] as any;
    if (!loopOutput || !Array.isArray(loopOutput.content)) return undefined;
    const code = node.blocks?.find((block) => block.id === String(loopOutput.content[0]));
    const scalar = code
      ? (code.data.outputs?.properties as Record<string, JsonSchema> | undefined)?.[
          String(loopOutput.content[1])
        ]
      : undefined;
    return scalar ? { type: 'array', items: scalar } : undefined;
  }

  return undefined;
};

const assertNestedSchemaPath = (
  schema: JsonSchema,
  selector: string[],
  consumerId: string,
) => {
  let current: JsonSchema | undefined = schema;
  for (const segment of selector.slice(2)) {
    if (!current) break;
    if (current.type === 'array' || String(current.type).startsWith('array[')) {
      throw new BadRequestException(
        `节点 ${consumerId} 的引用 ${selector.join('.')} 不能直接读取数组元素字段`,
      );
    }
    if (current.type !== 'object' || !current.properties) {
      current = undefined;
      break;
    }
    current = current.properties[segment];
  }
  if (!current) {
    throw new BadRequestException(
      `节点 ${consumerId} 引用了不存在的输出路径 ${selector.join('.')}`,
    );
  }
};

/**
 * 在任何选择器被写入 Dify DSL 前统一验证引用完整性和控制流支配关系。
 * 这阻止 ghost 节点、ghost 输出、逆向引用以及分支汇合处的不确定值进入线上版本。
 */
export function validateWorkflowReferences(flowgram: FlowGramJSON): void {
  const nodesById = new Map(flowgram.nodes.map((node) => [node.id, node]));
  const adjacency = new Map(flowgram.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of flowgram.edges) {
    adjacency.get(edge.sourceNodeID)?.push(edge.targetNodeID);
  }
  const start = flowgram.nodes.find((node) => node.type === 'start');
  if (!start) return;

  const reachabilityCache = new Map<string, boolean>();
  const isReachable = (source: string, target: string, skipped?: string): boolean => {
    if (source === skipped || target === skipped || source === target) return false;
    const cacheKey = `${source}\u0000${target}\u0000${skipped || ''}`;
    const cached = reachabilityCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([source]);
    const pending = [source];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const next of adjacency.get(current) || []) {
        if (next === skipped || seen.has(next)) continue;
        if (next === target) {
          reachabilityCache.set(cacheKey, true);
          return true;
        }
        seen.add(next);
        pending.push(next);
      }
    }
    reachabilityCache.set(cacheKey, false);
    return false;
  };
  const dominates = (source: string, consumer: string) =>
    !isReachable(start.id, consumer, source);

  const uses = flowgram.nodes.flatMap(collectNodeReferences);
  for (const use of uses) {
    const [sourceId, outputName] = use.selector;
    if (sourceId === 'global') {
      throw new BadRequestException(
        `节点 ${use.consumerId} 的 Dify 发布暂不支持 global 全局变量引用，请改用开始节点输入`,
      );
    }
    const source = nodesById.get(sourceId);
    if (!source || source.type === 'end') {
      throw new BadRequestException(
        `节点 ${use.consumerId} 引用了不存在或无效的节点 ${sourceId}`,
      );
    }
    const schema = resolveOutputSchema(source, outputName, flowgram.nodes);
    if (!schema) {
      throw new BadRequestException(
        `节点 ${use.consumerId} 引用了节点 ${sourceId} 不存在的输出 ${outputName}`,
      );
    }
    if (use.selector.length > 2) {
      assertNestedSchemaPath(schema, use.selector, use.consumerId);
    }
    if (!isReachable(sourceId, use.consumerId) || !dominates(sourceId, use.consumerId)) {
      throw new BadRequestException(
        `节点 ${use.consumerId} 的引用 ${use.selector.join('.')} 必须来自所有执行路径都会经过的上游节点`,
      );
    }
  }
}
