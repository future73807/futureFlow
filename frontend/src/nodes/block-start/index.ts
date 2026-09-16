/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

export const BlockStartNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.BlockStart,
  meta: {
    isStart: true,
    deleteDisable: true,
    copyDisable: true,
    sidebarDisabled: true,
    nodePanelVisible: false,
    defaultPorts: [{ type: 'output' }],
    // 只是循环体里的连接圆点：去掉卡片底色/描边/阴影，尺寸收成一个小点
    size: {
      width: 24,
      height: 24,
    },
    wrapperStyle: {
      minWidth: 'unset',
      width: '100%',
      minHeight: 'unset',
      background: 'transparent',
      borderColor: 'transparent',
      borderRadius: '50%',
      boxShadow: 'none',
      cursor: 'move',
    },
  },
  info: {
    icon: pluginIconUrl('block-start'),
    description: '块起始节点。',
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
