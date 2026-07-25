/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */
import { nanoid } from 'nanoid';

import { FlowNodeRegistry } from '../../typings';
import { WorkflowNodeType } from '../constants';
import iconCondition from '../../assets/icon-condition.svg';

import { formMeta } from './form-meta';

let index = 0;
export const MultiConditionNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.MultiCondition,
  info: {
    icon: iconCondition,
    description:
      '连接多个下游分支，满足条件时仅执行对应分支。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }],
    // Condition Outputs use dynamic port
    useDynamicPort: true,
    expandable: false, // disable expanded
    size: {
      width: 360,
      height: 210,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: `multi_condition_${nanoid(5)}`,
      type: WorkflowNodeType.MultiCondition,
      data: {
        title: `条件分支_${++index}`,
        branch: [
          {
            logic: 'and',
            conditions: [
              {
                key: `condition_${nanoid(5)}`,
                value: {},
              },
            ],
          },
        ],
      },
    };
  },
};
