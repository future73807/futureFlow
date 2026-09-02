/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useLayoutEffect, useState } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { Select, Toast } from '@douyinfe/semi-ui';

import { useNodeRenderContext } from '../../../hooks';
import { Feedback, FormItem } from '../../../form-components';
import { apiJson } from '../../../utils/api';

interface ServerOption {
  id: string;
  name: string;
  url: string;
}

export function ServerSelect() {
  const { readonly } = useNodeRenderContext();
  const [servers, setServers] = useState<ServerOption[] | null>(null);
  const [loading, setLoading] = useState(true);

  useLayoutEffect(() => {
    let cancelled = false;
    apiJson<ServerOption[]>('/mcp/servers')
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      .catch((error: any) => Toast.error(error?.message || 'MCP 服务器列表加载失败'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Field<string> name="serverId" defaultValue="">
      {({ field, fieldState }) => (
        <FormItem name="MCP 服务器" required vertical type="string">
          <Select
            value={field.value || undefined}
            placeholder={loading ? '正在加载 MCP 服务器…' : '选择已注册的 MCP 服务器'}
            style={{ width: '100%' }}
            size="small"
            disabled={readonly}
            showClear
            optionList={(servers || []).map((item) => ({
              label: `${item.name}（${item.url}）`,
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
