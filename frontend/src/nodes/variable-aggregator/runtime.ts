/**
 * 变量聚合节点的本地试运行归一化。
 *
 * 浏览器运行时没有「聚合」这种语义，这里把它编译成等价的同步 JavaScript 代码节点：
 * 保留原节点 id（下游 {{节点.输出}} 引用不变），入参是各分组里的变量引用，脚本按
 * 「每个分组返回第一个非空的值」取值。云端 Dify 侧用同一套规则生成代码节点。
 */

import {
  AggregateGroup,
  aggregateParamName,
  buildAggregateScript,
  normalizeAggregateType,
} from './aggregate';

const schemaTypeOf = (nodes: any[], selector: string[]): string => {
  const source = nodes.find((node) => node?.id === selector[0]);
  const properties = source?.data?.outputs?.properties as Record<string, any> | undefined;
  const schema = properties?.[selector[1]];
  return normalizeAggregateType(schema?.type);
};

export const prepareAggregatorNodesForRuntime = <T extends { nodes?: any[]; edges?: any[] }>(
  schema: T,
): T => {
  if (!Array.isArray(schema.nodes)) return schema;
  const source = schema.nodes as any[];
  const nodes = source.map((node) => {
    if (node?.type !== 'variable-aggregator') return node;
    const groups: AggregateGroup[] = Array.isArray(node?.data?.groups) ? node.data.groups : [];
    if (groups.length === 0) return node;

    const inputsValues: Record<string, any> = {};
    const inputsProperties: Record<string, any> = {};
    const groupTypes: Record<string, string> = {};
    groups.forEach((group, groupIndex) => {
      (group.values || []).forEach((value, valueIndex) => {
        if (!value || value.type !== 'ref' || !Array.isArray(value.content) || value.content.length < 2) {
          return;
        }
        const name = aggregateParamName(groupIndex, valueIndex);
        inputsValues[name] = value;
        const type = schemaTypeOf(source, value.content.map(String));
        inputsProperties[name] = { type, title: name };
        if (groupIndex === 0 || !groupTypes[group.key]) {
          groupTypes[group.key] = type;
        }
      });
    });

    // 输出按分组推导，不依赖画布写入的 outputs：通过 API 建的工作流同样能跑
    const outputsProperties: Record<string, any> = {};
    groups.forEach((group) => {
      const key = String(group?.key || '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
      outputsProperties[key] = { type: groupTypes[key] || 'string', title: key };
    });

    return {
      ...node,
      type: 'code',
      data: {
        ...node.data,
        inputsValues,
        inputs: { type: 'object', properties: inputsProperties },
        script: {
          language: 'javascript',
          content: buildAggregateScript(groups, groupTypes),
        },
        outputs: { type: 'object', properties: outputsProperties },
      },
    };
  });
  return { ...schema, nodes };
};
