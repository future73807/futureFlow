/**
 * 变量聚合节点的共享语义。
 *
 * 一个聚合节点由若干「分组」组成，每个分组是一串变量引用；节点按顺序取该分组里
 * 第一个非空的值作为这个分组的输出（对应面板上的「返回每个分组中第一个非空的值」）。
 *
 * 画布上的节点是语义节点，本地试运行与云端发布都会把它编译成等价的同步 JavaScript
 * 代码节点（保留原节点 id，下游引用不变），保证两端的取值规则完全一致：
 *   - 空值判定：null / undefined / 空串 / 只有空白的字符串 / 空数组；
 *   - 分组内全部为空时返回该类型的安全空值（'' / 0 / false / [] / {}）。
 */

export type AggregateValue = { type?: string; content?: unknown };

export interface AggregateGroup {
  key: string;
  values: Array<AggregateValue | undefined>;
}

const SUPPORTED_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'];

/** 归一化类型名：未知类型按字符串处理 */
export const normalizeAggregateType = (type: unknown): string => {
  const normalized = String(type || 'string').toLowerCase();
  if (['integer', 'number'].includes(normalized)) return 'number';
  return SUPPORTED_TYPES.includes(normalized) ? normalized : 'string';
};

/** 空值判定：与生成脚本里的 pickFirst 完全一致 */
export const isEmptyAggregateValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/** 该类型的兜底空值字面量 */
export const aggregateFallbackLiteral = (type: string): string => {
  switch (normalizeAggregateType(type)) {
    case 'number':
      return '0';
    case 'boolean':
      return 'false';
    case 'array':
      return '[]';
    case 'object':
      return '{}';
    default:
      return "''";
  }
};

/** 校验分组结构：至少一个分组、每组至少一个变量引用、分组名唯一且合法 */
export const validateAggregateGroups = (
  groups: AggregateGroup[] | undefined,
): string | undefined => {
  if (!Array.isArray(groups) || groups.length === 0) return '至少需要一个分组';
  const seen = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const key = String(group?.key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return `第 ${index + 1} 个分组的输出名需以字母或下划线开头，仅包含字母、数字和下划线`;
    }
    if (seen.has(key)) return `分组输出名重复：${key}`;
    seen.add(key);
    const values = Array.isArray(group?.values) ? group.values : [];
    if (values.length === 0) return `分组 ${key} 至少需要一个变量`;
    for (const value of values) {
      if (
        !value
        || value.type !== 'ref'
        || !Array.isArray(value.content)
        || (value.content as unknown[]).length < 2
      ) {
        return `分组 ${key} 里有未选择的变量`;
      }
    }
  }
  return undefined;
};

/**
 * 把聚合节点编译成等价代码节点的脚本。
 * 每组一个参数前缀 `v<组序号>_<变量序号>`，返回值按分组名给出。
 */
export const buildAggregateScript = (groups: AggregateGroup[], groupTypes: Record<string, string>): string => {
  const lines: string[] = [];
  lines.push('function main({ params }) {');
  lines.push('  const pickFirst = (values, fallback) => {');
  lines.push('    for (const value of values) {');
  lines.push('      if (value === null || value === undefined) continue;');
  lines.push("      if (typeof value === 'string' && value.trim() === '') continue;");
  lines.push('      if (Array.isArray(value) && value.length === 0) continue;');
  lines.push('      return value;');
  lines.push('    }');
  lines.push('    return fallback;');
  lines.push('  };');
  const entries = groups.map((group, groupIndex) => {
    const params = (group.values || [])
      .map((_value, valueIndex) => `params[${JSON.stringify(`v${groupIndex}_${valueIndex}`)}]`)
      .join(', ');
    const fallback = aggregateFallbackLiteral(groupTypes[group.key] || 'string');
    return `    ${JSON.stringify(group.key)}: pickFirst([${params}], ${fallback}),`;
  });
  lines.push('  return {');
  lines.push(...entries);
  lines.push('  };');
  lines.push('}');
  return lines.join('\n');
};

/** 参数名：与脚本里的 v<组>_<项> 对应 */
export const aggregateParamName = (groupIndex: number, valueIndex: number): string =>
  `v${groupIndex}_${valueIndex}`;
