#!/usr/bin/env node
/**
 * 全节点验收工作流的建图脚本（模拟点击验收用）。
 *
 * 通过平台 API 创建三条工作流，覆盖画布上可运行的全部节点类型：
 *   A 本地链路：开始 → 文本处理 → 大语言模型 → 条件分支 → 代码执行
 *             → 多条件分支 → 循环 → Python 执行 → 结束
 *   B 云端链路：开始 → API 请求（每日诗词）→ 知识检索 → MCP 工具
 *             → 文本处理 → 子工作流 → 文本处理 → 结束
 *   C 子工作流目标：开始 → 代码执行 → 结束（发布后供 B 引用）
 *
 * 用法：node scripts/acceptance-workflows.cjs [password]
 * 输出：每个工作流的 id / 名称，供后续 GUI 验收直接打开。
 */
'use strict';

const fs = require('node:fs');
const { join } = require('node:path');

const BASE = (() => {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL.replace(/\/+$/, '');
  try {
    const env = fs.readFileSync(join(process.cwd(), '.env'), 'utf8');
    const port = env.match(/^GATEWAY_PORT=(.*)$/m)?.[1]?.trim();
    if (port) return `http://localhost:${port}`;
  } catch { /* ignore */ }
  return 'http://localhost:3001';
})();

const PASSWORD = process.argv[2] || 'futureFlow@';

/** 从 .env 读平台库连接，SQL 节点直连平台自身的 PostgreSQL */
async function json(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

const START = (properties, position = { x: 60, y: 240 }) => ({
  id: 'start_0',
  type: 'start',
  meta: { position },
  data: {
    title: '开始',
    outputs: { type: 'object', properties },
  },
});

/* ---------------------------------------------------------------- A 本地链路 */

const buildLocalGraph = () => ({
  nodes: [
    START({
      query: { type: 'string', title: '用户输入', default: '请用一句话介绍未来的工作流平台' },
    }),
    {
      id: 'text_0',
      type: 'text',
      meta: { position: { x: 340, y: 240 } },
      data: {
        title: '文本处理·拼提示词',
        inputsValues: {
          text: { type: 'template', content: '请用不超过 30 个字回答：{{start_0.query}}' },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
      },
    },
    {
      id: 'llm_0',
      type: 'llm',
      meta: { position: { x: 620, y: 240 } },
      data: {
        title: '大语言模型',
        inputsValues: {
          modelName: { type: 'constant', content: 'GLM-5.3-Flash' },
          temperature: { type: 'constant', content: 0.4 },
          systemPrompt: { type: 'template', content: '你是一名简洁的中文助手，直接给结论。' },
          prompt: { type: 'ref', content: ['text_0', 'text'] },
        },
        inputs: {
          type: 'object',
          required: ['modelName', 'temperature', 'prompt'],
          properties: {
            modelName: { type: 'string' },
            temperature: { type: 'number' },
            systemPrompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
            prompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
          },
        },
        outputs: { type: 'object', properties: { result: { type: 'string', title: '模型输出' } } },
      },
    },
    {
      id: 'condition_0',
      type: 'condition',
      meta: { position: { x: 900, y: 240 } },
      data: {
        title: '条件分支·模型有输出',
        conditions: [{
          key: 'has_output',
          value: {
            left: { type: 'ref', content: ['llm_0', 'result'] },
            operator: 'is_not_empty',
          },
        }],
      },
    },
    {
      id: 'code_0',
      type: 'code',
      meta: { position: { x: 1180, y: 120 } },
      data: {
        title: '代码执行·统计字数',
        inputsValues: {
          code: {
            type: 'template',
            content:
              'function main({ params }) {\n'
              + '  const text = String(params.text || "");\n'
              + '  return { result: { length: text.length, preview: text.slice(0, 12) } };\n'
              + '}',
          },
          text: { type: 'ref', content: ['llm_0', 'result'] },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { result: { type: 'object', title: '结果' } } },
      },
    },
    {
      id: 'code_list',
      type: 'code',
      meta: { position: { x: 1460, y: 120 } },
      data: {
        title: '代码执行·生成数组',
        inputsValues: {
          code: {
            type: 'template',
            content:
              'function main() {\n'
              + '  return { list: [1, 2, 3, 4] };\n'
              + '}',
          },
        },
        inputs: { type: 'object', properties: {} },
        outputs: {
          type: 'object',
          properties: { list: { type: 'array', items: { type: 'number' }, title: '数组' } },
        },
      },
    },
    {
      id: 'multi_0',
      type: 'multi-condition',
      meta: { position: { x: 1180, y: 420 } },
      data: {
        title: '多条件分支·字数达标',
        branch: [
          {
            logic: 'and',
            conditions: [
              {
                key: 'len_enough',
                value: {
                  left: { type: 'ref', content: ['code_0', 'result', 'length'] },
                  operator: 'gt',
                  right: { type: 'constant', content: 2 },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: 'loop_0',
      type: 'loop',
      meta: { position: { x: 1460, y: 420 } },
      data: {
        title: '循环·翻倍',
        loopFor: { type: 'ref', content: ['code_list', 'list'] },
        loopOutputs: { result: { type: 'ref', content: ['loop_code_0', 'result'] } },
        outputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'number' }, title: '批处理结果' } },
        },
      },
      blocks: [
        { id: 'loop_block_start', type: 'block-start', meta: { position: { x: 32, y: 0 } }, data: {} },
        {
          id: 'loop_code_0',
          type: 'code',
          meta: { position: { x: 190, y: 0 } },
          data: {
            title: '逐项翻倍',
            inputsValues: {
              item: { type: 'ref', content: ['loop_0_locals', 'item'] },
              index: { type: 'ref', content: ['loop_0_locals', 'index'] },
            },
            inputs: {
              type: 'object',
              properties: {
                item: { type: 'number', title: '当前项' },
                index: { type: 'number', title: '序号' },
              },
            },
            script: {
              language: 'javascript',
              content: 'function main({ params }) {\n  return { result: params.item * 2 };\n}',
            },
            outputs: { type: 'object', properties: { result: { type: 'number', title: '处理结果' } } },
          },
        },
        { id: 'loop_block_end', type: 'block-end', meta: { position: { x: 600, y: 0 } }, data: {} },
      ],
      edges: [
        { sourceNodeID: 'loop_block_start', targetNodeID: 'loop_code_0' },
        { sourceNodeID: 'loop_code_0', targetNodeID: 'loop_block_end' },
      ],
    },
    {
      id: 'python_0',
      type: 'python',
      meta: { position: { x: 2060, y: 420 } },
      data: {
        title: 'Python 执行·本机计算',
        codeValue: {
          type: 'template',
          content:
            'def main(params):\n'
            + '    return {"note": "python-ok", "answer": 6 * 7, "model": "local"}',
        },
        outputs: {
          type: 'object',
          properties: { result: { type: 'object', title: '返回结果' } },
        },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 2360, y: 300 } },
      data: {
        title: '结束',
        inputsValues: {
          llm_result: { type: 'ref', content: ['llm_0', 'result'] },
          code_result: { type: 'ref', content: ['code_0', 'result'] },
          loop_result: { type: 'ref', content: ['loop_0', 'result'] },
          python_result: { type: 'ref', content: ['python_0', 'result'] },
        },
        inputs: {
          type: 'object',
          properties: {
            llm_result: { type: 'string', title: '模型输出' },
            code_result: { type: 'object', title: '代码结果' },
            loop_result: { type: 'array', items: { type: 'number' }, title: '批处理结果' },
            python_result: { type: 'object', title: 'Python 结果' },
          },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'text_0' },
    { sourceNodeID: 'text_0', targetNodeID: 'llm_0' },
    { sourceNodeID: 'llm_0', targetNodeID: 'condition_0' },
    { sourceNodeID: 'condition_0', targetNodeID: 'code_0', sourcePortID: 'has_output' },
    { sourceNodeID: 'code_0', targetNodeID: 'code_list' },
    { sourceNodeID: 'code_list', targetNodeID: 'multi_0' },
    { sourceNodeID: 'multi_0', targetNodeID: 'loop_0', sourcePortID: 'branch.0' },
    { sourceNodeID: 'loop_0', targetNodeID: 'python_0' },
    { sourceNodeID: 'python_0', targetNodeID: 'end_0' },
    { sourceNodeID: 'condition_0', targetNodeID: 'end_0', sourcePortID: 'else' },
    { sourceNodeID: 'multi_0', targetNodeID: 'end_0', sourcePortID: 'else' },
  ],
});

/* -------------------------------------------------------------- C 子工作流目标 */

const buildChildGraph = () => ({
  nodes: [
    START({ text: { type: 'string', title: '子流程输入', default: '（默认输入）' } }),
    {
      id: 'code_0',
      type: 'code',
      meta: { position: { x: 400, y: 240 } },
      data: {
        title: '代码执行·加后缀',
        inputsValues: {
          code: {
            type: 'template',
            content:
              'function main({ params }) {\n'
              + '  return { result: "子工作流已执行 → " + String(params.text || "") };\n'
              + '}',
          },
          text: { type: 'ref', content: ['start_0', 'text'] },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { result: { type: 'string', title: '结果' } } },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 720, y: 240 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['code_0', 'result'] } },
        inputs: { type: 'object', properties: { result: { type: 'string', title: '结果' } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'code_0' },
    { sourceNodeID: 'code_0', targetNodeID: 'end_0' },
  ],
});

/* ---------------------------------------------------------------- B 云端链路 */

const buildCloudGraph = (childWorkflowId, datasetId, mcpServerId) => ({
  nodes: [
    START({ query: { type: 'string', title: '检索问题', default: '时间胶囊的维护密码是什么' } }),
    {
      id: 'http_0',
      type: 'http',
      meta: { position: { x: 360, y: 100 } },
      data: {
        title: 'API 请求·每日诗词',
        api: {
          method: 'GET',
          url: { type: 'constant', content: 'https://v1.hitokoto.cn/?c=i&encode=json' },
        },
        authorization: { type: 'none' },
        headers: { type: 'object', properties: {} },
        headersValues: {},
        params: { type: 'object', properties: {} },
        paramsValues: {},
        body: { bodyType: 'none' },
        timeout: { timeout: 15000, retryTimes: 1 },
        outputs: {
          type: 'object',
          properties: {
            body: { type: 'string', title: '响应内容' },
            headers: { type: 'object', title: '响应头' },
            statusCode: { type: 'integer', title: '状态码' },
          },
        },
      },
    },
    {
      id: 'knowledge_0',
      type: 'knowledge',
      meta: { position: { x: 360, y: 360 } },
      data: {
        title: '知识检索·时间胶囊',
        datasetId,
        queryValue: { type: 'ref', content: ['start_0', 'query'] },
        topK: 4,
        outputs: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'object' }, title: '检索结果' } },
        },
      },
    },
    {
      id: 'mcp_0',
      type: 'mcp',
      meta: { position: { x: 700, y: 100 } },
      data: {
        title: 'MCP 工具·服务器时间',
        serverId: mcpServerId,
        tool: 'get_time',
        argumentsValue: '{}',
        // 画布上的 MCP 节点对外只声明 result；body/statusCode 是展开后的代理细节
        outputs: {
          type: 'object',
          properties: { result: { type: 'string', title: '工具结果' } },
        },
      },
    },
    {
      id: 'text_0',
      type: 'text',
      meta: { position: { x: 700, y: 420 } },
      data: {
        title: '文本处理·汇总前段',
        inputsValues: {
          text: {
            type: 'template',
            content:
              '诗词接口状态码={{http_0.statusCode}}；检索结果={{knowledge_0.result}}；MCP 返回={{mcp_0.result}}',
          },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
      },
    },
    {
      id: 'subworkflow_0',
      type: 'subworkflow',
      meta: { position: { x: 1040, y: 420 } },
      data: {
        title: '子工作流·复用',
        targetWorkflowId: childWorkflowId,
        inputMappings: {
          text: { type: 'ref', content: ['text_0', 'text'] },
        },
        outputs: {
          type: 'object',
          properties: { result: { type: 'string', title: '子工作流输出' } },
        },
      },
    },
    {
      id: 'text_1',
      type: 'text',
      meta: { position: { x: 1380, y: 420 } },
      data: {
        title: '文本处理·最终汇总',
        inputsValues: {
          text: {
            type: 'template',
            content: '合集：{{text_0.text}}\n子流程：{{subworkflow_0.result}}\n诗词：{{http_0.body}}',
          },
        },
        inputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
        outputs: { type: 'object', properties: { text: { type: 'string', title: '文本' } } },
      },
    },
    {
      id: 'end_0',
      type: 'end',
      meta: { position: { x: 1700, y: 420 } },
      data: {
        title: '结束',
        inputsValues: { result: { type: 'ref', content: ['text_1', 'text'] } },
        inputs: { type: 'object', properties: { result: { type: 'string', title: '结果' } } },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start_0', targetNodeID: 'http_0' },
    { sourceNodeID: 'http_0', targetNodeID: 'knowledge_0' },
    { sourceNodeID: 'knowledge_0', targetNodeID: 'mcp_0' },
    { sourceNodeID: 'mcp_0', targetNodeID: 'text_0' },
    { sourceNodeID: 'text_0', targetNodeID: 'subworkflow_0' },
    { sourceNodeID: 'subworkflow_0', targetNodeID: 'text_1' },
    { sourceNodeID: 'text_1', targetNodeID: 'end_0' },
  ],
});

async function main() {
  const login = await json('POST', '/auth/login', null, { account: 'admin', password: PASSWORD });
  const token = login.data?.accessToken;
  if (!token) throw new Error(`登录失败: ${JSON.stringify(login.data).slice(0, 200)}`);
  console.log('[ok] 登录成功');

  const datasets = (await json('GET', '/knowledge/datasets', token)).data || [];
  const dataset = datasets[0];
  if (!dataset) throw new Error('没有可用知识库，请先在个人中心创建知识库并添加文档');
  const servers = (await json('GET', '/mcp/servers', token)).data || [];
  const server = servers[0];
  if (!server) throw new Error('没有可用 MCP 服务器，请先在个人中心注册 MCP 服务器');
  console.log(`[ok] 知识库=${dataset.name}(${dataset.id}) MCP=${server.name}(${server.id})`);

  const stamp = Date.now().toString().slice(-5);
  const created = {};

  const child = await json('POST', '/workflows', token, {
    name: `验收C-子工作流目标-${stamp}`,
    description: '被「全节点验收B」引用；开始 → 代码执行 → 结束',
    flowgram: JSON.stringify(buildChildGraph()),
  });
  if (!child.data?.id) throw new Error(`创建子工作流失败: ${JSON.stringify(child.data).slice(0, 200)}`);
  created.child = child.data;
  console.log(`[ok] C 子工作流目标: ${child.data.id}  ${child.data.name}`);

  const local = await json('POST', '/workflows', token, {
    name: `验收A-本地链路-${stamp}`,
    description: '文本处理/大语言模型/条件分支/多条件/代码执行/循环/SQL/Python/结束',
    flowgram: JSON.stringify(buildLocalGraph()),
  });
  if (!local.data?.id) throw new Error(`创建本地链路失败: ${JSON.stringify(local.data).slice(0, 300)}`);
  created.local = local.data;
  console.log(`[ok] A 本地链路: ${local.data.id}  ${local.data.name}`);

  const cloud = await json('POST', '/workflows', token, {
    name: `验收B-云端链路-${stamp}`,
    description: 'API 请求(每日诗词)/知识检索/MCP/文本处理/子工作流/结束',
    flowgram: JSON.stringify(buildCloudGraph(child.data.id, dataset.id, server.id)),
  });
  if (!cloud.data?.id) throw new Error(`创建云端链路失败: ${JSON.stringify(cloud.data).slice(0, 300)}`);
  created.cloud = cloud.data;
  console.log(`[ok] B 云端链路: ${cloud.data.id}  ${cloud.data.name}`);

  fs.writeFileSync(
    join(process.cwd(), '.zcode-tmp', 'acceptance-workflows.json'),
    JSON.stringify(created, null, 2),
  );
  console.log('\n工作流 id 已写入 .zcode-tmp/acceptance-workflows.json');
  console.log(JSON.stringify(created, null, 2));
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
});
