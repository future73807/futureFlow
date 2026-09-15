/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useLayoutEffect, useState } from 'react';

import { useClientContext, Field } from '@flowgram.ai/free-layout-editor';
import { Select, Toast } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface WorkflowOption {
  id: string;
  name: string;
  publishedVersion: number | null;
}

interface SubflowMeta {
  startVariables: Array<{ variable: string; label: string; type: string }>;
  endOutputs: string[];
}

export function TargetWorkflowSelect() {
  const { readonly, node } = useNodeRenderContext();
  const context = useClientContext();
  const [options, setOptions] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);

  useLayoutEffect(() => {
    let cancelled = false;
    apiJson<WorkflowOption[]>('/workflows')
      .then((list) => {
        if (cancelled) return;
        setOptions(list.filter((item) => item.publishedVersion && item.id !== node.id));
      })
      .catch((error: any) => Toast.error(error?.message || '工作流列表加载失败'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context, node.id]);

  return (
    <Field<string> name="targetWorkflowId" defaultValue="">
      {({ field, fieldState }) => (
        <FormItem name="目标工作流" required vertical type="string">
          <Select
            value={field.value || undefined}
            placeholder={loading ? '正在加载已发布工作流…' : '选择要复用的已发布工作流'}
            style={{ width: '100%' }}
            size="small"
            disabled={readonly}
            showClear
            optionList={options.map((item) => ({
              label: `${item.name}（v${item.publishedVersion}）`,
              value: item.id,
            }))}
            onChange={(value) => field.onChange(String(value || ''))}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
        </FormItem>
      )}
    </Field>
  );
}

export type { SubflowMeta };
