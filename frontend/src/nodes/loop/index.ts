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
import iconLoop from '../../assets/icon-loop.jpg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

let index = 0;
export const LoopNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Loop,
  info: {
    icon: iconLoop,
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
    size: {
      width: 760,
      height: 520,
    },
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
      return {
        top: 120,
        bottom: 80,
        left: 80,
        right: 80,
      };
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
        title: `数组批处理 ${++index}`,
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
              x: 32,
              y: 0,
            },
          },
          data: {},
        },
        {
          id: codeId,
          type: WorkflowNodeType.Code,
          meta: {
            position: {
              x: 190,
              y: 0,
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
              x: 600,
              y: 0,
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
