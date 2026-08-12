/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { InputNumber } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';

export function Timeout() {
  const { readonly } = useNodeRenderContext();

  return (
    <div>
      <FormItem name="超时时间（毫秒）" required style={{ flex: 1 }} type="number">
        <Field<number> name="timeout.timeout" defaultValue={10000}>
          {({ field, fieldState }) => (
            <>
              <InputNumber
                size="small"
                value={field.value}
                onChange={(value) => {
                  field.onChange(value as number);
                }}
                disabled={readonly}
                validateStatus={fieldState?.errors?.length ? 'error' : undefined}
                style={{ width: '100%' }}
                min={1}
                max={120000}
              />
              <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
            </>
          )}
        </Field>
      </FormItem>
      <FormItem name="网络失败重试次数" required type="number">
        <Field<number> name="timeout.retryTimes" defaultValue={1}>
          {({ field, fieldState }) => (
            <>
              <InputNumber
                size="small"
                value={field.value}
                onChange={(value) => {
                  field.onChange(value as number);
                }}
                disabled={readonly}
                validateStatus={fieldState?.errors?.length ? 'error' : undefined}
                style={{ width: '100%' }}
                min={0}
                max={10}
              />
              <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
            </>
          )}
        </Field>
      </FormItem>
    </div>
  );
}
