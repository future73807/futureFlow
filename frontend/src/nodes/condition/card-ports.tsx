/**
 * 折叠卡片上的分支输出端口。
 *
 * 条件分支 / 多条件分支的 if、else 端口来自表单里的 ConditionPort 标记，而表单渲染在
 * 右侧配置面板（独立 portal）中，不在节点 DOM 内；FlowGram 的 updateDynamicPorts 只扫描
 * 节点自身的 DOM，因此折叠状态下卡片一个输出端口都没有，画布上无法拉线到下游。
 *
 * 这里把同一组 data-port-id / data-port-type 标记渲染进卡片，并在分支数量变化时刷新
 * 动态端口，让分支节点在画布上可以直接连线。
 */

import { useLayoutEffect } from 'react';

import { FieldArray, WorkflowNodePortsData } from '@flowgram.ai/free-layout-editor';

import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { CardPortDot, CardPortLabel, CardPortList, CardPortRow } from './card-ports-styles';

export interface BranchPortItem {
  /** 端口 id，必须与表单里 ConditionPort 的 data-port-id 完全一致 */
  key: string;
  /** 卡片上展示的分支名 */
  label: string;
}

const CardPorts = ({ items }: { items: BranchPortItem[] }) => {
  const { node } = useNodeRenderContext();
  const signature = items.map((item) => item.key).join('|');

  useLayoutEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      node.getData<WorkflowNodePortsData>(WorkflowNodePortsData)?.updateDynamicPorts();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [node, signature]);

  if (items.length === 0) return null;

  return (
    <CardPortList className="ff-branch-ports">
      {items.map((item) => (
        <CardPortRow key={item.key} className="ff-branch-port-row">
          <CardPortLabel title={item.label}>{item.label}</CardPortLabel>
          <CardPortDot data-port-id={item.key} data-port-type="output" />
        </CardPortRow>
      ))}
    </CardPortList>
  );
};

/** 条件分支：conditions[].key + else */
export function ConditionCardPorts() {
  const isSidebar = useIsSidebar();
  if (isSidebar) return null;
  return (
    <FieldArray name="conditions">
      {({ field }) => (
        <CardPorts
          items={[
            ...field.map((child, index) => {
              const item = child.value as { key?: string } | undefined;
              return {
                key: String(item?.key ?? ''),
                label: `如果 ${index + 1}`,
              };
            }),
            { key: 'else', label: '否则' },
          ]}
        />
      )}
    </FieldArray>
  );
}

/** 多条件分支：branch 的字段名（branch.0、branch.1 …）+ else */
export function MultiConditionCardPorts() {
  const isSidebar = useIsSidebar();
  if (isSidebar) return null;
  return (
    <FieldArray name="branch">
      {({ field }) => (
        <CardPorts
          items={[
            ...field.map((child, index) => ({
              key: child.name,
              label: `如果 ${index + 1}`,
            })),
            { key: 'else', label: '否则' },
          ]}
        />
      )}
    </FieldArray>
  );
}
