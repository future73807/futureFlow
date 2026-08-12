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
  'date-time': '日期时间',
  enum: '枚举',
  unknown: '未知类型',
};

const getSchemaType = (schema: SchemaShape) =>
  schema.type === 'string' && schema.format ? schema.format : schema.type || 'unknown';

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

const CHINESE_SCHEMA_TYPES = Object.entries(TYPE_LABELS).map(([type, label]) => ({
  type,
  label,
  customComplexText: getLocalizedSchemaText,
  ...(type === 'unknown' ? { ConstantRenderer: LocalizedUnsupportedType } : {}),
})) as unknown as JsonSchemaTypeRegistry[];

export const LocalizedSchemaTypeProvider = ({ children }: PropsWithChildren) => (
  <JsonSchemaTypePresetProvider types={CHINESE_SCHEMA_TYPES}>
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
};
