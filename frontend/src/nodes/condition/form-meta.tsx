/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormRenderProps, FormMeta, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import { autoRenameRefEffect } from '@flowgram.ai/form-materials';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent } from '../../form-components';
import { ConditionInputs } from './condition-inputs';
import { ConditionCardPorts } from './card-ports';

export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <ConditionInputs />
    </FormContent>
    {/* 折叠卡片上的 if/else 输出端口：表单在配置面板里，端口标记必须留在节点 DOM 内才能被画布识别 */}
    <ConditionCardPorts />
  </>
);

export const formMeta: FormMeta<FlowNodeJSON> = {
  render: renderForm,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    title: ({ value }: { value: string }) => (value ? undefined : '标题不能为空'),
    'conditions.*': ({ value }) => {
      if (!value?.value) return '条件不能为空';
      return undefined;
    },
  },
  effect: {
    conditions: autoRenameRefEffect,
  },
};
