type JavaScriptTokenKind = 'identifier' | 'literal' | 'punctuator';

type JavaScriptToken = {
  kind: JavaScriptTokenKind;
  value: string;
  braceDepth: number;
};

type CodeOutputSchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  properties?: Record<string, CodeOutputSchema>;
  items?: CodeOutputSchema;
};

type RuntimeNode = {
  id: string;
  type: string;
  data?: Record<string, any>;
  blocks?: RuntimeNode[];
  [key: string]: unknown;
};

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATORS = new Set([
  '(', '[', '{', '=', ':', ',', ';', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>',
]);

const skipQuotedString = (source: string, start: number, quote: string): number => {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
};

const canStartRegex = (previous: JavaScriptToken | undefined): boolean => {
  if (!previous) return true;
  if (previous.kind === 'identifier') return REGEX_PREFIX_KEYWORDS.has(previous.value);
  if (previous.kind === 'literal') return false;
  return REGEX_PREFIX_PUNCTUATORS.has(previous.value);
};

const skipRegexLiteral = (source: string, start: number): number => {
  let cursor = start + 1;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '[') inCharacterClass = true;
    if (char === ']' && inCharacterClass) inCharacterClass = false;
    if (char === '/' && !inCharacterClass) {
      cursor += 1;
      while (cursor < source.length && /[A-Za-z]/.test(source[cursor])) cursor += 1;
      return cursor;
    }
    if (char === '\n' || char === '\r') return cursor;
    cursor += 1;
  }
  return source.length;
};

const skipTemplateExpression = (source: string, start: number): number => {
  let cursor = start;
  let depth = 1;
  let previous: JavaScriptToken | undefined;
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      cursor += 2;
      while (cursor < source.length && !['\n', '\r'].includes(source[cursor])) cursor += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const end = skipQuotedString(source, cursor, char);
      previous = { kind: 'literal', value: source.slice(cursor, end), braceDepth: 0 };
      cursor = end;
      continue;
    }
    if (char === '`') {
      const end = skipTemplateLiteral(source, cursor);
      previous = { kind: 'literal', value: source.slice(cursor, end), braceDepth: 0 };
      cursor = end;
      continue;
    }
    if (char === '/' && canStartRegex(previous)) {
      const end = skipRegexLiteral(source, cursor);
      previous = { kind: 'literal', value: source.slice(cursor, end), braceDepth: 0 };
      cursor = end;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    const kind = IDENTIFIER_START.test(char)
      ? 'identifier'
      : /[0-9]/.test(char)
        ? 'literal'
        : 'punctuator';
    let end = cursor + 1;
    if (kind === 'identifier') {
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
    } else if (kind === 'literal') {
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
    }
    previous = { kind, value: source.slice(cursor, end), braceDepth: 0 };
    cursor = end;
  }
  return cursor;
};

function skipTemplateLiteral(source: string, start: number): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') return cursor + 1;
    if (source[cursor] === '$' && source[cursor + 1] === '{') {
      cursor = skipTemplateExpression(source, cursor + 2);
      continue;
    }
    cursor += 1;
  }
  return source.length;
}

const tokenizeExecutableJavaScript = (source: string): JavaScriptToken[] => {
  const tokens: JavaScriptToken[] = [];
  let cursor = 0;
  let braceDepth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      cursor += 2;
      while (cursor < source.length && !['\n', '\r'].includes(source[cursor])) cursor += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const end = skipQuotedString(source, cursor, char);
      tokens.push({ kind: 'literal', value: source.slice(cursor, end), braceDepth });
      cursor = end;
      continue;
    }
    if (char === '`') {
      const end = skipTemplateLiteral(source, cursor);
      tokens.push({ kind: 'literal', value: source.slice(cursor, end), braceDepth });
      cursor = end;
      continue;
    }
    const previous = tokens[tokens.length - 1];
    if (char === '/' && canStartRegex(previous)) {
      const end = skipRegexLiteral(source, cursor);
      tokens.push({ kind: 'literal', value: source.slice(cursor, end), braceDepth });
      cursor = end;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      let end = cursor + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      tokens.push({ kind: 'identifier', value: source.slice(cursor, end), braceDepth });
      cursor = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
      tokens.push({ kind: 'literal', value: source.slice(cursor, end), braceDepth });
      cursor = end;
      continue;
    }
    if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    tokens.push({ kind: 'punctuator', value: char, braceDepth });
    if (char === '{') braceDepth += 1;
    cursor += 1;
  }
  return tokens;
};

export const analyzeSynchronousJavaScript = (source: string) => {
  const tokens = tokenizeExecutableJavaScript(source);
  const identifiers = new Set(
    tokens.filter((token) => token.kind === 'identifier').map((token) => token.value),
  );
  let mainDeclarationCount = 0;
  let forbiddenSyntax: string | undefined;
  tokens.forEach((token, index) => {
    if (
      token.kind === 'identifier'
      && ['async', 'await', 'Promise'].includes(token.value)
      && !forbiddenSyntax
    ) forbiddenSyntax = token.value;
    if (token.kind === 'identifier' && token.value === 'then' && !forbiddenSyntax) {
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if (
        previous?.value === '.'
        || next?.value === ':'
        || (next?.value === '(' && ['{', ','].includes(previous?.value || ''))
      ) forbiddenSyntax = 'thenable/then';
    }
    const previous = tokens[index - 1];
    if (
      token.kind === 'identifier'
      && token.value === 'function'
      && token.braceDepth === 0
      && (!previous || previous.value === ';' || previous.value === '}')
      && tokens[index + 1]?.kind === 'identifier'
      && tokens[index + 1]?.value === 'main'
      && tokens[index + 2]?.value === '('
    ) mainDeclarationCount += 1;
  });
  return { identifiers, mainDeclarationCount, forbiddenSyntax };
};

const assertSynchronousJavaScript = (source: string, label: string) => {
  const analysis = analyzeSynchronousJavaScript(source);
  if (analysis.forbiddenSyntax) {
    throw new Error(
      `${label}必须同步执行；不能使用 ${analysis.forbiddenSyntax} 或返回 Promise/thenable`,
    );
  }
  if (analysis.mainDeclarationCount === 0) {
    throw new Error(`${label}必须声明顶层 function main({ params })`);
  }
  if (analysis.mainDeclarationCount > 1) {
    throw new Error(`${label}只能声明一个顶层 main 函数`);
  }
  return analysis;
};

const uniqueIdentifier = (identifiers: Set<string>, base: string): string => {
  let candidate = base;
  while (identifiers.has(candidate)) candidate += '_';
  identifiers.add(candidate);
  return candidate;
};

const normalizeSchema = (schema: any, path: string): CodeOutputSchema => {
  const rawType = String(schema?.type || '').toLowerCase();
  const aliases: Record<string, CodeOutputSchema> = {
    'array[string]': { type: 'array', items: { type: 'string' } },
    'string[]': { type: 'array', items: { type: 'string' } },
    'array[number]': { type: 'array', items: { type: 'number' } },
    'number[]': { type: 'array', items: { type: 'number' } },
    'array[boolean]': { type: 'array', items: { type: 'boolean' } },
    'boolean[]': { type: 'array', items: { type: 'boolean' } },
    'array[object]': { type: 'array', items: { type: 'object', properties: {} } },
    'object[]': { type: 'array', items: { type: 'object', properties: {} } },
  };
  if (aliases[rawType]) return aliases[rawType];
  if (['string', 'number', 'integer', 'boolean'].includes(rawType)) {
    return { type: rawType as CodeOutputSchema['type'] };
  }
  if (rawType === 'object') {
    const properties = schema?.properties;
    if (properties !== undefined && (!properties || typeof properties !== 'object' || Array.isArray(properties))) {
      throw new Error(`${path}的对象字段声明无效`);
    }
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties || {}).map(([key, child]) => [
          key,
          normalizeSchema(child, `${path}.${key}`),
        ]),
      ),
    };
  }
  if (rawType === 'array') {
    if (!schema?.items) throw new Error(`${path}的数组元素类型不能为空`);
    const items = normalizeSchema(schema.items, `${path}[]`);
    if (items.type === 'array') throw new Error(`${path}暂不支持嵌套数组输出`);
    return { type: 'array', items };
  }
  throw new Error(`${path}使用了不支持的输出类型“${rawType || '空'}”`);
};

const normalizeOutputSchema = (outputs: any, label: string): CodeOutputSchema => {
  const properties = outputs?.properties;
  if (properties !== undefined && (!properties || typeof properties !== 'object' || Array.isArray(properties))) {
    throw new Error(`${label}的输出字段声明无效`);
  }
  const normalizedProperties = Object.keys(properties || {}).length > 0
    ? Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          normalizeSchema(child, `${label}输出“${key}”`),
        ]),
      )
    : { result: { type: 'string' } as CodeOutputSchema };
  return { type: 'object', properties: normalizedProperties };
};

const buildRuntimeCode = (
  source: string,
  analysis: ReturnType<typeof analyzeSynchronousJavaScript>,
  outputSchema: CodeOutputSchema,
  label: string,
): string => {
  const identifiers = new Set(analysis.identifiers);
  const originalMainName = uniqueIdentifier(identifiers, '__futureFlowLocalMain');
  const rawResultName = uniqueIdentifier(identifiers, '__futureFlowLocalResult');
  const contractName = uniqueIdentifier(identifiers, '__futureFlowOutputContract');
  const typeName = uniqueIdentifier(identifiers, '__futureFlowValueType');
  const plainObjectName = uniqueIdentifier(identifiers, '__futureFlowIsPlainObject');
  const freeName = uniqueIdentifier(identifiers, '__futureFlowValidateFreeValue');
  const validateName = uniqueIdentifier(identifiers, '__futureFlowValidateOutput');
  const asyncError = JSON.stringify(
    `${label}仅支持同步执行，不能返回 Promise/thenable`,
  );
  const outputPath = JSON.stringify(`${label}输出`);

  return `${source}

const ${contractName} = ${JSON.stringify(outputSchema)};
function ${typeName}(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function ${plainObjectName}(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ${freeName}(value, path) {
  if (value === null) return;
  const valueType = ${typeName}(value);
  if (valueType === 'string' || valueType === 'boolean') return;
  if (valueType === 'number') {
    if (!Number.isFinite(value)) throw new Error(path + '必须是有限数字');
    return;
  }
  if (valueType === 'array') {
    value.forEach((item, index) => ${freeName}(item, path + '[' + index + ']'));
    return;
  }
  if (valueType === 'object') {
    if (!${plainObjectName}(value)) throw new Error(path + '必须是普通对象');
    Object.keys(value).forEach((key) => ${freeName}(value[key], path + '.' + key));
    return;
  }
  throw new Error(path + '包含不支持的返回值类型');
}
function ${validateName}(schema, value, path) {
  if (value === null) return;
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(path + '必须是字符串');
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(path + '必须是有限数字');
    return;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(path + '必须是整数');
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(path + '必须是布尔值');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(path + '必须是数组');
    value.forEach((item, index) => ${validateName}(schema.items, item, path + '[' + index + ']'));
    return;
  }
  if (schema.type === 'object') {
    if (!${plainObjectName}(value)) throw new Error(path + '必须是对象');
    const expectedKeys = Object.keys(schema.properties || {});
    if (expectedKeys.length === 0) {
      ${freeName}(value, path);
      return;
    }
    expectedKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(path + '.' + key + '缺失');
      ${validateName}(schema.properties[key], value[key], path + '.' + key);
    });
    Object.keys(value).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        throw new Error(path + '.' + key + '未在输出声明中');
      }
    });
    return;
  }
  throw new Error(path + '使用了不支持的输出类型');
}

const ${originalMainName} = main;
main = function(args) {
  const ${rawResultName} = ${originalMainName}(args);
  if (
    ${rawResultName} !== null
    && (typeof ${rawResultName} === 'object' || typeof ${rawResultName} === 'function')
    && typeof ${rawResultName}.then === 'function'
  ) {
    throw new Error(${asyncError});
  }
  if (${rawResultName} === null) throw new Error(${outputPath} + '必须是对象');
  ${validateName}(${contractName}, ${rawResultName}, ${outputPath});
  return ${rawResultName};
};`;
};

const visitNodes = (nodes: RuntimeNode[]): RuntimeNode[] => nodes.map((node) => {
  const blocks = Array.isArray(node.blocks) ? visitNodes(node.blocks) : node.blocks;
  if (node.type !== 'code') return blocks === node.blocks ? node : { ...node, blocks };

  const data = node.data || {};
  const inputsValues = data.inputsValues || {};
  const script = data.script || {};
  const language = String(
    script.language || inputsValues.codeLanguage?.content || 'javascript',
  );
  const source = String(script.content || inputsValues.code?.content || '');
  const label = `代码节点 ${node.id}`;
  if (language !== 'javascript') throw new Error(`${label}当前仅支持 JavaScript`);
  if (!source.trim()) throw new Error(`${label}的脚本不能为空`);
  const analysis = assertSynchronousJavaScript(source, label);
  const outputSchema = normalizeOutputSchema(data.outputs, label);

  return {
    ...node,
    blocks,
    data: {
      ...data,
      script: {
        ...script,
        language: 'javascript',
        content: buildRuntimeCode(source, analysis, outputSchema, label),
      },
    },
  };
});

/**
 * 浏览器 runtime-js 会等待 Promise，而 Dify 0.15.3 的代码模板只读取同步
 * 返回值。试运行前统一套上同步与输出契约，确保本地成功不会在发布后变成
 * 缺字段、类型错误或 Promise 序列化失败。
 */
export const prepareCodeNodesForRuntime = <T extends { nodes?: any[] }>(schema: T): T => (
  Array.isArray(schema.nodes)
    ? { ...schema, nodes: visitNodes(schema.nodes as RuntimeNode[]) }
    : schema
);
