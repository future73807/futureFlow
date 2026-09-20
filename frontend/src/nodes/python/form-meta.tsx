/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { Button, Space, TextArea } from '@douyinfe/semi-ui';
import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';
import { FormHeader, FormContent, FormItem, Feedback } from '../../form-components';
import { useNodeRenderContext } from '../../hooks';

/**
 * 「查询 PostgreSQL（只读）」预置模板。
 *
 * 「SQL 查询」节点已移除（它只能本地试运行、却要手工配连接串，发布后也不可用）。
 * 同样的需求改由本节点承担：驱动（pg8000）随仓库携带、无需 pip install，
 * 见 gateway/vendor/README.md。
 *
 * 这里刻意保留 SQL 节点原有的只读兜底：以 BEGIN READ ONLY 打开事务，任何写操作
 * 都会被 PostgreSQL 拒绝（SQLSTATE 25006: cannot execute ... in a read-only
 * transaction），而不是依赖应用层做字符串匹配。
 */
export const POSTGRES_READONLY_TEMPLATE = `def main(params):
    """只读查询 PostgreSQL。params 是本次运行的工作流输入。

    驱动 pg8000 随平台提供，无需 pip install。
    连接信息请在「开始」节点声明为输入字段（如 dbHost / dbUser / dbName）。
    """
    import pg8000.native

    conn = pg8000.native.Connection(
        user=str(params.get("dbUser", "")),
        password=str(params.get("dbPassword", "")),
        host=str(params.get("dbHost", "127.0.0.1")),
        port=int(params.get("dbPort", 5432)),
        database=str(params.get("dbName", "")),
    )
    try:
        # 只读事务：写入会被 PostgreSQL 拒绝，无需在应用层解析 SQL。
        conn.run("BEGIN READ ONLY")
        rows = conn.run(str(params.get("sql", "SELECT 1 AS ok")))
        conn.run("COMMIT")
    finally:
        conn.close()
    return {"rowCount": len(rows), "rows": [[str(cell) for cell in row] for row in rows]}
`;

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
              <Space vertical align="start" spacing={8} style={{ width: '100%' }}>
                {!readonly && (
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => field.onChange({ type: 'template', content: POSTGRES_READONLY_TEMPLATE })}
                  >
                    插入「查询 PostgreSQL（只读）」模板
                  </Button>
                )}
                <TextArea
                  value={field.value?.content ?? ''}
                  placeholder={'def main(params):\n    return {"hello": "world"}'}
                  rows={9}
                  style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace', fontSize: 12 }}
                  disabled={readonly}
                  onChange={(v: string) => field.onChange({ type: 'template', content: v })}
                />
              </Space>
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
