/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { Select, Toast, Typography } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface DatasetOption {
  id: string;
  name: string;
  documentCount: number;
}

let cachedDatasets: { list: DatasetOption[]; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

/** 外部（如个人中心）增删知识库后调用，使画布内的下拉缓存失效。 */
export function invalidateDatasetCache(): void {
  cachedDatasets = null;
}

export function DatasetSelect() {
  const { readonly } = useNodeRenderContext();
  const [datasets, setDatasets] = useState<DatasetOption[] | null>(
    cachedDatasets?.list ?? null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cachedDatasets && Date.now() - cachedDatasets.at < CACHE_TTL_MS) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiJson<DatasetOption[]>('/knowledge/datasets')
      .then((list) => {
        cachedDatasets = { list, at: Date.now() };
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
      {({ field, fieldState }) => {
        const value = field.value || '';
        const missing = Boolean(
          value && datasets && !datasets.some((item) => item.id === value),
        );
        return (
          <FormItem name="知识库" required vertical type="string">
            <Select
              value={value || undefined}
              placeholder={loading ? '正在加载知识库…' : '选择要检索的知识库'}
              style={{ width: '100%' }}
              size="small"
              disabled={readonly}
              showClear
              optionList={(datasets || []).map((item) => ({
                label: `${item.name}（${item.documentCount} 个文档）`,
                value: item.id,
              }))}
              onChange={(next) => field.onChange(String(next || ''))}
            />
            {missing && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                所选知识库已被删除或无权访问，请重新选择
              </Typography.Text>
            )}
            {!loading && datasets && datasets.length === 0 && (
              <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
                还没有知识库：请到「个人中心 → 知识库」创建后回到画布刷新本节点。
              </Typography.Text>
            )}
            <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
          </FormItem>
        );
      }}
    </Field>
  );
}
