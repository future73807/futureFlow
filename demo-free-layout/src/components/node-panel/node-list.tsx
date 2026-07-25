/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import React, { FC } from 'react';

import styled from 'styled-components';
import { NodePanelRenderProps } from '@flowgram.ai/free-node-panel-plugin';
import {
  useClientContext,
  WorkflowNodeEntity,
  WorkflowPortEntity,
} from '@flowgram.ai/free-layout-editor';

import { canContainNode } from '../../utils';
import { FlowNodeRegistry } from '../../typings';
import { nodeRegistries } from '../../nodes';
import { NodeLabels } from '../../nodes/labels';

const NodeWrap = styled.div`
  width: 100%;
  min-height: 44px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 16px;
  padding: 8px 12px;
  color: #344054;
  transition: background-color .15s ease, color .15s ease;
  &:hover {
    background-color: #eef1ff;
    color: #4054bf;
  }
`;

const NodeLabel = styled.div`
  font-size: 13px;
  font-weight: 500;
  margin-left: 11px;
`;

interface NodeProps {
  label: string;
  icon: JSX.Element;
  onClick: React.MouseEventHandler<HTMLDivElement>;
  disabled: boolean;
}

function Node(props: NodeProps) {
  return (
    <NodeWrap
      data-testid={`demo-free-node-list-${props.label}`}
      onClick={props.disabled ? undefined : props.onClick}
      style={props.disabled ? { opacity: 0.3 } : {}}
    >
      <div style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{props.icon}</div>
      <NodeLabel>{props.label}</NodeLabel>
    </NodeWrap>
  );
}

const NodesWrap = styled.div`
  width: 260px;
  max-height: min(520px, 65vh);
  padding: 6px;
  overflow: auto;
  &::-webkit-scrollbar {
    display: none;
  }
`;

interface NodeListProps {
  onSelect: NodePanelRenderProps['onSelect'];
  fromPort?: WorkflowPortEntity; // 从哪个端口添加 From which port to add
  containerNode?: WorkflowNodeEntity;
}

export const NodeList: FC<NodeListProps> = (props) => {
  const { onSelect, containerNode } = props;
  const context = useClientContext();
  const handleClick = (e: React.MouseEvent, registry: FlowNodeRegistry) => {
    const json = registry.onAdd?.(context);
    onSelect({
      nodeType: registry.type as string,
      selectEvent: e,
      nodeJSON: json,
    });
  };
  return (
    <NodesWrap>
      {nodeRegistries
        .filter((register) => register.meta.nodePanelVisible !== false)
        .filter((register) => {
          if (register.meta.onlyInContainer) {
            return register.meta.onlyInContainer === containerNode?.flowNodeType;
          }
          /**
           * 循环节点无法嵌套循环节点
           * Loop node cannot nest loop node
           */
          if (containerNode && !canContainNode(register.type, containerNode.flowNodeType)) {
            return false;
          }
          return true;
        })
        .map((registry) => (
          <Node
            key={registry.type}
            disabled={!(registry.canAdd?.(context) ?? true)}
            icon={
              <img
                alt=""
                style={{ width: 22, height: 22, borderRadius: 6, objectFit: 'cover', display: 'block' }}
                src={registry.info?.icon}
              />
            }
            label={NodeLabels[registry.type as string] || (registry.type as string)}
            onClick={(e) => handleClick(e, registry)}
          />
        ))}
    </NodesWrap>
  );
};
