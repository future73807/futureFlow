/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import { pluginIconUrl } from '../../components/plugin-icons';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;

export const VariableAggregatorNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.VariableAggregator,
  info: {
    icon: pluginIconUrl('variable-aggregator'),
    description: '把多个分支的输出聚合起来：每个分组返回第一个非空的值。',
  },
  meta: {
    size: {
      width: 420,
      height: 300,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('aggregate'),
      type: 'variable-aggregator',
      data: {
        title: `变量聚合 ${++index}`,
        // 聚合策略：目前只有「每个分组返回第一个非空的值」
        strategy: 'first-non-empty',
        groups: [
          {
            key: 'result',
            values: [{ type: 'ref', content: [] }],
          },
        ],
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string', title: '聚合结果' },
          },
        },
      },
    };
  },
};
