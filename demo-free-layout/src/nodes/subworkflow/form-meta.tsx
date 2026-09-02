/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent } from '../../form-components';
import { TargetWorkflowSelect } from './components/target-select';
import { InputMappings } from './components/input-mappings';

export const FormRender = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <TargetWorkflowSelect />
      <InputMappings />
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  render: (props) => <FormRender {...props} />,
  validate: {
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    targetWorkflowId: ({ value }: { value: string }) => (value?.trim() ? undefined : '请选择目标工作流'),
  },
};
