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

/** 入参类型的中文标签：与画布类型系统保持一致 */
const TYPE_LABELS: Record<string, string> = {
  string: '字符串',
  integer: '整数',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
};

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
      {meta.startVariables.map((item) => {
        // 类型约束：数组只能迭代、对象只能取属性，结构性类型不能互相混用，
        // 因此数组/对象入参只列出同类型的上游变量；标量之间仍允许互相引用。
        const expectedType = String(item.type || 'string').toLowerCase();
        const structural = ['array', 'object'].includes(expectedType);
        return (
          <Field<MappingValue> key={item.variable} name={`inputMappings.${item.variable}`}>
            {({ field }) => (
              <FormItem
                name={`入参 · ${item.label}（${TYPE_LABELS[expectedType] || expectedType}）`}
                required
                vertical
                type="ref"
              >
                <VariableSelector
                  style={{ width: '100%' }}
                  value={field.value?.content || []}
                  readonly={readonly}
                  includeSchema={structural ? { type: expectedType, extra: { weak: true } } : undefined}
                  config={{ placeholder: structural ? `选择${TYPE_LABELS[expectedType] || expectedType}类型变量` : '引用上游变量' }}
                  onChange={(value) => field.onChange({ type: 'ref', content: value || [] })}
                />
              </FormItem>
            )}
          </Field>
        );
      })}
      <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
        输出：{meta.endOutputs.length > 0 ? meta.endOutputs.join('、') : '（目标工作流未声明输出）'}
      </Typography.Text>
    </div>
  );
}
