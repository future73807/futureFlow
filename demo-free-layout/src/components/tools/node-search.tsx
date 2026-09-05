/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useMemo, useState } from 'react';

import {
  useClientContext,
  useService,
  WorkflowNodeEntity,
  WorkflowSelectService,
} from '@flowgram.ai/free-layout-editor';
import { Input, Popover, Toast } from '@douyinfe/semi-ui';
import { IconSearch } from '@douyinfe/semi-icons';

/**
 * 画布内节点搜索：按标题/类型过滤，选中后滚动居中并选中节点。
 * 大画布不再需要滚动找节点。滚动与选中复用问题检查面板同一服务。
 */
export const NodeSearch = () => {
  const clientContext = useClientContext();
  const selectService = useService(WorkflowSelectService);
  const [keyword, setKeyword] = useState('');
  const [visible, setVisible] = useState(false);

  const matches = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase('zh-CN');
    if (!query) return [];
    return (clientContext.document.getAllNodes() as WorkflowNodeEntity[])
      .filter((node) => {
        const title = String((node.form?.values as any)?.title || '');
        return title.toLocaleLowerCase('zh-CN').includes(query)
          || String(node.flowNodeType || '').toLocaleLowerCase().includes(query);
      })
      .slice(0, 20)
      .map((node) => ({
        id: node.id,
        title: String((node.form?.values as any)?.title || node.id),
        type: String(node.flowNodeType || ''),
      }));
  }, [clientContext, keyword]);

  const focusNode = (nodeId: string) => {
    const entity = clientContext.document.getNode(nodeId);
    if (!entity) {
      Toast.error('节点不存在');
      return;
    }
    selectService.selectNodeAndScrollToView(entity);
    Toast.success(`已定位：${String((entity.form?.values as any)?.title || nodeId)}`);
  };

  return (
    <Popover
      trigger="custom"
      visible={visible && matches.length > 0}
      onClickOutSide={() => setVisible(false)}
      content={
        <div style={{ maxHeight: 260, overflow: 'auto', minWidth: 220 }}>
          {matches.map((item) => (
            <div
              key={item.id}
              onClick={() => {
                focusNode(item.id);
                setVisible(false);
                setKeyword('');
              }}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 13,
                borderRadius: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ff-primary-soft)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {item.title}
              <span style={{ color: 'var(--ff-subtle)', marginLeft: 8, fontSize: 11 }}>
                {item.type}
              </span>
            </div>
          ))}
        </div>
      }
    >
      <Input
        prefix={<IconSearch />}
        placeholder="搜索节点"
        value={keyword}
        showClear
        style={{ width: 150 }}
        onChange={(value) => {
          setKeyword(value);
          setVisible(true);
        }}
        aria-label="搜索画布节点"
      />
    </Popover>
  );
};
