import { FIELD_LABELS } from '../form-components/field-labels';

const EXACT_TITLES: Record<string, string> = {
  Start: '开始',
  End: '结束',
  LLM: '大语言模型',
  HTTP: 'API 请求',
  Code: '代码执行',
  Variable: '变量赋值',
  Loop: '数组批处理',
  Group: '分组',
  Continue: '继续循环',
  Break: '中断循环',
};

const PREFIX_TITLES: Array<[RegExp, string]> = [
  [/^LLM_(\d+)$/i, '大语言模型'],
  [/^HTTP_(\d+)$/i, 'API 请求'],
  [/^Code_(\d+)$/i, '代码执行'],
  [/^Variable_(\d+)$/i, '变量赋值'],
  [/^Loop_(\d+)$/i, '数组批处理'],
  [/^Group_(\d+)$/i, '分组'],
  [/^Continue_(\d+)$/i, '继续循环'],
  [/^Break_(\d+)$/i, '中断循环'],
];

const localizeTitle = (title: unknown): unknown => {
  if (typeof title !== 'string') return title;
  if (EXACT_TITLES[title]) return EXACT_TITLES[title];
  for (const [pattern, label] of PREFIX_TITLES) {
    const match = title.match(pattern);
    if (match) return `${label} ${match[1]}`;
  }
  return title;
};

const localizeSchema = (schema: any): any => {
  if (!schema || typeof schema !== 'object') return schema;

  const properties = schema.properties && typeof schema.properties === 'object'
    ? Object.fromEntries(
      Object.entries(schema.properties).map(([key, property]) => {
        const localizedProperty = localizeSchema(property);
        const title = localizedProperty?.title || FIELD_LABELS[key];
        return [key, title ? { ...localizedProperty, title } : localizedProperty];
      }),
    )
    : schema.properties;

  return {
    ...schema,
    ...(properties ? { properties } : {}),
    ...(schema.items ? { items: localizeSchema(schema.items) } : {}),
    ...(schema.additionalProperties
      ? { additionalProperties: localizeSchema(schema.additionalProperties) }
      : {}),
  };
};

const restoreFixedInputs = (nodeType: string, schema: any): any => {
  const definitions: Record<string, Record<string, any>> = {
    llm: {
      modelName: { type: 'string', title: '模型名称' },
      temperature: { type: 'number', title: '生成温度' },
      systemPrompt: {
        type: 'string',
        title: '系统提示词',
        extra: { formComponent: 'prompt-editor' },
      },
      prompt: {
        type: 'string',
        title: '用户提示词',
        extra: { formComponent: 'prompt-editor' },
      },
    },
    text: {
      text: {
        type: 'string',
        title: '文本内容',
        extra: { formComponent: 'prompt-editor' },
      },
    },
    image: {
      url: {
        type: 'string',
        title: '资源地址',
        extra: { formComponent: 'prompt-editor' },
      },
      caption: {
        type: 'string',
        title: '说明文字',
        extra: { formComponent: 'prompt-editor' },
      },
    },
    video: {
      url: {
        type: 'string',
        title: '资源地址',
        extra: { formComponent: 'prompt-editor' },
      },
      poster: {
        type: 'string',
        title: '视频封面',
        extra: { formComponent: 'prompt-editor' },
      },
      caption: {
        type: 'string',
        title: '说明文字',
        extra: { formComponent: 'prompt-editor' },
      },
    },
  };
  const requiredByType: Record<string, string[]> = {
    llm: ['modelName', 'temperature', 'prompt'],
    text: ['text'],
    image: ['url'],
    video: ['url'],
  };
  const fixedProperties = definitions[nodeType];
  if (!fixedProperties) return schema;

  const currentSchema = schema && typeof schema === 'object' ? schema : {};
  const currentProperties = currentSchema.properties || {};
  const properties = Object.fromEntries(
    Object.entries(fixedProperties).map(([key, fallback]) => {
      const current = currentProperties[key] || {};
      return [key, {
        ...fallback,
        ...current,
        ...(fallback.extra || current.extra
          ? { extra: { ...(current.extra || {}), ...(fallback.extra || {}) } }
          : {}),
      }];
    }),
  );
  const required = Array.from(new Set([
    ...(Array.isArray(currentSchema.required) ? currentSchema.required : []),
    ...requiredByType[nodeType],
  ]));

  return localizeSchema({
    ...currentSchema,
    type: 'object',
    properties: { ...currentProperties, ...properties },
    required,
  });
};

const localizeNode = (node: any): any => {
  const data = {
    ...(node.data || {}),
    title: localizeTitle(node.data?.title),
    inputs: restoreFixedInputs(String(node.type || ''), node.data?.inputs),
    outputs: localizeSchema(node.data?.outputs),
    headers: localizeSchema(node.data?.headers),
    params: localizeSchema(node.data?.params),
  };
  const systemPrompt = data.inputsValues?.systemPrompt;
  if (systemPrompt?.content === '# Role\nYou are an AI assistant.\n') {
    data.inputsValues = {
      ...data.inputsValues,
      systemPrompt: {
        ...systemPrompt,
        content: '你是一名可靠的 AI 助手，请用清晰、准确的中文回答。',
      },
    };
  }
  return {
    ...node,
    data,
    blocks: Array.isArray(node.blocks) ? node.blocks.map(localizeNode) : node.blocks,
  };
};

/** 只迁移内置英文默认值，不改动用户自行填写的英文标题或内容。 */
export const normalizeCanvasLocale = (flowgram: any) => {
  if (!flowgram || !Array.isArray(flowgram.nodes)) return flowgram;
  return {
    ...flowgram,
    nodes: flowgram.nodes.map(localizeNode),
    globalVariable: localizeSchema(flowgram.globalVariable),
  };
};
