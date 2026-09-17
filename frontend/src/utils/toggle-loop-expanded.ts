/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FlowNodeRenderData, WorkflowNodeEntity } from '@flowgram.ai/free-layout-editor';

/**
 * 循环节点的展开/收缩（参考图：循环是一个单独的节点，可以展开和收缩）。
 *
 * 收缩时把循环体（框内节点 + 连线）隐藏，展开时恢复。
 * 不用容器的 transform.collapsed：collapsed 会把子节点从渲染树摘除，
 * 容器 bounds 随之退化成空矩形，节点 DOM 会跳到世界原点附近。
 * 这里用 visibility 直接隐藏子节点渲染层：子节点仍在渲染树里，
 * bounds 保持收缩前的包围盒，卡片位置纹丝不动。
 */
export function toggleLoopExpanded(
  node: WorkflowNodeEntity,
  expanded: boolean = !node.renderData.expanded
) {
  // 隐藏/显示循环体子节点（含框线上的连接圆点）
  node.blocks.forEach((block) => {
    const renderData = block.getData(FlowNodeRenderData);
    if (renderData.node) {
      renderData.node.style.visibility = expanded ? '' : 'hidden';
    }
  });

  // 隐藏/显示循环体子节点连线
  node.blocks.forEach((block) => {
    block.lines.allLines.forEach((line) => {
      line.updateUIState({
        style: {
          ...line.uiState.style,
          display: !expanded ? 'none' : 'block',
        },
      });
    });
  });
}
