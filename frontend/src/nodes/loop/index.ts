/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeEntity, PositionSchema } from '@flowgram.ai/free-layout-editor';

import { WorkflowNodeType } from '../constants';
import { createWorkflowNodeId } from '../../utils/node-id';
import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { formMeta } from './form-meta';
import {
  getLoopCardAnchor,
  getLoopFrameRect,
  LOOP_BODY_GAP,
  LOOP_BODY_MARGIN as MARGIN,
  LOOP_BODY_PADDING,
  LOOP_CARD_HEIGHT,
  LOOP_CARD_WIDTH,
} from './constants';

/**
 * 循环节点在画布上的几何（1:1 对齐参考图「数组是用来循环的，不是单独节点」）：
 *
 *  - 循环是一个**单独的紧凑卡片**（标题 + 输入/中间变量/输出三行），
 *    竖直居中于主流水线，可展开/收缩；
 *  - 卡片下方是展开的**循环体**：一个独立的虚线画布框，
 *    随体内节点自动调整大小（批注：类似单独的、可以根据节点改变大小的画布）；
 *  - 循环体里**没有开始/结束节点**，只有框左右两侧中部各一个连接圆点
 *    （block-start / block-end 仅作为圆点的数据载体，不渲染成节点卡片）；
 *  - 卡片底部中心一条竖线连到循环体框顶部。
 *
 * 容器 bounds = 体内节点包围盒 + padding；padding 上下撑出卡片/连线/框底
 * 空间，左右为 0 —— 框的左右边界由钉在框线上的连接圆点撑出（0×0 尺寸）。
 * 节点 DOM 与循环体框重合；卡片钉在世界坐标锚点上（拖动体内节点时卡片
 * 不动，见 LoopCanvasLayer 与 constants.ts）。
 */

/** 体内内容节点（代码节点）相对循环节点左上角的默认落点 */
const LOOP_BODY_ITEM_X = MARGIN.left + 40;
const LOOP_BODY_ITEM_Y = LOOP_CARD_HEIGHT + LOOP_BODY_GAP + MARGIN.top;

let index = 0;
export const LoopNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Loop,
  info: {
    icon: pluginIconUrl('loop'),
    description: '串行处理字符串或数字数组，最多 20 项。',
  },
  meta: {
    copyDisable: true,
    /**
     * 子画布标记：循环体里的节点是 loop 的 blocks
     */
    isContainer: true,
    /**
     * 容器节点的 size 只影响自身盒子（卡片）；整体 bounds 由体内节点 + padding 决定
     */
    size: { width: LOOP_CARD_WIDTH, height: LOOP_CARD_HEIGHT },
    autoResizeDisable: true,
    /**
     * 节点 DOM 与循环体框重合（bounds 大小），本体透明；
     * 白色卡片是 DOM 内 CSS 定位的盒子（顶部水平居中）
     */
    wrapperStyle: {
      minWidth: 'unset',
      width: '100%',
      background: 'transparent',
      borderColor: 'transparent',
      boxShadow: 'none',
    },
    /**
     * 子画布 padding：上 = 卡片 + 连线 + 框顶外扩，下 = 框底外扩，
     * 左右为 0（框的左右边界由钉在框线上的连接圆点撑出）。
     * 框是「只增不减的固定矩形」（见 LoopCanvasLayer）：循环体框 div
     * 由渲染层按框数据显式定位，不依赖这里的 padding 推导；padding
     * 只需保证容器 DOM 盖住框的上方区域即可。
     */
    padding: () => ({ ...LOOP_BODY_PADDING }),
    /**
     * 卡片在 DOM 顶部水平居中（DOM 左右 = 框线），
     * 用百分比 locationConfig + offset 把输入/输出端口钉在卡片左右边缘中部，
     * 这样框随体内节点伸缩时端口始终跟着卡片走。
     */
    defaultPorts: [
      {
        type: 'input',
        location: 'left',
        locationConfig: { left: '50%', top: LOOP_CARD_HEIGHT / 2 },
        offset: { x: -LOOP_CARD_WIDTH / 2, y: 0 },
      },
      {
        type: 'output',
        location: 'right',
        locationConfig: { left: '50%', top: LOOP_CARD_HEIGHT / 2 },
        offset: { x: LOOP_CARD_WIDTH / 2, y: 0 },
      },
    ],
    /**
     * 点击选中判定：白色卡片区域或循环体框内（含空白区）都能选中/拖动
     * 整个循环节点；体内节点是独立 DOM 且渲染在框之上，点到体内节点时
     * 由节点自己的命中处理，不会走到这里。
     */
    selectable(node: WorkflowNodeEntity, mousePos?: PositionSchema): boolean {
      if (!mousePos) {
        return true;
      }
      // 卡片：位置以渲染层维护的世界锚点为准（拖动体内节点时锚点不动）
      const anchor = getLoopCardAnchor(node);
      const cardLeft = anchor?.x;
      const cardTop = anchor?.y;
      if (cardLeft !== undefined && cardTop !== undefined) {
        if (
          mousePos.x >= cardLeft &&
          mousePos.x <= cardLeft + LOOP_CARD_WIDTH &&
          mousePos.y >= cardTop &&
          mousePos.y <= cardTop + LOOP_CARD_HEIGHT
        ) {
          return true;
        }
      }
      // 循环体框（仅展开时存在，矩形由 LoopCanvasLayer 钉位圆点时写入）
      const frame = getLoopFrameRect(node);
      return (
        !!frame &&
        mousePos.x >= frame.left &&
        mousePos.x <= frame.right &&
        mousePos.y >= frame.top &&
        mousePos.y <= frame.bottom
      );
    },
    /**
     * 展开收缩按钮（参考图批注：循环是一个单独的节点，可以展开和收缩）
     */
    expandable: true,
  },
  onAdd() {
    const loopId = createWorkflowNodeId('loop');
    const blockStartId = createWorkflowNodeId('block_start');
    const blockEndId = createWorkflowNodeId('block_end');
    return {
      id: loopId,
      type: WorkflowNodeType.Loop,
      data: {
        title: `循环 ${++index}`,
        // 循环类型：数组循环（默认）/ 指定次数 / 无限循环（受最大轮数保护）
        loopType: 'array',
        loopCount: 3,
        loopMaxRounds: 20,
        loopMiddleValues: {},
        // 循环体默认为空：输出由用户在循环体内添加节点后选择
        loopOutputs: {},
        outputs: {
          type: 'object',
          properties: {},
        },
      },
      // 循环体默认为空画布，只保留框线左右两侧的连接圆点：
      // 用户自行往循环体里添加节点并连线（左圆点 → … → 右圆点）
      blocks: [
        {
          id: blockStartId,
          type: WorkflowNodeType.BlockStart,
          meta: {
            // 左圆点由 LoopBodyLayer 钉到框左边缘，这里只给个初始位置
            position: { x: 0, y: LOOP_BODY_ITEM_Y + 60 },
          },
          data: {},
        },
        {
          id: blockEndId,
          type: WorkflowNodeType.BlockEnd,
          meta: {
            position: { x: LOOP_BODY_ITEM_X + 360, y: LOOP_BODY_ITEM_Y + 60 },
          },
          data: {},
        },
      ],
      edges: [],
    };
  },
  formMeta,
};
