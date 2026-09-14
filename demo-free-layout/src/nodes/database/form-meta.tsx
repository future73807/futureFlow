/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { Input, TextArea } from '@douyinfe/semi-ui';

import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';
import { FormHeader, FormContent, FormItem, Feedback } from '../../form-components';
import { useNodeRenderContext } from '../../hooks';

function ConnectionFields() {
  const { readonly } = useNodeRenderContext();
  return (
    <div style={{ display: 'grid', gap: 8, width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 8 }}>
        <Field<string> name="connection.host" defaultValue="localhost">
          {({ field, fieldState }) => (
            <FormItem name="主机" required vertical>
              <Input
                value={field.value}
                placeholder="localhost"
                disabled={readonly}
                onChange={(v) => field.onChange(v)}
              />
              <Feedback errors={fieldState?.errors} />
            </FormItem>
          )}
        </Field>
        <Field<number> name="connection.port" defaultValue={5432}>
          {({ field, fieldState }) => (
            <FormItem name="端口" required vertical>
              <Input
                value={String(field.value ?? 5432)}
                placeholder="5432"
                disabled={readonly}
                onChange={(v) => field.onChange(Number(v) || 5432)}
              />
              <Feedback errors={fieldState?.errors} />
            </FormItem>
          )}
        </Field>
      </div>
      <Field<string> name="connection.username">
        {({ field, fieldState }) => (
          <FormItem name="用户名" required vertical>
            <Input
              value={field.value ?? ''}
              placeholder="数据库用户名"
              disabled={readonly}
              onChange={(v) => field.onChange(v)}
            />
            <Feedback errors={fieldState?.errors} />
          </FormItem>
        )}
      </Field>
      <Field<string> name="connection.password">
        {({ field, fieldState }) => (
          <FormItem name="密码" vertical description="仅用于本次查询请求，不会被保存">
            <Input
              value={field.value ?? ''}
              placeholder="数据库密码"
              type="password"
              mode="password"
              disabled={readonly}
              onChange={(v) => field.onChange(v)}
            />
            <Feedback errors={fieldState?.errors} />
          </FormItem>
        )}
      </Field>
      <Field<string> name="connection.database">
        {({ field, fieldState }) => (
          <FormItem name="数据库名" required vertical>
            <Input
              value={field.value ?? ''}
              placeholder="database"
              disabled={readonly}
              onChange={(v) => field.onChange(v)}
            />
            <Feedback errors={fieldState?.errors} />
          </FormItem>
        )}
      </Field>
    </div>
  );
}

export const FormRender = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <ConnectionFields />
      <Field<{ type: string; content: string }> name="sqlValue">
        {({ field, fieldState }) => (
          <FormItem
            name="SQL 查询"
            required
            vertical
            description="仅支持单条 SELECT/WITH 只读查询；可用 {{变量}} 引用上游结果，最多返回 200 行"
          >
            <TextArea
              value={field.value?.content ?? ''}
              placeholder={'SELECT id, title FROM public.items LIMIT 10'}
              rows={5}
              style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace', fontSize: 12 }}
              onChange={(v: string) => field.onChange({ type: 'template', content: v })}
            />
            <Feedback errors={fieldState?.errors} />
          </FormItem>
        )}
      </Field>
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  ...defaultFormMeta,
  render: (props) => <FormRender {...props} />,
  validate: {
    ...defaultFormMeta.validate,
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    sqlValue: ({ value, formValues }: { value: any; formValues: any }) => {
      const sql = String(value?.content ?? '').trim();
      if (!sql) return '请输入 SQL 查询语句';
      if (!/^(select|with)\b/i.test(sql)) return '仅支持 SELECT / WITH 只读查询';
      if (/;/.test(sql.replace(/;\s*$/, ''))) return '一次只能执行一条查询语句';
      const conn = formValues?.connection || {};
      if (!String(conn.host || '').trim()) return '请填写数据库主机';
      if (!String(conn.username || '').trim()) return '请填写数据库用户名';
      if (!String(conn.database || '').trim()) return '请填写数据库名';
      return undefined;
    },
  },
};