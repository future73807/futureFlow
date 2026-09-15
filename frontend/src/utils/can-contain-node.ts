/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { type FlowNodeType } from '@flowgram.ai/free-layout-editor';

import { WorkflowNodeType } from '../nodes';

/**
 * 判断父节点是否可以包含对应子节点
 * Determine whether the parent node can contain the corresponding child node
 * @param childNodeType
 * @param parentNodeType
 */
export function canContainNode(
  childNodeType: WorkflowNodeType | FlowNodeType,
  parentNodeType: WorkflowNodeType | FlowNodeType
) {
  /**
   * 数组批处理首期固定为 block-start → 一个代码节点 → block-end。
   * 内置首尾节点由容器自动创建，用户只能编辑中间的同步 JavaScript。
   */
  if (parentNodeType === WorkflowNodeType.Loop) {
    return false;
  }
  /**
   * 开始/结束节点无法更改容器
   * The start and end nodes cannot change container
   */
  if (
    [
      WorkflowNodeType.Start,
      WorkflowNodeType.End,
      WorkflowNodeType.BlockStart,
      WorkflowNodeType.BlockEnd,
    ].includes(childNodeType as WorkflowNodeType)
  ) {
    return false;
  }
  /** 继续/中断尚未纳入数组批处理首期运行语义。 */
  if ([WorkflowNodeType.Continue, WorkflowNodeType.Break].includes(
    childNodeType as WorkflowNodeType
  )) {
    return false;
  }
  /**
   * 循环节点无法嵌套循环节点
   * Loop node cannot nest loop node
   */
  if (childNodeType === WorkflowNodeType.Loop && parentNodeType === WorkflowNodeType.Loop) {
    return false;
  }
  return true;
}
