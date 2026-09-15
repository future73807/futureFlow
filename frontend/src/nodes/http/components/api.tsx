/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { IFlowTemplateValue } from '@flowgram.ai/form-materials';
import { Select } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem, PromptEditorBoundary } from '../../../form-components';

export function Api() {
  const { readonly } = useNodeRenderContext();

  return (
    <div>
      <FormItem name="请求地址" required vertical type="string">
        <div style={{ display: 'flex', gap: 5 }}>
          <Field<string> name="api.method" defaultValue="GET">
            {({ field }) => (
              <Select
                value={field.value}
                onChange={(value) => {
                  field.onChange(value as string);
                }}
                style={{ width: 85, maxWidth: 85, minWidth: 85 }}
                size="small"
                disabled={readonly}
                optionList={[
                  { label: 'GET', value: 'GET' },
                  { label: 'POST', value: 'POST' },
                  { label: 'PUT', value: 'PUT' },
                  { label: 'DELETE', value: 'DELETE' },
                  { label: 'PATCH', value: 'PATCH' },
                  { label: 'HEAD', value: 'HEAD' },
                ]}
              />
            )}
          </Field>

          <Field<IFlowTemplateValue>
            name="api.url"
            defaultValue={{ type: 'template', content: '' }}
          >
            {({ field, fieldState }) => (
              <div style={{ display: 'grid', flexGrow: 1 }}>
                <PromptEditorBoundary
                  readonly={readonly}
                  hasError={Boolean(fieldState?.errors?.length)}
                  placeholder="输入 URL；可在下方插入上游变量"
                  minRows={1}
                  maxRows={4}
                  value={field.value}
                  onChange={field.onChange}
                />
                <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
              </div>
            )}
          </Field>
        </div>
      </FormItem>
    </div>
  );
}
