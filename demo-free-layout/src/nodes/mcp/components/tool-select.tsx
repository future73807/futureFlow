/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useState } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { Select } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface ToolOption {
  name: string;
  description: string;
}

export function ToolSelect() {
  const { readonly, node } = useNodeRenderContext();
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const serverId = (node.form?.values as any)?.serverId;

  useEffect(() => {
    setTools([]);
    setLoadError(null);
    if (!serverId) return;
    let cancelled = false;
    setLoading(true);
    apiJson<ToolOption[]>(`/mcp/servers/${serverId}/tools`, { method: 'POST' })
      .then((list) => {
        if (!cancelled) setTools(list);
      })
      .catch((error: any) => {
        if (!cancelled) setLoadError(error?.message || '工具列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <Field<string> name="tool" defaultValue="">
      {({ field, fieldState }) => (
        <FormItem name="工具" required vertical type="string">
          <Select
            value={field.value || undefined}
            placeholder={!serverId
              ? '先选择 MCP 服务器'
              : loading
                ? '正在加载工具列表…'
                : '选择要调用的工具'}
            style={{ width: '100%' }}
            size="small"
            disabled={readonly || !serverId}
            showClear
            optionList={tools.map((item) => ({
              label: item.description ? `${item.name} — ${item.description}` : item.name,
              value: item.name,
            }))}
            onChange={(value) => field.onChange(String(value || ''))}
          />
          {!serverId || tools.length > 0 || loadError ? null : (
            <Feedback errors={fieldState?.errors} />
          )}
          {loadError && (
            <Feedback errors={[{ name: 'tools', message: loadError } as any]} />
          )}
        </FormItem>
      )}
    </Field>
  );
}
