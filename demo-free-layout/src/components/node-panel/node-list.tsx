import React, { FC, useState } from 'react';
import { IconApps } from '@douyinfe/semi-icons';
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
import { NodeLabels } from '../../nodes/labels';

interface NodeProps {
  label: string;
  icon?: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  disabled: boolean;
}

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
      <span>{props.label}</span>
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

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>, registry: FlowNodeRegistry) => {
    const nodeJSON = registry.onAdd?.(context);
    if (!nodeJSON) return;

    onSelect({
      nodeType: registry.type as string,
      selectEvent: event,
      nodeJSON,
    });
  };

  return (
    <div className="canvas-node-list">
      {nodeRegistries
        .filter((registry) => registry.meta.nodePanelVisible !== false)
        .filter((registry) => {
          if (registry.meta.onlyInContainer) {
            return registry.meta.onlyInContainer === containerNode?.flowNodeType;
          }
          if (containerNode && !canContainNode(registry.type, containerNode.flowNodeType)) {
            return false;
          }
          return true;
        })
        .map((registry) => {
          const label = NodeLabels[registry.type as string] || (registry.type as string);
          return (
            <Node
              key={registry.type}
              label={label}
              icon={registry.info?.icon}
              disabled={!(registry.canAdd?.(context) ?? true)}
              onClick={(event) => handleClick(event, registry)}
            />
          );
        })}
    </div>
  );
};
