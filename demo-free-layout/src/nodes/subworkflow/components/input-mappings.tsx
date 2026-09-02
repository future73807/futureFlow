/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react';

import { Field, useClientContext } from '@flowgram.ai/free-layout-editor';
import { VariableSelector } from '@flowgram.ai/form-materials';
import { Spin, Typography } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface SubflowMeta {
  startVariables: Array<{ variable: string; label: string; type: string }>;
  endOutputs: string[];
}

interface MappingValue {
  type: 'ref';
  content: string[];
}

/**
 * 参数映射：跟随所选目标工作流的已发布入参契约动态变化；
 * 每个入参必须引用一个上游变量。
 */
export function InputMappings() {
  const { readonly, node } = useNodeRenderContext();
  const context = useClientContext();
  const [meta, setMeta] = useState<SubflowMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const targetId = (node.form?.values as any)?.targetWorkflowId;

  useEffect(() => {
    setMeta(null);
    setLoadError(null);
    if (!targetId) return;
    let cancelled = false;
    setLoading(true);
    apiJson<SubflowMeta>(`/workflows/${targetId}/subflow-meta`)
      .then((data) => {
        if (!cancelled) setMeta(data);
      })
      .catch((error: any) => {
        if (!cancelled) setLoadError(error?.message || '入参契约加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, context]);

  if (!targetId) {
    return (
      <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
        选择目标工作流后，这里会显示需要映射的入参。
      </Typography.Text>
    );
  }
  if (loading) return <Spin size="small" />;
  if (loadError) {
    return (
      <Typography.Text type="danger" style={{ fontSize: 12 }}>
        {loadError}
      </Typography.Text>
    );
  }
  if (!meta) return null;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {meta.startVariables.length === 0 && (
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          目标工作流的开始节点没有入参，无需映射。
        </Typography.Text>
      )}
      {meta.startVariables.map((item) => (
        <Field<MappingValue> key={item.variable} name={`inputMappings.${item.variable}`}>
          {({ field }) => (
            <FormItem name={`入参 · ${item.label}`} required vertical type="ref">
              <VariableSelector
                style={{ width: '100%' }}
                value={field.value?.content || []}
                readonly={readonly}
                config={{ placeholder: '引用上游变量' }}
                onChange={(value) => field.onChange({ type: 'ref', content: value || [] })}
              />
            </FormItem>
          )}
        </Field>
      ))}
      <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
        输出：{meta.endOutputs.length > 0 ? meta.endOutputs.join('、') : '（目标工作流未声明输出）'}
      </Typography.Text>
    </div>
  );
}
