/**
 * FlowGram 值类型的统一处理。
 *
 * 画布上的「常量」输入框只接受字面量：用户在输入框里手写 `{{start_0.query}}` 时，
 * 值仍然是 constant，运行时会把这段文本原样传给节点（代码节点拿到的是字符串
 * "{{start_0.query}}" 而不是上游的取值）。这里在值回写时统一识别这种写法，
 * 自动升级为模板（template）类型，与「插入变量」选择器写入的结构一致。
 */

/** 带引用的模板片段，例如 {{start_0.query}} 或 {{#start_0.query#}}；与网关转换器的解析规则保持一致 */
const REFERENCE_PATTERN = /\{\{#?[^{}#]+#?\}\}/;

export interface FlowValueLike {
  type?: string;
  content?: unknown;
  schema?: unknown;
  extra?: unknown;
}

/**
 * 把「常量但内容是引用/模板」的值升级为模板类型；其它情况原样返回。
 * 返回同一个对象引用表示无需变更，便于调用方判断是否要触发 onChange。
 */
export const promoteTemplateValue = <T extends FlowValueLike | undefined>(value: T): T => {
  if (!value || value.type !== 'constant') return value;
  if (typeof value.content !== 'string') return value;
  if (!REFERENCE_PATTERN.test(value.content)) return value;
  return { ...value, type: 'template' } as T;
};

/** 对一组具名输入值做同样的升级，没有任何变更时返回原对象。 */
export const promoteTemplateValues = <
  T extends Record<string, FlowValueLike | undefined> | undefined,
>(
  values: T,
): T => {
  if (!values) return values;
  let changed = false;
  const next: Record<string, FlowValueLike | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    const promoted = promoteTemplateValue(value);
    if (promoted !== value) changed = true;
    next[key] = promoted;
  }
  return (changed ? next : values) as T;
};
