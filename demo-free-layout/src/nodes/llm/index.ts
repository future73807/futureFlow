/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { WorkflowNodeType } from '../constants';
import { FlowNodeRegistry } from '../../typings';
import iconLLM from '../../assets/icon-llm.jpg';
import { createWorkflowNodeId } from '../../utils/node-id';
import { formMeta } from './form-meta';

let index = 0;
export const LLMNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.LLM,
  info: {
    icon: iconLLM,
    description:
      '调用大语言模型，使用变量和提示词生成回复。',
  },
  meta: {
    size: {
      width: 360,
      height: 390,
    },
  },
  formMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('llm'),
      type: 'llm',
      data: {
        title: `大语言模型 ${++index}`,
        inputsValues: {
          modelName: {
            type: 'constant',
            content: 'deepseek-chat',
          },
          temperature: {
            type: 'constant',
            content: 0.5,
          },
          systemPrompt: {
            type: 'template',
            content: '你是一名可靠的 AI 助手，请用清晰、准确的中文回答。',
          },
          prompt: {
            type: 'template',
            content: '',
          },
        },
        inputs: {
          type: 'object',
          required: ['modelName', 'temperature', 'prompt'],
          properties: {
            modelName: {
              type: 'string',
              title: '模型名称',
            },
            temperature: {
              type: 'number',
              title: '生成温度',
            },
            systemPrompt: {
              type: 'string',
              title: '系统提示词',
              extra: {
                formComponent: 'prompt-editor',
              },
            },
            prompt: {
              type: 'string',
              title: '用户提示词',
              extra: {
                formComponent: 'prompt-editor',
              },
            },
          },
        },
        outputs: {
          type: 'object',
          properties: {
            result: { type: 'string', title: '结果' },
          },
        },
      },
    };
  },
};
