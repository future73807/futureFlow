/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { TypeScriptCodeEditor } from '@flowgram.ai/form-materials';
import { Divider, Tag, Typography } from '@douyinfe/semi-ui';

import { useIsSidebar, useNodeRenderContext } from '../../../hooks';

export function Code() {
  const isSidebar = useIsSidebar();
  const { readonly } = useNodeRenderContext();

  if (!isSidebar) {
    return null;
  }

  return (
    <>
      <Divider />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text strong>运行语言</Typography.Text>
        <Tag color="violet">JavaScript</Tag>
      </div>
      <Typography.Paragraph type="tertiary" style={{ margin: '0 0 10px', fontSize: 12 }}>
        请使用同步 function main，输入通过 params 读取；仅支持标准 JavaScript，请勿使用 TypeScript 类型标注。Python 将在云端沙箱能力完善后开放。
      </Typography.Paragraph>
      <Field<string> name="script.content">
        {({ field }) => (
          <TypeScriptCodeEditor
            value={field.value}
            onChange={(value) => field.onChange(value)}
            readonly={readonly}
          />
        )}
      </Field>
    </>
  );
}
