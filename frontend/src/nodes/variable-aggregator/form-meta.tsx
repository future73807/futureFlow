/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps, ValidateTrigger } from '@flowgram.ai/free-layout-editor';

import { defaultFormMeta } from '../default-form-meta';
import { FormContent, FormHeader, LocalizedOutputs } from '../../form-components';
import { AggregateGroups } from './components/aggregate-groups';
import { validateAggregateGroups } from './aggregate';

export const AggregatorFormRender = ({ form }: FormRenderProps<any>) => (
  <>
    <FormHeader />
    <FormContent>
      <AggregateGroups form={form} />
      <LocalizedOutputs />
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  ...defaultFormMeta,
  render: AggregatorFormRender,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    ...defaultFormMeta.validate,
    title: ({ value }: { value?: string }) => (value?.trim() ? undefined : '标题不能为空'),
    strategy: ({ value }: { value?: string }) => (
      value === 'first-non-empty' ? undefined : '聚合策略不合法'
    ),
    groups: ({ value }: { value?: any }) => validateAggregateGroups(value),
  },
};
