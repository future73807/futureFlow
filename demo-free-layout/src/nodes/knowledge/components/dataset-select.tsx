/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { Select, Toast } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface DatasetOption {
  id: string;
  name: string;
  documentCount: number;
}

let cachedDatasets: DatasetOption[] | null = null;

export function DatasetSelect() {
  const { readonly } = useNodeRenderContext();
  const [datasets, setDatasets] = useState<DatasetOption[] | null>(cachedDatasets);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cachedDatasets) return;
    let cancelled = false;
    setLoading(true);
    apiJson<DatasetOption[]>('/knowledge/datasets')
      .then((list) => {
        cachedDatasets = list;
        if (!cancelled) setDatasets(list);
      })
      .catch((error: any) => {
        if (!cancelled) Toast.error(error?.message || '知识库列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Field<string> name="datasetId" defaultValue="">
      {({ field, fieldState }) => (
        <FormItem name="知识库" required vertical type="string">
          <Select
            value={field.value || undefined}
            placeholder={loading ? '正在加载知识库…' : '选择要检索的知识库'}
            style={{ width: '100%' }}
            size="small"
            disabled={readonly}
            showClear
            optionList={(datasets || []).map((item) => ({
              label: `${item.name}（${item.documentCount} 个文档）`,
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
