/**
 * futureFlow 简化初始工作流：开始 → 大语言模型 → 结束
 * 这是 MVP 最小链路的画布初始状态
 */

import { FlowDocumentJSON } from './typings';

export const initialData: FlowDocumentJSON = {
  nodes: [
    {
      id: 'start_0',
      type: 'start',
      meta: {
        position: {
          x: 80,
          y: 200,
        },
      },
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              title: '用户输入',
              default: '你好,请介绍一下你自己。',
            },
          },
        },
      },
    },
    {
      id: 'llm_0',
      type: 'llm',
      meta: {
        position: {
          x: 480,
          y: 200,
        },
      },
      data: {
        title: '大语言模型 1',
        inputsValues: {
          modelName: {
            type: 'constant',
            content: 'deepseek-chat',
          },
          temperature: {
            type: 'constant',
            content: 0.7,
          },
          systemPrompt: {
            type: 'template',
            content: '你是一个友好的 AI 助手,请用简洁的中文回答用户的问题。',
          },
          prompt: {
            type: 'template',
            content: '{{start_0.query}}',
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
            result: {
              type: 'string',
              title: '结果',
            },
          },
        },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: {
        position: {
          x: 880,
          y: 200,
        },
      },
      data: {
        title: '结束',
        inputsValues: {
          result: {
            type: 'ref',
            content: ['llm_0', 'result'],
          },
        },
        inputs: {
          type: 'object',
          properties: {
            result: {
              type: 'string',
              title: '结果',
            },
          },
        },
      },
    },
  ],
  edges: [
    {
      sourceNodeID: 'start_0',
      targetNodeID: 'llm_0',
    },
    {
      sourceNodeID: 'llm_0',
      targetNodeID: 'end_0',
    },
  ],
  globalVariable: {
    type: 'object',
    required: [],
    properties: {},
  },
};
