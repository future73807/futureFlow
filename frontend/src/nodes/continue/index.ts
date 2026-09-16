/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';
import { WorkflowNodeType } from '../constants';

let index = 0;
export const ContinueNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Continue,
  meta: {
    defaultPorts: [{ type: 'input' }],
    sidebarDisabled: true,
    size: {
      width: 360,
      height: 54,
    },
    expandable: false,
    onlyInContainer: WorkflowNodeType.Loop,
  },
  info: {
    icon: pluginIconUrl('continue'),
    description:
      '跳过当前循环迭代，进入下一次循环。',
  },
  /**
   * Render node via formMeta
   */
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('continue'),
      type: 'continue',
      data: {
        title: `继续循环 ${++index}`,
      },
    };
  },
};
