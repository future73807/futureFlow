/**
 * 循环节点的本地试运行归一化。
 *
 * 画布上的循环支持三种「循环类型」：
 *   - array    ：使用数组循环（默认），数组来自上游变量；
 *   - count    ：指定循环次数；
 *   - infinite ：无限循环，受「最大轮数」保护。
 *
 * 浏览器本地运行时只认「数组 + 逐项下标」的循环语义，因此这里把 count / infinite
 * 归一化成等价的数组循环：在循环上游插入一个生成 [1..N] 的代码节点，并把循环数组
 * 指向它。循环体、循环输出、下游引用都保持不变。
 *
 * 同时把循环节点上的「中间变量」注入到循环体代码节点的入参里，让循环体可以读
 * 循环外的值（对应云端 iteration 的中间变量语义）。
 */

const MAX_ROUNDS = 20;

const clampRounds = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_ROUNDS, Math.max(1, Math.trunc(parsed)));
};

const rangeScript = (rounds: number) => `function main() {
  return { items: Array.from({ length: ${rounds} }, (_, index) => index + 1) };
}`;

/** 解析循环轮数：指定次数用 loopCount，无限循环用 loopMaxRounds */
export const resolveLoopRounds = (data: Record<string, any> | undefined): number => {
  if (!data) return MAX_ROUNDS;
  return String(data.loopType || 'array') === 'count'
    ? clampRounds(data.loopCount, 3)
    : clampRounds(data.loopMaxRounds, MAX_ROUNDS);
};

/** 循环节点是否需要换成生成的数组（count / infinite 两种类型） */
export const loopNeedsRangeArray = (data: Record<string, any> | undefined): boolean =>
  ['count', 'infinite'].includes(String(data?.loopType || 'array'));

const outputSchemaFor = (nodes: any[], selector: string[]): Record<string, any> => {
  const source = nodes.find((node) => node?.id === selector[0]);
  const properties = source?.data?.outputs?.properties as Record<string, any> | undefined;
  const schema = properties?.[selector[1]];
  if (schema && typeof schema === 'object') return { ...schema };
  return { type: 'string' };
};

/**
 * 让循环体的 item 类型跟随数组元素类型：
 * 数组元素是对象时，循环体里就能通过 item.<属性> 取字段。
 * 循环体内所有代码节点都会拿到 item 声明（链式传递）。
 */
const applyLoopItemType = (loop: any, nodes: any[]): void => {
  const loopFor = loop?.data?.loopFor;
  if (!loopFor || loopFor.type !== 'ref' || !Array.isArray(loopFor.content)) return;
  const source = nodes.find((node) => node?.id === loopFor.content[0]);
  const schema = source?.data?.outputs?.properties?.[String(loopFor.content[1])];
  const itemSchema = itemSchemaOf(schema);
  if (!itemSchema) return;
  const codeNodes = Array.isArray(loop?.blocks)
    ? loop.blocks.filter((block: any) => block?.type === 'code')
    : [];
  for (const codeNode of codeNodes) {
    if (!codeNode?.data?.inputs?.properties?.item) continue;
    codeNode.data.inputs = {
      ...codeNode.data.inputs,
      properties: {
        ...codeNode.data.inputs.properties,
        item: { ...codeNode.data.inputs.properties.item, ...itemSchema },
      },
    };
  }
};

/**
 * 把循环节点的「中间变量」写进循环体内所有代码节点的入参：
 * 循环体里就可以用 params.<变量名> 读取循环外的值。
 */
const applyLoopMiddleValues = (loop: any, nodes: any[]): void => {
  const middleValues = loop?.data?.loopMiddleValues as Record<string, any> | undefined;
  const codeNodes = Array.isArray(loop?.blocks)
    ? loop.blocks.filter((block: any) => block?.type === 'code')
    : [];
  if (codeNodes.length === 0 || !middleValues) return;
  for (const codeNode of codeNodes) {
    for (const [name, mapping] of Object.entries(middleValues)) {
      if (!name || !mapping || mapping.type !== 'ref' || !Array.isArray(mapping.content)) continue;
      codeNode.data = codeNode.data || {};
      codeNode.data.inputsValues = { ...(codeNode.data.inputsValues || {}), [name]: mapping };
      codeNode.data.inputs = codeNode.data.inputs || { type: 'object', properties: {} };
      codeNode.data.inputs.properties = {
        ...(codeNode.data.inputs.properties || {}),
        [name]: outputSchemaFor(nodes, mapping.content.map(String)),
      };
    }
  }
};

/** 数组元素类型 → 循环体 item 的声明类型（对象数组时循环体用 item.<属性> 取字段） */
const itemSchemaOf = (schema: any): Record<string, any> | null => {
  const items = schema?.type === 'array' ? schema.items : null;
  if (!items || typeof items !== 'object') return null;
  return { ...items };
};

export const prepareLoopNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(
  schema: T
): T => {
  if (!Array.isArray(schema.nodes)) return schema;
  const nodes = [...(schema.nodes as any[])];
  const edges = Array.isArray(schema.edges) ? [...schema.edges] : [];
  const injected: any[] = [];

  for (const node of nodes) {
    if (node?.type !== 'loop') continue;
    applyLoopMiddleValues(node, nodes);
    applyLoopItemType(node, nodes);
    if (!loopNeedsRangeArray(node.data)) continue;

    const rounds = resolveLoopRounds(node.data);
    const rangeId = `${node.id}_range`;
    injected.push({
      id: rangeId,
      type: 'code',
      meta: {
        position: {
          x: Number(node?.meta?.position?.x ?? 0) - 300,
          y: Number(node?.meta?.position?.y ?? 0),
        },
      },
      data: {
        title: `${node?.data?.title || '循环'} · 轮次数组`,
        inputsValues: {},
        inputs: { type: 'object', properties: {} },
        script: { language: 'javascript', content: rangeScript(rounds) },
        outputs: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'number' }, title: '轮次数组' },
          },
        },
      },
    });

    // 原来指向循环的入边改为指向轮次数组，再补一条 数组 → 循环
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      if (edge?.targetNodeID === node.id) {
        edges[index] = { ...edge, targetNodeID: rangeId };
      }
    }
    edges.push({ sourceNodeID: rangeId, targetNodeID: node.id });
    node.data = node.data || {};
    node.data.loopFor = { type: 'ref', content: [rangeId, 'items'] };
  }

  if (injected.length === 0) return { ...schema, edges };
  return { ...schema, nodes: [...nodes, ...injected], edges };
};
