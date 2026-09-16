/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { ComponentProps, PropsWithChildren } from 'react';

import {
  JsonSchemaTypePresetProvider,
  VariableSelector,
  type JsonSchemaTypeRegistry,
} from '@flowgram.ai/form-materials';
import { Input } from '@douyinfe/semi-ui';

import { LocalizedTypeSelector } from './localized-type-selector';

type SchemaShape = {
  type?: string;
  format?: string;
  items?: SchemaShape;
  additionalProperties?: SchemaShape;
};

const TYPE_LABELS: Record<string, string> = {
  string: '字符串',
  object: '对象',
  number: '数字',
  boolean: '布尔值',
  array: '数组',
  integer: '整数',
  map: '映射',
  // 时间：ISO 8601 字符串（内置 date-time，发布到云端时按文本传递）
  'date-time': '时间',
  // 文件：文件链接/文件流（画布上按字符串传递，媒体节点输出的 url 就是文件）
  file: '文件',
  enum: '枚举',
  unknown: '未知类型',
};

const getSchemaType = (schema: SchemaShape) => {
  if (schema.type === 'string' && schema.format) {
    // 文件流用 string + format:file 表达，时间用 string + format:date-time
    return schema.format === 'file' ? 'file' : schema.format === 'date-time' ? 'time' : schema.format;
  }
  return schema.type || 'unknown';
};

const getLocalizedSchemaText = (schema: SchemaShape): string => {
  const type = getSchemaType(schema);
  const label = TYPE_LABELS[type] || '未知类型';

  if (type === 'array' && schema.items) {
    return `${label}<${getLocalizedSchemaText(schema.items)}>`;
  }

  if (type === 'map' && schema.additionalProperties) {
    return `${label}<字符串, ${getLocalizedSchemaText(schema.additionalProperties)}>`;
  }

  return label;
};

const LocalizedUnsupportedType = () => (
  <Input size="small" disabled placeholder="不支持的类型" />
);

/**
 * 文件类型：画布上用「文件链接」表达（媒体节点输出的资源地址就是文件流）。
 * 内置类型里没有 file，这里注册一个，让开始节点输入、节点输出都能选到「文件」。
 */
const fileRegistry = {
  type: 'file',
  label: TYPE_LABELS.file,
  ConstantRenderer: ({ readonly, ...rest }: any) => (
    <Input
      size="small"
      placeholder="文件链接（例如媒体节点输出的资源地址）"
      disabled={readonly}
      {...rest}
    />
  ),
  customComplexText: getLocalizedSchemaText,
} as unknown as JsonSchemaTypeRegistry;

const CHINESE_SCHEMA_TYPES = Object.entries(TYPE_LABELS).map(([type, label]) => ({
  type,
  label,
  customComplexText: getLocalizedSchemaText,
  ...(type === 'unknown' ? { ConstantRenderer: LocalizedUnsupportedType } : {}),
})) as unknown as JsonSchemaTypeRegistry[];

export const LocalizedSchemaTypeProvider = ({ children }: PropsWithChildren) => (
  <JsonSchemaTypePresetProvider types={[...CHINESE_SCHEMA_TYPES, fileRegistry]}>
    {children}
  </JsonSchemaTypePresetProvider>
);

type VariableSelectorProps = ComponentProps<typeof VariableSelector>;

export const LocalizedVariableSelector = ({ config, ...props }: VariableSelectorProps) => (
  <VariableSelector
    {...props}
    config={{
      placeholder: '选择变量',
      notFoundContent: '变量不可用',
      ...config,
    }}
  />
);

export const LOCALIZED_MATERIAL_COMPONENTS = {
  'variable-selector-render-key': LocalizedVariableSelector,
  // 变量类型下拉：完整展示 + 数组悬停展开 + 统一图标
  'type-selector-render-key': LocalizedTypeSelector,
};
