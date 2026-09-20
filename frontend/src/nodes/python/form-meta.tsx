/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { TextArea } from '@douyinfe/semi-ui';
import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';
import { FormHeader, FormContent, FormItem, Feedback } from '../../form-components';
import { useNodeRenderContext } from '../../hooks';

export const FormRender = ({ form }: FormRenderProps<FlowNodeJSON>) => {
  const { readonly } = useNodeRenderContext();
  return (
    <>
      <FormHeader />
      <FormContent>
        <Field<{ type: string; content: string }> name="codeValue">
          {({ field, fieldState }) => (
            <FormItem
              name="Python 代码"
              required
              vertical
              description="必须定义 main(params) 并返回一个可 JSON 序列化的对象；params 是本次运行的工作流输入（开始节点声明的字段）；在本机 Python 3 中执行，15 秒超时"
            >
              <TextArea
                value={field.value?.content ?? ''}
                placeholder={'def main(params):\n    return {"hello": "world"}'}
                rows={9}
                style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace', fontSize: 12 }}
                disabled={readonly}
                onChange={(v: string) => field.onChange({ type: 'template', content: v })}
              />
              <Feedback errors={fieldState?.errors} />
            </FormItem>
          )}
        </Field>
      </FormContent>
    </>
  );
};

export const formMeta: FormMeta = {
  ...defaultFormMeta,
  render: (props) => <FormRender {...props} />,
  validate: {
    ...defaultFormMeta.validate,
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    codeValue: ({ value }: { value: any }) => {
      const code = String(value?.content ?? '');
      if (!code.trim()) return '请输入 Python 代码';
      if (!/\bdef\s+main\s*\(/.test(code)) return '必须定义 main(params) 函数';
      return undefined;
    },
  },
};