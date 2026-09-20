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
export const PythonNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Python,
  info: {
    icon: pluginIconUrl('python'),
    description: '在本机 Python 中执行 main(params) 并返回结果；params 是本次运行的工作流输入。驱动（如 pg8000）随平台提供，可直接连接 PostgreSQL（本地试运行）。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }, { type: 'output' }],
    size: {
      width: 360,
      height: 300,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('python'),
      type: 'python',
      data: {
        title: `Python 执行 ${++index}`,
        codeValue: {
          type: 'template',
          content: 'def main(params):\n    text = str(params.get("query", ""))\n    return {"length": len(text), "upper": text.upper()}',
        },
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'object', title: '返回结果' },
          },
        },
      },
    };
  },
};