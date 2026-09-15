/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconDatabase from '../../assets/icon-database.svg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;
export const DatabaseNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Database,
  info: {
    icon: iconDatabase,
    description: '对 PostgreSQL 数据库执行只读 SELECT 查询，返回结构化行数据。',
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
      id: createWorkflowNodeId('database'),
      type: 'database',
      data: {
        title: `SQL 查询 ${++index}`,
        connection: {
          host: 'localhost',
          port: 5432,
          username: '',
          password: '',
          database: '',
        },
        sqlValue: { type: 'template', content: '' },
        outputs: {
          type: 'object',
          properties: {
            rows: { type: 'array', items: { type: 'object' }, title: '查询结果' },
            rowCount: { type: 'integer', title: '行数' },
            truncated: { type: 'boolean', title: '是否截断' },
          },
        },
      },
    };
  },
};