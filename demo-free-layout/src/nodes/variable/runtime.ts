type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  [key: string]: unknown;
};

type FlowValue = {
  type?: string;
  content?: unknown;
  schema?: JsonSchema;
  [key: string]: unknown;
};

type VariableRow = {
  operator?: 'declare' | 'assign' | string;
  left?: string | FlowValue;
  right?: FlowValue;
  [key: string]: unknown;
};

type RuntimeNode = {
  id: string;
  type: string;
  data?: Record<string, any>;
  blocks?: RuntimeNode[];
  [key: string]: unknown;
};

type RuntimeEdge = {
  sourceNodeID: string;
  targetNodeID: string;
  [key: string]: unknown;
};

type AssignmentRecord = {
  nodeID: string;
  target: string[];
  outputName: string;
};

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const cloneJSON = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const assignmentOutputName = (index: number): string => `assigned_${index + 1}`;

const rowOutputName = (row: VariableRow, index: number): string =>
  row.operator === 'declare' ? String(row.left || '') : assignmentOutputName(index);

const inferSchema = (value: unknown): JsonSchema => {
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length > 0 ? inferSchema(value[0]) : { type: 'string' } };
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
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: 'string' };
};

const schemaAtPath = (schema: JsonSchema | undefined, path: string[]): JsonSchema | undefined => {
  let current = schema;
  for (const segment of path) {
    current = current?.type === 'array'
      ? current.items
      : current?.properties?.[segment];
    if (!current) return undefined;
  }
  return current;
};

const nodeOutputNames = (node: RuntimeNode): string[] => {
  const declared = Object.keys(node.data?.outputs?.properties || {});
  if (node.type === 'variable') {
    const rows = Array.isArray(node.data?.assign) ? node.data.assign as VariableRow[] : [];
    return [...new Set([...declared, ...rows.map(rowOutputName)])];
  }
  if (declared.length > 0) return declared;
  if (node.type === 'llm') return ['result', 'text'];
  if (node.type === 'http') return ['body', 'statusCode', 'status_code', 'headers'];
  if (node.type === 'text') return ['text'];
  if (node.type === 'image') return ['url', 'caption', 'mediaType'];
  if (node.type === 'video') return ['url', 'poster', 'caption', 'mediaType'];
  if (node.type === 'code') return ['result'];
  return [];
};

const selectorSchema = (
  selector: string[],
  nodes: RuntimeNode[],
  seen = new Set<string>(),
): JsonSchema | undefined => {
  if (selector.length < 2) return undefined;
  const source = nodes.find((node) => node.id === selector[0]);
  if (!source) return undefined;
  const seenKey = `${selector[0]}\u0000${selector[1]}`;
  if (seen.has(seenKey)) return undefined;
  const nextSeen = new Set(seen).add(seenKey);
  let output = source.data?.outputs?.properties?.[selector[1]] as JsonSchema | undefined;
  if (!output && source.type === 'variable') {
    const rows = Array.isArray(source.data?.assign) ? source.data.assign as VariableRow[] : [];
    const row = rows.find((candidate, index) => rowOutputName(candidate, index) === selector[1]);
    if (row?.right) output = valueSchema(row.right, nodes, undefined, nextSeen);
  }
  return schemaAtPath(output, selector.slice(2));
};

const valueSchema = (
  value: FlowValue,
  nodes: RuntimeNode[],
  fallback?: JsonSchema,
  seen = new Set<string>(),
): JsonSchema => {
  if (value.schema?.type) return value.schema;
  if (value.type === 'ref' && Array.isArray(value.content)) {
    return selectorSchema(value.content.map(String), nodes, seen) || fallback || { type: 'string' };
  }
  if (value.type === 'template' || value.type === 'expression') return { type: 'string' };
  if (value.type === 'constant') return fallback || inferSchema(value.content);
  return fallback || { type: 'string' };
};

/**
 * runtime-js 1.0.12 没有变量节点执行器。这里把变量节点编译为它原生支持的
 * JavaScript 代码节点；已有变量的赋值使用确定性的内部输出，并将后续引用
 * 改写到该输出。只有赋值节点支配使用节点时才能静态改写，避免条件分支上
 * 生成一个在部分路径中不存在的值。
 */
export const prepareVariableNodesForRuntime = <T extends object>(schema: T): T => {
  const runtimeSchema = schema as T & {
    nodes?: RuntimeNode[];
    edges?: RuntimeEdge[];
  };
  if (
    !Array.isArray(runtimeSchema.nodes)
    || !runtimeSchema.nodes.some((node) => node.type === 'variable')
  ) {
    return schema;
  }

  const prepared = cloneJSON(runtimeSchema);
  const nodes = prepared.nodes || [];
  const edges = prepared.edges || [];
  const startNode = nodes.find((node) => node.type === 'start');
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.sourceNodeID)?.push(edge.targetNodeID);

  const reachability = new Map<string, boolean>();
  const isReachable = (source: string, target: string, skipped?: string): boolean => {
    if (source === skipped || target === skipped) return false;
    const cacheKey = skipped ? `${source}\u0000${target}\u0000${skipped}` : `${source}\u0000${target}`;
    const cached = reachability.get(cacheKey);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([source]);
    const pending = [source];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const next of adjacency.get(current) || []) {
        if (next === skipped || seen.has(next)) continue;
        if (next === target) {
          reachability.set(cacheKey, true);
          return true;
        }
        seen.add(next);
        pending.push(next);
      }
    }
    reachability.set(cacheKey, false);
    return false;
  };

  const dominates = (dominator: string, consumer: string): boolean => {
    if (!startNode) return false;
    return !isReachable(startNode.id, consumer, dominator);
  };

  const validateSelector = (selector: string[], consumer: string, label: string) => {
    if (selector.length < 2 || selector.some((part) => !part)) {
      throw new Error(`${label}引用格式无效`);
    }
    if (selector[0] === 'global') {
      throw new Error(`${label}暂不支持 global 全局变量`);
    }
    const source = nodes.find((candidate) => candidate.id === selector[0]);
    if (!source || source.type === 'end') {
      throw new Error(`${label}引用了不存在或无效的节点`);
    }
    if (!nodeOutputNames(source).includes(selector[1])) {
      throw new Error(`${label}${selector.slice(0, 2).join('.')} 不存在`);
    }
    if (!isReachable(source.id, consumer) || !dominates(source.id, consumer)) {
      throw new Error(`${label}${selector.slice(0, 2).join('.')} 必须来自所有执行路径都会经过的上游节点`);
    }
  };

  const assignments: AssignmentRecord[] = [];
  for (const node of nodes.filter((candidate) => candidate.type === 'variable')) {
    const rows = Array.isArray(node.data?.assign) ? node.data.assign as VariableRow[] : [];
    const assignedTargets = new Set<string>();
    const outputNames = new Set<string>();
    rows.forEach((row, index) => {
      const outputName = rowOutputName(row, index);
      if (row.operator === 'declare') {
        if (!VARIABLE_NAME_PATTERN.test(outputName)) {
          throw new Error(`变量节点 ${node.id} 的变量名“${outputName || '空'}”格式无效`);
        }
      } else if (row.operator === 'assign') {
        const target = (row.left as FlowValue | undefined)?.content;
        if (!Array.isArray(target) || target.length !== 2 || target.some((part) => !String(part))) {
          throw new Error(`变量节点 ${node.id} 的赋值目标必须是一个顶层流程变量`);
        }
        const normalizedTarget = target.map(String);
        validateSelector(normalizedTarget, node.id, `变量节点 ${node.id} 的赋值目标 `);
        const targetKey = normalizedTarget.join('\u0000');
        if (assignedTargets.has(targetKey)) {
          throw new Error(`变量节点 ${node.id} 不能重复修改同一个变量`);
        }
        assignedTargets.add(targetKey);
        assignments.push({ nodeID: node.id, target: normalizedTarget, outputName });
      } else {
        throw new Error(`变量节点 ${node.id} 包含不支持的操作`);
      }
      if (!row.right || !['constant', 'ref', 'template'].includes(String(row.right.type))) {
        throw new Error(`变量节点 ${node.id} 的变量值不能为空或类型不受支持`);
      }
      if (
        row.right.type === 'constant'
        && !Object.prototype.hasOwnProperty.call(row.right, 'content')
      ) {
        throw new Error(`变量节点 ${node.id} 的变量值不能为空`);
      }
      if (row.right.type === 'ref') {
        if (!Array.isArray(row.right.content)) {
          throw new Error(`变量节点 ${node.id} 的变量引用格式无效`);
        }
        validateSelector(
          row.right.content.map(String),
          node.id,
          `变量节点 ${node.id} 的变量值 `,
        );
      }
      if (row.right.type === 'template') {
        const template = row.right.content;
        if (typeof template !== 'string') {
          throw new Error(`变量节点 ${node.id} 的模板值格式无效`);
        }
        for (const match of template.matchAll(/\{\{#?([^{}#]+)#?\}\}/g)) {
          const selector = match[1].trim().split('.').filter(Boolean);
          validateSelector(selector, node.id, `变量节点 ${node.id} 的模板值 `);
        }
      }
      if (outputNames.has(outputName)) throw new Error(`变量节点 ${node.id} 包含重复的输出名`);
      outputNames.add(outputName);
    });
    if (rows.length === 0) throw new Error(`变量节点 ${node.id} 至少需要设置一个变量`);
  }

  const rewriteSelector = (selector: string[], consumer: string): string[] => {
    const candidates = assignments.filter(
      (assignment) =>
        assignment.target.every((part, index) => selector[index] === part) &&
        isReachable(assignment.nodeID, consumer),
    );
    if (candidates.length === 0) return selector;
    const latest = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && isReachable(candidate.nodeID, other.nodeID),
        ),
    );
    if (latest.length !== 1 || !dominates(latest[0].nodeID, consumer)) {
      throw new Error(`变量 ${selector.slice(0, 2).join('.')} 在分支汇合处的赋值不明确`);
    }
    const selected = latest[0];
    return [selected.nodeID, selected.outputName, ...selector.slice(selected.target.length)];
  };

  const rewriteFlowValues = (value: unknown, consumer: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewriteFlowValues(item, consumer));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.type === 'ref' && Array.isArray(record.content)) {
      return { ...record, content: rewriteSelector(record.content.map(String), consumer) };
    }
    if (
      (record.type === 'template' || record.type === 'expression') &&
      typeof record.content === 'string'
    ) {
      return {
        ...record,
        content: record.content.replace(/\{\{#?([^{}#]+)#?\}\}/g, (match, inner: string) => {
          const selector = inner.trim().split('.').filter(Boolean);
          if (selector.length < 2) return match;
          const rewritten = rewriteSelector(selector, consumer);
          return `{{${rewritten.join('.')}}}`;
        }),
      };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, rewriteFlowValues(child, consumer)]),
    );
  };

  for (const node of nodes) {
    const originalData = node.data || {};
    if (node.type !== 'variable') {
      node.data = rewriteFlowValues(originalData, node.id) as Record<string, any>;
      continue;
    }
    const rows = originalData.assign as VariableRow[];
    const rewrittenData = rewriteFlowValues(
      Object.fromEntries(Object.entries(originalData).filter(([key]) => key !== 'assign')),
      node.id,
    ) as Record<string, any>;
    rewrittenData.assign = rows.map((row) => ({
      ...row,
      left: cloneJSON(row.left),
      right: rewriteFlowValues(row.right, node.id),
    }));
    node.data = rewrittenData;
  }

  for (const node of nodes.filter((candidate) => candidate.type === 'variable')) {
    const rows = node.data?.assign as VariableRow[];
    const existingOutputs = (node.data?.outputs?.properties || {}) as Record<string, JsonSchema>;
    const inputsValues: Record<string, FlowValue> = {};
    const inputProperties: Record<string, JsonSchema> = {};
    const outputProperties: Record<string, JsonSchema> = {};
    const returnEntries: string[] = [];

    rows.forEach((row, index) => {
      const inputName = `value_${index + 1}`;
      const outputName = rowOutputName(row, index);
      const target = row.operator === 'assign'
        ? ((row.left as FlowValue).content as string[])
        : undefined;
      const fallback = target ? selectorSchema(target, nodes) : existingOutputs[outputName];
      const schemaForValue = valueSchema(row.right!, nodes, fallback);
      inputsValues[inputName] = row.right!;
      inputProperties[inputName] = schemaForValue;
      outputProperties[outputName] = existingOutputs[outputName] || fallback || schemaForValue;
      returnEntries.push(`${JSON.stringify(outputName)}: params[${JSON.stringify(inputName)}]`);
    });

    node.type = 'code';
    node.data = {
      ...node.data,
      inputsValues,
      inputs: { type: 'object', properties: inputProperties },
      outputs: { type: 'object', properties: outputProperties },
      script: {
        language: 'javascript',
        content: `function main({ params }) {\n  return { ${returnEntries.join(', ')} };\n}`,
      },
    };
  }

  return prepared as T;
};
