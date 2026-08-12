/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconHTTP from '../../assets/icon-http.svg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;

export const HTTPNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.HTTP,
  info: {
    icon: iconHTTP,
    description: '调用外部 API，支持认证、请求头、查询参数、请求体、超时和重试。',
  },
  meta: {
    size: {
      width: 360,
      height: 390,
    },
  },
  onAdd() {
    return {
      id: createWorkflowNodeId('http'),
      type: 'http',
      data: {
        title: `API 请求 ${++index}`,
        api: {
          method: 'GET',
          url: { type: 'template', content: '' },
        },
        body: {
          bodyType: 'none',
          json: { type: 'template', content: '' },
        },
        authorization: {
          type: 'none',
          token: { type: 'template', content: '' },
          headerName: { type: 'constant', content: 'X-API-Key' },
          apiKey: { type: 'template', content: '' },
          username: { type: 'constant', content: '' },
          password: { type: 'constant', content: '' },
        },
        headers: {},
        params: {},
        timeout: {
          timeout: 30000,
          retryTimes: 0,
        },
        outputs: {
          type: 'object',
          properties: {
            body: { type: 'string', title: '响应内容' },
            headers: { type: 'object', title: '响应头' },
            statusCode: { type: 'integer', title: '状态码' },
          },
        },
      },
    };
  },
  formMeta: formMeta,
};
