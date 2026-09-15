/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormRenderProps, FormMeta, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import {
  autoRenameRefEffect,
  provideJsonSchemaOutputs,
  syncVariableTitle,
  validateFlowValue,
  validateWhenVariableSync,
  listenRefSchemaChange,
} from '@flowgram.ai/form-materials';
import { Divider } from '@douyinfe/semi-ui';

import { FlowNodeJSON } from '../typings';
import { FormHeader, FormContent, FormInputs, LocalizedOutputs } from '../form-components';
import { getFieldLabel } from '../form-components/field-labels';

export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <FormInputs />
      <Divider />
      <LocalizedOutputs />
    </FormContent>
  </>
);

export const defaultFormMeta: FormMeta<FlowNodeJSON> = {
  render: renderForm,
  validateTrigger: ValidateTrigger.onChange,
  /**
   * Supported writing as:
   * 1: validate as options: { title: () => {} , ... }
   * 2: validate as dynamic function: (values,  ctx) => ({ title: () => {}, ... })
   */
  validate: {
    title: ({ value }) => (value ? undefined : '标题不能为空'),
    'inputsValues.*': ({ value, context, formValues, name }) => {
      const valuePropertyKey = name.replace(/^inputsValues\./, '');
      const required = formValues.inputs?.required || [];

      return validateFlowValue(value, {
        node: context.node,
        required: required.includes(valuePropertyKey),
        errorMessages: {
          required: `${getFieldLabel(valuePropertyKey)}不能为空`,
        },
      });
    },
  },
  /**
   * Initialize (fromJSON) data transformation
   * 初始化(fromJSON) 数据转换
   * @param value
   * @param ctx
   */
  formatOnInit: (value, ctx) => value,
  /**
   * Save (toJSON) data transformation
   * 保存(toJSON) 数据转换
   * @param value
   * @param ctx
   */
  formatOnSubmit: (value, ctx) => value,
  effect: {
    title: syncVariableTitle,
    outputs: provideJsonSchemaOutputs,
    inputsValues: [...autoRenameRefEffect, ...validateWhenVariableSync({ scope: 'public' })],
    'inputsValues.*': listenRefSchemaChange((params) => {
      console.log(`[${params.context.node.id}][${params.name}] Schema Of Ref Updated`);
    }),
  },
};
