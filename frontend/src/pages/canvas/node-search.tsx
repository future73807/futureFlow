/**
 * 顶栏节点搜索：按标题/类型过滤画布节点，选中后滚动居中并选中。
 *
 * 组件挂在画布页顶栏（在编辑器 Provider 之外），因此通过页面持有的
 * FreeLayoutPluginContext 直接取文档与选中服务，而不是 useClientContext。
 */

import { useCallback, useMemo, useState } from 'react';

import {
  FreeLayoutPluginContext,
  WorkflowDocument,
  WorkflowNodeEntity,
  WorkflowSelectService,
} from '@flowgram.ai/free-layout-editor';
import { Input, Popover, Toast } from '@douyinfe/semi-ui';
import { IconSearch } from '@douyinfe/semi-icons';

interface NodeMatch {
  id: string;
  title: string;
  type: string;
}

export const CanvasNodeSearch = ({ context }: { context: FreeLayoutPluginContext | null }) => {
  const [keyword, setKeyword] = useState('');
  const [visible, setVisible] = useState(false);

  const collectMatches = useCallback(
    (raw: string): NodeMatch[] => {
      const query = raw.trim().toLocaleLowerCase('zh-CN');
      if (!query || !context) return [];
      const document = context.get<WorkflowDocument>(WorkflowDocument);
      return (document.getAllNodes() as WorkflowNodeEntity[])
        .filter((node) => {
          const title = String((node.form?.values as any)?.title || '');
          return (
            title.toLocaleLowerCase('zh-CN').includes(query)
            || String(node.flowNodeType || '').toLocaleLowerCase().includes(query)
          );
        })
        .slice(0, 20)
        .map((node) => ({
          id: node.id,
          title: String((node.form?.values as any)?.title || node.id),
          type: String(node.flowNodeType || ''),
        }));
    },
    [context],
  );

  const matches = useMemo(() => collectMatches(keyword), [collectMatches, keyword]);

  const focusNode = (nodeId: string) => {
    if (!context) {
      Toast.warning('编辑器尚未就绪');
      return;
    }
    const document = context.get<WorkflowDocument>(WorkflowDocument);
    const entity = document.getNode(nodeId);
    if (!entity) {
      Toast.error('节点不存在');
      return;
    }
    context.get<WorkflowSelectService>(WorkflowSelectService)
      .selectNodeAndScrollToView(entity as WorkflowNodeEntity);
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
        className="canvas-header-search"
        prefix={<IconSearch />}
        placeholder="搜索节点"
        value={keyword}
        showClear
        disabled={!context}
        onChange={(value) => {
          setKeyword(value);
          setVisible(true);
        }}
        aria-label="搜索画布节点"
      />
    </Popover>
  );
};
