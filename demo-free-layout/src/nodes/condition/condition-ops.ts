/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  ConditionPresetOp,
  type IConditionRule,
  type ConditionOpConfigs,
} from '@flowgram.ai/form-materials';

export const CHINESE_CONDITION_OPS: ConditionOpConfigs = {
  [ConditionPresetOp.EQ]: { label: '等于', abbreviation: '=' },
  [ConditionPresetOp.NEQ]: { label: '不等于', abbreviation: '≠' },
  [ConditionPresetOp.GT]: { label: '大于', abbreviation: '>' },
  [ConditionPresetOp.GTE]: { label: '大于等于', abbreviation: '>=' },
  [ConditionPresetOp.LT]: { label: '小于', abbreviation: '<' },
  [ConditionPresetOp.LTE]: { label: '小于等于', abbreviation: '<=' },
  [ConditionPresetOp.IN]: { label: '属于', abbreviation: '∈' },
  [ConditionPresetOp.NIN]: { label: '不属于', abbreviation: '∉' },
  [ConditionPresetOp.CONTAINS]: { label: '包含', abbreviation: '⊇' },
  [ConditionPresetOp.NOT_CONTAINS]: { label: '不包含', abbreviation: '⊉' },
  [ConditionPresetOp.IS_EMPTY]: {
    label: '为空',
    abbreviation: '=',
    rightDisplay: '空',
  },
  [ConditionPresetOp.IS_NOT_EMPTY]: {
    label: '不为空',
    abbreviation: '≠',
    rightDisplay: '空',
  },
  [ConditionPresetOp.IS_TRUE]: {
    label: '为真',
    abbreviation: '=',
    rightDisplay: '真',
  },
  [ConditionPresetOp.IS_FALSE]: {
    label: '为假',
    abbreviation: '=',
    rightDisplay: '假',
  },
};

/**
 * Keep the editor's selectable operators aligned with both the local
 * FlowGram runtime and the managed Dify 0.15.3 runtime. In particular,
 * FlowGram's stock form offers array comparisons that its own executor does
 * not implement, and Dify cannot compare numeric/boolean values against a
 * list of strings without changing their type first.
 */
export const FUTUREFLOW_CONDITION_RULES: Record<string, IConditionRule> = {
  string: {
    [ConditionPresetOp.EQ]: { type: 'string' },
    [ConditionPresetOp.NEQ]: { type: 'string' },
    [ConditionPresetOp.CONTAINS]: { type: 'string' },
    [ConditionPresetOp.NOT_CONTAINS]: { type: 'string' },
    [ConditionPresetOp.IN]: { type: 'array', items: { type: 'string' } },
    [ConditionPresetOp.NIN]: { type: 'array', items: { type: 'string' } },
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  number: {
    [ConditionPresetOp.EQ]: { type: 'number' },
    [ConditionPresetOp.NEQ]: { type: 'number' },
    [ConditionPresetOp.GT]: { type: 'number' },
    [ConditionPresetOp.GTE]: { type: 'number' },
    [ConditionPresetOp.LT]: { type: 'number' },
    [ConditionPresetOp.LTE]: { type: 'number' },
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  integer: {
    [ConditionPresetOp.EQ]: { type: 'integer' },
    [ConditionPresetOp.NEQ]: { type: 'integer' },
    [ConditionPresetOp.GT]: { type: 'integer' },
    [ConditionPresetOp.GTE]: { type: 'integer' },
    [ConditionPresetOp.LT]: { type: 'integer' },
    [ConditionPresetOp.LTE]: { type: 'integer' },
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  boolean: {
    [ConditionPresetOp.EQ]: { type: 'boolean' },
    [ConditionPresetOp.NEQ]: { type: 'boolean' },
    [ConditionPresetOp.IS_TRUE]: null,
    [ConditionPresetOp.IS_FALSE]: null,
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  array: {
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  object: {
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  map: {
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  'date-time': {
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
  null: {
    [ConditionPresetOp.IS_EMPTY]: null,
    [ConditionPresetOp.IS_NOT_EMPTY]: null,
  },
};
