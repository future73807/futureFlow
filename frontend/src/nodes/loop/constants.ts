/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeEntity } from '@flowgram.ai/free-layout-editor';

/**
 * 循环节点的几何常量。
 *
 * 整体结构（对齐参考图）：
 *
 *   ┌──────────┐ ← 白色循环卡片（DOM 顶部水平居中）
 *   │  循环     │
 *   └──────────┘
 *        │      ← 竖向连线（LOOP_BODY_GAP 高，卡片底 → 框顶，恒定）
 *   ┌··┌─┴──────┐··┐
 *   │○ │ 子节点  │  │ ← 循环体虚线框（DOM 即 bounds）
 *   └··└────────┘··┘
 *
 * 容器 bounds = 子节点包围盒 + padding。为了让「DOM 与循环体框重合」：
 *  - padding 上下撑出卡片、连线和框底外扩的空间；
 *  - padding 左右为 0，框的左右边界由钉在框线上的连接圆点
 *    （block-start / block-end，0×0 尺寸）把 bounds 拉到
 *    内容包围盒 ± LOOP_BODY_MARGIN.left/right。
 *
 * 卡片 / 框 / 竖线全部是 DOM 内的纯 CSS 定位（相对 bounds 左上角），
 * 不再做世界坐标锚点补偿——拖动体内节点时框自动伸缩，卡片跟随
 * 框水平居中（与 Coze 子画布行为一致）。
 */

/** 循环卡片宽度（对齐参考图，略宽于普通节点卡片） */
export const LOOP_CARD_WIDTH = 290;
/** 循环卡片高度：标题栏 + 输入/中间变量/输出三行 */
export const LOOP_CARD_HEIGHT = 146;
/** 卡片底部到循环体框顶部的距离（竖向连线区） */
export const LOOP_BODY_GAP = 74;
/** 循环体框相对体内节点包围盒的外扩边距（左右由圆点钉位实现） */
export const LOOP_BODY_MARGIN = { top: 32, bottom: 54, left: 96, right: 96 };
/**
 * 容器 padding：上 = 卡片 + 连线 + 框顶外扩；下 = 框底外扩；
 * 左右为 0（框的左右边界由圆点钉位撑出，见文件头注释）。
 */
export const LOOP_BODY_PADDING = {
  top: LOOP_CARD_HEIGHT + LOOP_BODY_GAP + LOOP_BODY_MARGIN.top,
  bottom: LOOP_BODY_MARGIN.bottom,
  left: 0,
  right: 0,
};

/** 循环体框的世界坐标矩形（渲染层钉位圆点时写入，selectable 判定用） */
export interface LoopFrameRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 循环卡片的世界坐标锚点（卡片左上角）。
 *
 * 卡片代表「循环节点」本身，钉在世界坐标上：拖动体内节点时只有循环体框
 * 跟着内容伸缩，卡片原地不动（对齐 Coze：循环卡片与子画布解耦）。
 * 只有拖动循环节点本身（拖卡片/框内空白/多选含循环）时，锚点才跟随
 * 容器 position 的位移同步更新。
 */
export interface LoopCardAnchor {
  x: number;
  y: number;
}

const frameRects = new WeakMap<WorkflowNodeEntity, LoopFrameRect>();
const cardAnchors = new WeakMap<WorkflowNodeEntity, LoopCardAnchor>();

export const getLoopFrameRect = (node: WorkflowNodeEntity): LoopFrameRect | undefined =>
  frameRects.get(node);

export const setLoopFrameRect = (node: WorkflowNodeEntity, rect: LoopFrameRect | undefined) => {
  if (rect) {
    frameRects.set(node, rect);
  } else {
    frameRects.delete(node);
  }
  // 调试/测试钩子：浏览器控制台可通过 __loopFrameRects[节点id] 读当前框数据
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, Record<string, LoopFrameRect | undefined>>;
    w.__loopFrameRects = w.__loopFrameRects || {};
    w.__loopFrameRects[node.id] = rect;
  }
};

export const getLoopCardAnchor = (node: WorkflowNodeEntity): LoopCardAnchor | undefined =>
  cardAnchors.get(node);

export const setLoopCardAnchor = (node: WorkflowNodeEntity, anchor: LoopCardAnchor) => {
  cardAnchors.set(node, { x: anchor.x, y: anchor.y });
};
