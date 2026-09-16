/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  WorkflowNodeEntity,
  PositionSchema,
  FlowNodeTransformData,
} from '@flowgram.ai/free-layout-editor';

import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

/**
 * 循环体区域的内边距：循环体内的节点从这里开始排布，
 * 「循环体」框也用同一组值定位，两者必须始终一致。
 * 顶部留出画布上那张紧凑循环卡片的固定高度。
 */
/**
 * 循环节点在画布上的几何：
 *  - 节点边界（port 所在）= 只算卡片，因此外层连线接在卡片上；
 *  - 循环体画在卡片下方，是一个独立的框，里面的节点连接框内的圆点。
 */
export const LOOP_CARD_HEIGHT = 152;
export const LOOP_BODY_TOP = 168;
export const LOOP_BODY_HEIGHT = 210;
export const LOOP_BODY_PADDING = { top: 0, bottom: 0, left: 80, right: 80 };
/** 循环体框的尺寸（左/右/下留白） */
export const LOOP_SIZE = { width: 780, height: LOOP_BODY_TOP + LOOP_BODY_HEIGHT };
/** 画布上循环卡片字段区固定高度：标题 + 字段区 = LOOP_CARD_HEIGHT */
export const LOOP_CARD_FIELDS_HEIGHT = 112;
/** 循环体内节点默认纵向位置（落在循环体框内） */
export const LOOP_BODY_ITEM_Y = 46;

let index = 0;
export const LoopNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Loop,
  info: {
    icon: pluginIconUrl('loop'),
    description:
      '串行处理字符串或数字数组，最多 20 项。',
  },
  meta: {
    copyDisable: true,
    /**
     * Mark as subcanvas
     * 子画布标记
     */
    isContainer: true,
    /**
     * The subcanvas default size setting
     * 子画布默认大小设置
     */
    // 节点边界只算卡片：外层连线因此接在卡片上，而不是循环体框上
    size: { width: LOOP_SIZE.width, height: LOOP_CARD_HEIGHT },
    autoResizeDisable: true,
    // autoResizeDisable: true,
    /**
     * The subcanvas padding setting
     * 子画布 padding 设置
     */
    padding: (transform) => {
      if (!transform.isContainer) {
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        };
      }
      return { ...LOOP_BODY_PADDING };
    },
    /**
     * Controls the node selection status within the subcanvas
     * 控制子画布内的节点选中状态
     */
    selectable(node: WorkflowNodeEntity, mousePos?: PositionSchema): boolean {
      if (!mousePos) {
        return true;
      }
      const transform = node.getData<FlowNodeTransformData>(FlowNodeTransformData);
      // 鼠标开始时所在位置不包括当前节点时才可选中
      return !transform.bounds.contains(mousePos.x, mousePos.y);
    },
    // expandable: false, // disable expanded
    wrapperStyle: {
      minWidth: 'unset',
      width: '100%',
    },
    // defaultPorts: [{ type: 'output', location: 'right' }, { type: 'input', location: 'left'}, { type: 'output', location: 'bottom', portID: 'bottom' }, { type: 'input', location: 'top', portID: 'top'}]
  },
  onAdd() {
    const loopId = createWorkflowNodeId('loop');
    const blockStartId = createWorkflowNodeId('block_start');
    const codeId = createWorkflowNodeId('batch_code');
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
        loopOutputs: {
          result: { type: 'ref', content: [codeId, 'result'] },
        },
        outputs: {
          type: 'object',
          properties: {
            result: {
              type: 'array',
              items: { type: 'number' },
            },
          },
        },
      },
      blocks: [
        {
          id: blockStartId,
          type: WorkflowNodeType.BlockStart,
          meta: {
            position: {
              x: 110,
              y: LOOP_BODY_TOP + LOOP_BODY_ITEM_Y,
            },
          },
          data: {},
        },
        {
          id: codeId,
          type: WorkflowNodeType.Code,
          meta: {
            position: {
              x: 270,
              y: LOOP_BODY_TOP + LOOP_BODY_ITEM_Y,
            },
          },
          data: {
            title: '逐项处理',
            inputsValues: {
              item: { type: 'ref', content: [`${loopId}_locals`, 'item'] },
              index: { type: 'ref', content: [`${loopId}_locals`, 'index'] },
            },
            inputs: {
              type: 'object',
              properties: {
                item: { type: 'number', title: '当前项' },
                index: { type: 'number', title: '序号' },
              },
            },
            script: {
              language: 'javascript',
              content: `function main({ params }) {
  return { result: params.item * 2 };
}`,
            },
            outputs: {
              type: 'object',
              properties: {
                result: { type: 'number', title: '处理结果' },
              },
            },
          },
        },
        {
          id: blockEndId,
          type: WorkflowNodeType.BlockEnd,
          meta: {
            position: {
              x: 660,
              y: LOOP_BODY_TOP + LOOP_BODY_ITEM_Y,
            },
          },
          data: {},
        },
      ],
      edges: [
        { sourceNodeID: blockStartId, targetNodeID: codeId },
        { sourceNodeID: codeId, targetNodeID: blockEndId },
      ],
    };
  },
  formMeta,
};
