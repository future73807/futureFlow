/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { TextArea, Typography } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';

export function ArgumentsInput() {
  const { readonly } = useNodeRenderContext();

  return (
    <Field<string> name="argumentsValue" defaultValue="{}">
      {({ field, fieldState }) => (
        <FormItem
          name="工具参数（JSON）"
          vertical
          type="string"
          description="可使用 {{#节点ID.变量#}} 引用上游变量，发布时会原样传入工具调用。"
        >
          <TextArea
            value={field.value ?? '{}'}
            rows={5}
            disabled={readonly}
            placeholder='{"query": "{{#start_0.query#}}"}'
            onChange={(value) => field.onChange(value)}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
          <Typography.Text type="tertiary" style={{ fontSize: 11 }}>
            节点输出 result 为工具返回的 JSON 文本。
          </Typography.Text>
        </FormItem>
      )}
    </Field>
  );
}
