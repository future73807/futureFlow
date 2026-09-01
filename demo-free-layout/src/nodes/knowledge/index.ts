/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconKnowledge from '../../assets/icon-knowledge.svg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;
export const KnowledgeNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Knowledge,
  info: {
    icon: iconKnowledge,
    description: '在已创建的知识库中检索与查询语句最相关的内容片段。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }, { type: 'output' }],
    size: {
      width: 360,
      height: 240,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('knowledge'),
      type: 'knowledge',
      data: {
        title: `知识检索 ${++index}`,
        datasetId: '',
        queryValue: { type: 'ref', content: [] },
        topK: 4,
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'array', items: { type: 'object' }, title: '检索结果' },
          },
        },
      },
    };
  },
};
