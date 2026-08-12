/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import { createInferAssignPlugin, DisplayOutputs } from '@flowgram.ai/form-materials';

import { FormHeader, FormContent } from '../../form-components';
import { VariableNodeJSON } from './types';
import { defaultFormMeta } from '../default-form-meta';
import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { LocalizedAssignRows } from './localized-assign-rows';

export const FormRender = ({ form }: FormRenderProps<VariableNodeJSON>) => {
  const isSidebar = useIsSidebar();
  const { readonly } = useNodeRenderContext();

  return (
    <>
      <FormHeader />
      <FormContent>
        {isSidebar ? (
          <LocalizedAssignRows name="assign" readonly={readonly} />
        ) : (
          <DisplayOutputs displayFromScope />
        )}
      </FormContent>
    </>
  );
};

export const formMeta: FormMeta = {
  render: (props) => <FormRender {...props} />,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    title: ({ value }: { value: string }) => (value ? undefined : '标题不能为空'),
    assign: ({ value }: { value?: VariableNodeJSON['data']['assign'] }) => {
      if (!Array.isArray(value) || value.length === 0) return '至少需要设置一个变量';
      for (const row of value) {
        if (row.operator === 'declare') {
          const name = String(row.left || '');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            return '变量名需以字母或下划线开头，仅包含字母、数字和下划线';
          }
        } else {
          const target = row.left?.content;
          if (!Array.isArray(target) || target.length !== 2) return '请选择一个顶层目标变量';
        }
        if (!row.right?.type) return '变量值不能为空';
      }
      const outputNames = value.map((row, index) =>
        row.operator === 'declare' ? String(row.left || '') : `assigned_${index + 1}`,
      );
      return new Set(outputNames).size === outputNames.length ? undefined : '变量名称不能重复';
    },
    'assign.*': ({ value }: { value?: VariableNodeJSON['data']['assign'][number] }) => {
      if (!value) return '变量配置不能为空';
      if (value.operator === 'declare') {
        const name = String(value.left || '');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          return '变量名需以字母或下划线开头，仅包含字母、数字和下划线';
        }
      } else {
        const target = value.left?.content;
        if (!Array.isArray(target) || target.length !== 2) return '请选择一个顶层目标变量';
      }
      return value.right?.type ? undefined : '变量值不能为空';
    },
  },
  effect: defaultFormMeta.effect,
  plugins: [
    createInferAssignPlugin({
      assignKey: 'assign',
      outputKey: 'outputs',
    }),
  ],
};
