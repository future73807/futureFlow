/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent } from '../../form-components';
import { DatasetSelect } from './components/dataset-select';
import { QueryRef } from './components/query-ref';
import { TopK } from './components/top-k';

export const FormRender = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <DatasetSelect />
      <QueryRef />
      <TopK />
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  render: (props) => <FormRender {...props} />,
  validate: {
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    datasetId: ({ value }: { value: string }) => (value?.trim() ? undefined : '请选择知识库'),
    queryValue: ({ value }: { value: any }) => {
      if (!value || value.type !== 'ref' || !Array.isArray(value.content) || value.content.length < 2) {
        return '请引用一个上游变量作为检索语句';
      }
      return undefined;
    },
    topK: ({ value }: { value: number }) => (
      Number.isInteger(value) && value >= 1 && value <= 10
        ? undefined
        : '返回数量必须是 1 到 10 之间的整数'
    ),
  },
};
