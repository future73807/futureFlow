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
export const McpNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Mcp,
  info: {
    icon: pluginIconUrl('mcp'),
    description: '调用已注册 MCP 服务器上的工具；凭据保存在网关，不出画布。',
  },
  meta: {
    defaultPorts: [{ type: 'input' }, { type: 'output' }],
    size: {
      width: 360,
      height: 280,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('mcp'),
      type: 'mcp',
      data: {
        title: `MCP 工具 ${++index}`,
        serverId: '',
        tool: '',
        argumentsValue: '{}',
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string', title: '工具结果' },
          },
        },
      },
    };
  },
};
