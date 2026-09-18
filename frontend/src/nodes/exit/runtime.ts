/**
 * 退出节点的本地试运行归一化。
 *
 * 浏览器本地运行时（runtime-js）没有「退出节点」，而且有两个硬约束：
 *   1. 一个工作流只能有一个 `end` 节点；
 *   2. 没有任何 `end` 节点被执行时，整次运行判为失败。
 *
 * 所以这里按退出范围翻译成它能执行的形态（都保留原节点 id，下游引用不用改）：
 *
 *   - 跳出当前循环 → `break` 节点：循环执行器在每轮结束后检查 break 标记，命中就停止迭代；
 *   - 退出整个工作流 → 等价的同步代码节点（把退出时声明的输出算出来），
 *     并把它的产出接到「结束」节点上，保证退出分支被选中时运行仍然成功、结果里能看到
 *     退出时返回的值（云端发布时该节点直接转换成 Dify 的 end 节点，在这一点真正结束运行）。
 *
 * 画布上没有「结束」节点时，第一个退出节点会直接变成结束节点。
 */

const EXIT_SCOPE_LOOP = 'loop';
const END_TYPE = 'end';

const isRef = (value: any): boolean => value?.type === 'ref' && Array.isArray(value.content);

/** 退出时声明的输出名列表（inputsValues 的键） */
const exitOutputNames = (node: any): string[] =>
  Object.keys(node?.data?.inputsValues || {}).filter((name) => name.trim().length > 0);

/** 输出/入参类型沿用被引用变量的 schema，取不到时按字符串处理 */
const schemaForValue = (pool: any[], value: any): Record<string, any> => {
  if (!isRef(value)) return { type: 'string' };
  const source = pool.find((node) => node?.id === value.content[0]);
  const schema = source?.data?.outputs?.properties?.[String(value.content[1])];
  return schema && typeof schema === 'object' ? { ...schema } : { type: 'string' };
};

const buildExitScript = (names: string[]): string => `function main({ params }) {
  return {
${names.map((name) => `    ${JSON.stringify(name)}: params[${JSON.stringify(name)}],`).join('\n')}
  };
}`;

/** 「退出整个工作流」→ 等价的代码节点：产出退出时声明的输出 */
const convertWorkflowExitToCode = (node: any, pool: any[]): any => {
  const inputsValues = node?.data?.inputsValues || {};
  const names = exitOutputNames(node);
  const properties = Object.fromEntries(
    names.map((name) => [name, schemaForValue(pool, inputsValues[name])]),
  );
  return {
    ...node,
    type: 'code',
    data: {
      ...node.data,
      script: { language: 'javascript', content: buildExitScript(names) },
      inputs: { type: 'object', properties: { ...properties } },
      outputs: { type: 'object', properties: { ...properties } },
    },
  };
};

/** 没有「结束」节点时，让第一个退出节点直接充当结束节点 */
const convertWorkflowExitToEnd = (node: any, pool: any[]): any => {
  const inputsValues = node?.data?.inputsValues || {};
  const properties = Object.fromEntries(
    exitOutputNames(node).map((name) => [name, schemaForValue(pool, inputsValues[name])]),
  );
  return {
    ...node,
    type: END_TYPE,
    data: {
      ...node.data,
      scope: undefined,
      inputsValues,
      inputs: { type: 'object', properties },
    },
  };
};

export const prepareExitNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(
  schema: T
): T => {
  if (!Array.isArray(schema.nodes)) return schema;

  /** 顶层节点 + 容器子节点，供引用类型解析使用 */
  const pool: any[] = [];
  for (const node of schema.nodes as any[]) {
    pool.push(node);
    if (Array.isArray(node?.blocks)) pool.push(...node.blocks);
  }

  const topLevel = schema.nodes as any[];
  const endNode = topLevel.find((node) => node?.type === END_TYPE);
  let changed = false;

  /** 顶层退出节点（退出整个工作流） */
  const workflowExitIds = new Set(
    topLevel
      .filter((node) => node?.type === 'exit' && String(node?.data?.scope || 'workflow') !== EXIT_SCOPE_LOOP)
      .map((node) => node.id),
  );

  const visit = (list: any[]): any[] =>
    list.map((node) => {
      if (!node || typeof node !== 'object') return node;
      let next = node;
      // 循环体里的退出节点：归一化成 break
      if (Array.isArray(node.blocks)) {
        const blocks = visit(node.blocks);
        if (blocks.some((block, index) => block !== node.blocks[index])) {
          next = { ...next, blocks };
        }
      }
      if (next.type !== 'exit') return next;
      changed = true;
      const scope = String(next?.data?.scope || 'workflow');
      if (scope === EXIT_SCOPE_LOOP) return { ...next, type: 'break' };
      // 没有结束节点时，第一个退出节点直接变成结束节点
      if (!endNode && next.id === [...workflowExitIds][0]) {
        workflowExitIds.delete(next.id);
        return convertWorkflowExitToEnd(next, pool);
      }
      return convertWorkflowExitToCode(next, pool);
    });

  const nodes = visit(topLevel);
  if (!changed) return schema;

  const edges = Array.isArray(schema.edges) ? [...schema.edges] : [];
  // 退出分支也要走到「结束」节点，否则本地运行会因为「没有结束节点执行」判为失败
  if (endNode) {
    for (const exitId of workflowExitIds) {
      if (edges.some((edge) => edge?.sourceNodeID === exitId)) continue;
      edges.push({ sourceNodeID: exitId, targetNodeID: endNode.id });
    }
    // 退出时声明的输出并入结束节点（重名的以结束节点自身配置为准）
    const endIndex = nodes.findIndex((node) => node?.id === endNode.id);
    if (endIndex >= 0) {
      const convertedEnd = nodes[endIndex];
      const merged = { ...(convertedEnd.data?.inputsValues || {}) };
      const extraProperties: Record<string, any> = {};
      for (const exitId of workflowExitIds) {
        const exitNode = nodes.find((node) => node?.id === exitId);
        for (const [name, value] of Object.entries(exitNode?.data?.inputsValues || {})) {
          if (name in merged) continue;
          merged[name] = { type: 'ref', content: [exitId, name] };
          extraProperties[name] = schemaForValue(pool, value);
        }
      }
      if (Object.keys(extraProperties).length > 0) {
        nodes[endIndex] = {
          ...convertedEnd,
          data: {
            ...convertedEnd.data,
            inputsValues: merged,
            inputs: {
              type: 'object',
              properties: { ...(convertedEnd.data?.inputs?.properties || {}), ...extraProperties },
            },
          },
        };
      }
    }
  }

  return { ...schema, nodes, edges };
};
