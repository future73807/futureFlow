/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { VariableSelector } from '@flowgram.ai/form-materials';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';

export function QueryRef() {
  const { readonly } = useNodeRenderContext();

  return (
    <Field<{ type: 'ref'; content: string[] }>
      name="queryValue"
      defaultValue={{ type: 'ref', content: [] }}
    >
      {({ field, fieldState }) => (
        <FormItem name="检索语句" required vertical type="ref">
          <VariableSelector
            style={{ width: '100%' }}
            value={field.value?.content || []}
            readonly={readonly}
            hasError={Boolean(fieldState?.errors?.length)}
            config={{ placeholder: '引用开始节点输入或上游节点的输出' }}
            onChange={(value) => field.onChange({ type: 'ref', content: value || [] })}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
        </FormItem>
      )}
    </Field>
  );
}
