/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

export const BlockEndNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.BlockEnd,
  meta: {
    isNodeEnd: true,
    deleteDisable: true,
    copyDisable: true,
    sidebarDisabled: true,
    nodePanelVisible: false,
    // 端口钉在节点原点（0×0 节点：原点 = 循环体框线上的钉位点）
    defaultPorts: [{ type: 'input', locationConfig: { left: 0, top: 0 } }],
    // 只是循环体框右边缘的连接圆点：0×0 尺寸，位置由 LoopCanvasLayer 钉在框线上。
    // 0×0 让节点不占容器 bounds 的体积（框的左右边界正好由圆点位置撑出），
    // 也不参与 flowgram 拖拽结束时的子节点位置归一化。
    size: {
      width: 0,
      height: 0,
    },
    draggable: false,
    autoResizeDisable: true,
    wrapperStyle: {
      minWidth: 'unset',
      width: '0px',
      height: '0px',
      minHeight: 'unset',
      background: 'transparent',
      borderColor: 'transparent',
      boxShadow: 'none',
    },
  },
  info: {
    icon: pluginIconUrl('block-end'),
    description: '块结束节点。',
  },
  /**
   * Render node via formMeta
   */
  formMeta,
  /**
   * Start Node cannot be added
   */
  canAdd() {
    return false;
  },
};
