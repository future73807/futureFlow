/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { DisplayInputsValues, IFlowValue, InputsValues } from '@flowgram.ai/form-materials';

import { useIsSidebar, useNodeRenderContext } from '../../../hooks';
import { FormItem } from '../../../form-components';
import { promoteTemplateValues } from '../../../utils/flow-value';

export function Inputs() {
  const isSidebar = useIsSidebar();

  const { readonly } = useNodeRenderContext();

  if (!isSidebar) {
    return (
      <Field<Record<string, IFlowValue | undefined> | undefined> name="inputsValues">
        {({ field }) => <DisplayInputsValues value={field.value} />}
      </Field>
    );
  }

  return (
    <FormItem name="输入参数" type="object" vertical>
      <Field<Record<string, IFlowValue | undefined> | undefined> name="inputsValues">
        {({ field }) => (
          <InputsValues
            value={field.value}
            // 手写 {{上游变量}} 时自动升级为模板类型，避免被当成字面量传给代码
            onChange={(value) => field.onChange(promoteTemplateValues(value))}
            readonly={readonly}
          />
        )}
      </Field>
    </FormItem>
  );
}
