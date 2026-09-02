/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconSubflow from '../../assets/icon-subflow.svg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;
export const SubworkflowNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Subworkflow,
  info: {
    icon: iconSubflow,
    description: '把另一个已发布工作流作为节点复用，发布时内联展开。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }, { type: 'output' }],
    size: {
      width: 360,
      height: 260,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('subworkflow'),
      type: 'subworkflow',
      data: {
        title: `子工作流 ${++index}`,
        targetWorkflowId: '',
        inputMappings: {},
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string', title: '子工作流输出' },
          },
        },
      },
    };
  },
};
