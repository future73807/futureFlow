/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import {
  IFlowTemplateValue,
} from '@flowgram.ai/form-materials';
import { Select, Typography } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem, PromptEditorBoundary } from '../../../form-components';

const BODY_TYPE_OPTIONS = [
  {
    label: '无请求体',
    value: 'none',
  },
  {
    label: 'JSON',
    value: 'JSON',
  },
  {
    label: '纯文本',
    value: 'raw-text',
  },
];

export function Body() {
  const { readonly } = useNodeRenderContext();

  const renderBodyEditor = (bodyType: string) => {
    switch (bodyType) {
      case 'JSON':
        return (
          <Field<IFlowTemplateValue>
            name="body.json"
            defaultValue={{ type: 'template', content: '' }}
          >
            {({ field, fieldState }) => (
              <>
                <PromptEditorBoundary
                  value={field.value}
                  readonly={readonly}
                  hasError={Boolean(fieldState?.errors?.length)}
                  placeholder="输入 JSON；可在下方插入上游变量"
                  helperText="发布前会校验 JSON 格式"
                  minRows={4}
                  maxRows={12}
                  onChange={field.onChange}
                />
                <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
              </>
            )}
          </Field>
        );
      case 'raw-text':
        return (
          <Field<IFlowTemplateValue>
            name="body.json"
            defaultValue={{ type: 'template', content: '' }}
          >
            {({ field, fieldState }) => (
              <>
                <PromptEditorBoundary
                  readonly={readonly}
                  hasError={Boolean(fieldState?.errors?.length)}
                  placeholder="输入文本；可在下方插入上游变量"
                  minRows={3}
                  maxRows={10}
                  value={field.value}
                  onChange={field.onChange}
                />
                <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
              </>
            )}
          </Field>
        );
      default:
        return null;
    }
  };

  return (
    <Field<string> name="api.method" defaultValue="GET">
      {({ field: methodField }) => {
        const method = String(methodField.value || 'GET').toUpperCase();
        const bodyDisabled = method === 'GET' || method === 'HEAD';
        return (
          <Field<string> name="body.bodyType" defaultValue="none">
            {({ field }) => (
              <div style={{ marginTop: 5 }}>
                <FormItem name="请求体" vertical type="object">
                  <Select
                    value={bodyDisabled ? 'none' : field.value}
                    onChange={(value) => {
                      field.onChange(value as string);
                    }}
                    style={{ width: '100%', marginBottom: bodyDisabled ? 4 : 10 }}
                    disabled={readonly || bodyDisabled}
                    size="small"
                    optionList={BODY_TYPE_OPTIONS}
                  />
                  {bodyDisabled ? (
                    <Typography.Text type="tertiary" size="small">
                      {method} 请求不会发送请求体
                    </Typography.Text>
                  ) : renderBodyEditor(field.value)}
                </FormItem>
              </div>
            )}
          </Field>
        );
      }}
    </Field>
  );
}
