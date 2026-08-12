/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconVariable from '../../assets/icon-variable.svg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;

export const VariableNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Variable,
  info: {
    icon: iconVariable,
    description: '变量赋值与声明',
  },
  meta: {
    size: {
      width: 360,
      height: 390,
    },
  },
  onAdd() {
    return {
      id: createWorkflowNodeId('variable'),
      type: 'variable',
      data: {
        title: `变量赋值 ${++index}`,
        assign: [
          {
            operator: 'declare',
            left: 'sum',
            right: {
              type: 'constant',
              content: 0,
              schema: { type: 'integer' },
            },
          },
        ],
      },
    };
  },
  formMeta: formMeta,
};
