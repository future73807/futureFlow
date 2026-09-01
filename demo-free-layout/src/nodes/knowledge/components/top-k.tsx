/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { InputNumber } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';

export function TopK() {
  const { readonly } = useNodeRenderContext();

  return (
    <Field<number> name="topK" defaultValue={4}>
      {({ field, fieldState }) => (
        <FormItem name="返回数量" vertical type="integer">
          <InputNumber
            value={field.value}
            min={1}
            max={10}
            step={1}
            precision={0}
            style={{ width: '100%' }}
            disabled={readonly}
            onChange={(value) => field.onChange(Number(value || 4))}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
        </FormItem>
      )}
    </Field>
  );
}
