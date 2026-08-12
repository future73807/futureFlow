import React, { FC, useMemo, useState } from 'react';
import { IconApps, IconSearch } from '@douyinfe/semi-icons';
import { Input } from '@douyinfe/semi-ui';
import {
  useClientContext,
  WorkflowNodeEntity,
  WorkflowPortEntity,
} from '@flowgram.ai/free-layout-editor';
import { NodePanelRenderProps } from '@flowgram.ai/free-node-panel-plugin';
import './node-list.css';
import { canContainNode } from '../../utils';
import { FlowNodeRegistry } from '../../typings';
import { nodeRegistries } from '../../nodes';
import { NodeDescriptions, NodeLabels } from '../../nodes/labels';
import { getUser } from '../../utils/auth';

interface NodeProps {
  label: string;
  description: string;
  icon?: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  disabled: boolean;
  availability?: string;
}

const TEMPORARILY_UNAVAILABLE_TYPES = new Set(['continue', 'break']);
const PROFESSIONAL_NODE_TYPES = new Set(['http', 'code', 'loop']);

const NodeIcon = ({ icon }: { icon?: string }) => {
  const [imageFailed, setImageFailed] = useState(!icon);

  if (imageFailed) {
    return <IconApps aria-hidden="true" />;
  }

  return (
    <img
      alt=""
      className="canvas-node-icon-image"
      src={icon}
      onError={() => setImageFailed(true)}
    />
  );
};

function Node(props: NodeProps) {
  return (
    <button
      className="canvas-node-option"
      data-testid={'demo-free-node-list-' + props.label}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="canvas-node-icon" aria-hidden="true">
        <NodeIcon icon={props.icon} />
      </span>
      <span className="canvas-node-option-copy">
        <span className="canvas-node-option-title">
          <strong>{props.label}</strong>
          {props.availability && <em>{props.availability}</em>}
        </span>
        <small>{props.description}</small>
      </span>
    </button>
  );
}

interface NodeListProps {
  onSelect: NodePanelRenderProps['onSelect'];
  fromPort?: WorkflowPortEntity;
  containerNode?: WorkflowNodeEntity;
}

export const NodeList: FC<NodeListProps> = ({ onSelect, containerNode }) => {
  const context = useClientContext();
  const [keyword, setKeyword] = useState('');
  const vipLevel = getUser()?.vipLevel || 'free';

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>, registry: FlowNodeRegistry) => {
    const nodeJSON = registry.onAdd?.(context);
    if (!nodeJSON) return;

    onSelect({
      nodeType: registry.type as string,
      selectEvent: event,
      nodeJSON,
    });
  };

  const availableRegistries = useMemo(
    () => nodeRegistries
        .filter((registry) => registry.meta.nodePanelVisible !== false)
        .filter((registry) => {
          if (registry.meta.onlyInContainer) {
            return registry.meta.onlyInContainer === containerNode?.flowNodeType;
          }
          if (containerNode && !canContainNode(registry.type, containerNode.flowNodeType)) {
            return false;
          }
          return true;
        }),
    [containerNode],
  );

  const groups = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase('zh-CN');
    const categoryByType: Record<string, string> = {
      llm: '智能与内容',
      text: '智能与内容',
      image: '智能与内容',
      video: '智能与内容',
      http: '扩展能力',
      code: '扩展能力',
      variable: '流程控制',
      condition: '流程控制',
      'multi-condition': '流程控制',
      loop: '流程控制',
      continue: '流程控制',
      break: '流程控制',
      comment: '画布辅助',
      group: '画布辅助',
    };
    const categoryOrder = ['智能与内容', '扩展能力', '流程控制', '画布辅助'];
    const records = availableRegistries.filter((registry) => {
      if (!query) return true;
      const type = registry.type as string;
      return `${NodeLabels[type] || type} ${NodeDescriptions[type] || registry.info?.description || ''}`
        .toLocaleLowerCase('zh-CN')
        .includes(query);
    });

    return categoryOrder
      .map((category) => ({
        category,
        records: records.filter(
          (registry) => (categoryByType[registry.type as string] || '画布辅助') === category,
        ),
      }))
      .filter((group) => group.records.length > 0);
  }, [availableRegistries, keyword]);

  return (
    <div className="canvas-node-panel">
      <div className="canvas-node-panel-head">
        <div>
          <strong>添加节点</strong>
          <span>选择能力并连接到工作流</span>
        </div>
        <Input
          prefix={<IconSearch />}
          placeholder="搜索节点"
          value={keyword}
          showClear
          onChange={setKeyword}
        />
      </div>
      <div className="canvas-node-list">
        {groups.map(({ category, records }) => (
          <section className="canvas-node-group" key={category}>
            <h3>{category}</h3>
            {records.map((registry) => {
          const label = NodeLabels[registry.type as string] || (registry.type as string);
          const temporarilyUnavailable = TEMPORARILY_UNAVAILABLE_TYPES.has(registry.type as string);
          const requiresProfessional = vipLevel === 'free'
            && PROFESSIONAL_NODE_TYPES.has(registry.type as string);
          return (
            <Node
              key={registry.type}
              label={label}
              description={NodeDescriptions[registry.type as string] || registry.info?.description || ''}
              icon={registry.info?.icon}
              availability={temporarilyUnavailable
                ? '暂不可运行'
                : requiresProfessional
                  ? '专业版'
                  : undefined}
              disabled={temporarilyUnavailable
                || requiresProfessional
                || !(registry.canAdd?.(context) ?? true)}
              onClick={(event) => handleClick(event, registry)}
            />
          );
            })}
          </section>
        ))}
        {groups.length === 0 && (
          <div className="canvas-node-empty">没有找到相关节点</div>
        )}
      </div>
    </div>
  );
};
