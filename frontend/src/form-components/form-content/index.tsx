/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import React from 'react';

import { FlowNodeRegistry } from '@flowgram.ai/free-layout-editor';

import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { NodeSummary } from '../node-summary';
import { FormTitleDescription, FormWrapper } from './styles';

/**
 * @param props
 * @constructor
 */
export function FormContent(props: { children?: React.ReactNode }) {
  const { node, expanded } = useNodeRenderContext();
  const isSidebar = useIsSidebar();
  const registry = node.getNodeRegistry<FlowNodeRegistry>();
  // 循环节点折叠时也要显示卡片（收缩只隐藏循环体），不走通用摘要
  const isLoop = node.flowNodeType === 'loop';
  return (
    <FormWrapper className="ff-form-wrapper">
      <>
        {isSidebar && <FormTitleDescription>{registry.info?.description}</FormTitleDescription>}
        {!isSidebar && !expanded && !isLoop && <NodeSummary />}
        {(expanded || isSidebar || isLoop) && props.children}
      </>
    </FormWrapper>
  );
}
