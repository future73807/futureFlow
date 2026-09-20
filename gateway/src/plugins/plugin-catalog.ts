/**
 * 插件商店静态目录。
 *
 * 这里只做展示元数据：名称、描述、真实参数与输出都对齐前端节点注册表
 * （frontend/src/nodes），不包含任何运行时逻辑。
 * nodeType 必须与前端 FlowGram 节点的 type 字符串完全一致，
 * 统计服务依赖它把 workflow_runs.flowgramJson.nodes[].type 映射到插件。
 */

export type PluginCategory = '智能与内容' | '扩展能力' | '流程控制';

export interface PluginToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: string | number | boolean;
}

export interface PluginToolOutput {
  name: string;
  type: string;
  description: string;
}

export interface PluginTool {
  name: string;
  description: string;
  params: PluginToolParam[];
  outputs: PluginToolOutput[];
}

export interface PluginCatalogEntry {
  id: string;
  nodeType: string;
  name: string;
  category: PluginCategory;
  summary: string;
  description: string;
  tags: string[];
  /** 前端 assets 下真实存在的图标文件名（不含扩展名）；没有匹配资源时省略。 */
  icon?: string;
  tools: PluginTool[];
  capability: string;
}

// ───────────────────────────── 智能与内容 ─────────────────────────────

const LLM_PLUGIN: PluginCatalogEntry = {
  id: 'llm',
  nodeType: 'llm',
  name: '大语言模型',
  category: '智能与内容',
  summary: '调用大语言模型，用变量和提示词生成回复。',
  description:
    '调用平台已接入的大语言模型，用系统提示词与用户提示词生成回复，默认模型为 glm-5.3-flash，可通过生成温度控制输出随机性。提示词支持引用上游节点变量，输出模型回复文本供下游使用。',
  tags: ['大模型', '对话', '文本生成'],
  icon: 'icon-llm',
  tools: [
    {
      name: 'llm_generate',
      description: '使用提示词调用大语言模型并返回生成文本。',
      params: [
        {
          name: 'prompt',
          type: 'string',
          required: true,
          description: '用户提示词，支持引用上游变量',
        },
        {
          name: 'modelName',
          type: 'string',
          required: true,
          description: '模型名称',
          default: 'glm-5.3-flash',
        },
        {
          name: 'temperature',
          type: 'number',
          required: true,
          description: '生成温度，控制输出随机性',
          default: 0.5,
        },
        {
          name: 'systemPrompt',
          type: 'string',
          required: false,
          description: '系统提示词，设定模型角色与回答风格',
          default: '你是一名可靠的 AI 助手，请用清晰、准确的中文回答。',
        },
      ],
      outputs: [{ name: 'result', type: 'string', description: '模型回复文本' }],
    },
  ],
  capability: '需要文本理解、总结、改写、翻译或问答时使用。',
};

const TEXT_PLUGIN: PluginCatalogEntry = {
  id: 'content-text',
  nodeType: 'text',
  name: '文本处理',
  category: '智能与内容',
  summary: '组合、传递或格式化文本，支持引用上游变量。',
  description:
    '把固定文本与上游变量组合、格式化后输出，在输入框中输入“{”即可引用上游变量。常用于拼接提示词、整理检索结果或构造下游节点的输入。',
  tags: ['文本', '模板', '变量'],
  icon: 'icon-text',
  tools: [
    {
      name: 'text_compose',
      description: '按模板拼接文本并输出结果。',
      params: [
        {
          name: 'text',
          type: 'string',
          required: true,
          description: '文本内容，支持通过“{”引用上游变量',
        },
      ],
      outputs: [{ name: 'text', type: 'string', description: '处理后的文本内容' }],
    },
  ],
  capability: '需要拼接、格式化或透传文本时使用。',
};

const IMAGE_PLUGIN: PluginCatalogEntry = {
  id: 'content-image',
  nodeType: 'image',
  name: '图片处理',
  category: '智能与内容',
  summary: '透传已有图片，或调用 OpenAI、Google、豆包、MiniMax 生成图片。',
  description:
    '资源透传模式下直接把已有图片 URL 传递给下游；AI 原生生成模式下按提示词调用 OpenAI、Google、豆包或 MiniMax 的图片模型生成图片，默认模型为 gpt-image-1.5。供应商访问密钥通过服务凭据在服务端引用，不会写入画布。',
  tags: ['图片', '多模态', '内容生成'],
  icon: 'icon-image',
  tools: [
    {
      name: 'image_generate',
      description: '透传图片资源，或按提示词生成图片并返回资源地址。',
      params: [
        {
          name: 'mode',
          type: 'string',
          required: true,
          description: '运行模式：passthrough 资源透传 / generate AI 原生生成',
          default: 'passthrough',
        },
        {
          name: 'url',
          type: 'string',
          required: false,
          description: '资源透传模式下的图片地址（必填）',
        },
        {
          name: 'prompt',
          type: 'string',
          required: false,
          description: '生成模式下的图片描述提示词（必填）',
        },
        {
          name: 'provider',
          type: 'string',
          required: false,
          description: '生成供应商：openai / google / doubao / minimax',
          default: 'openai',
        },
        {
          name: 'model',
          type: 'string',
          required: false,
          description: '图片模型 ID',
          default: 'gpt-image-1.5',
        },
        {
          name: 'size',
          type: 'string',
          required: false,
          description: '画布尺寸：auto / 1024x1024 / 1536x1024 / 1024x1536',
          default: '1024x1024',
        },
        {
          name: 'aspectRatio',
          type: 'string',
          required: false,
          description: '画面比例，如 1:1、16:9',
          default: '1:1',
        },
        {
          name: 'credentialId',
          type: 'string',
          required: false,
          description: '生成模式下的服务凭据 ID（服务端引用，非访问密钥）',
        },
      ],
      outputs: [
        { name: 'url', type: 'string', description: '图片资源地址' },
        { name: 'assetId', type: 'string', description: '媒体资产编号' },
        { name: 'jobId', type: 'string', description: '媒体任务编号' },
        { name: 'mediaType', type: 'string', description: '媒体类型' },
        { name: 'status', type: 'string', description: '生成状态' },
      ],
    },
  ],
  capability: '需要传递图片资源或按描述生成图片时使用。',
};

const VIDEO_PLUGIN: PluginCatalogEntry = {
  id: 'content-video',
  nodeType: 'video',
  name: '视频处理',
  category: '智能与内容',
  summary: '透传已有视频，或创建和查询视频生成任务。',
  description:
    '资源透传模式下传递已有视频 URL；AI 原生生成模式下可按提示词创建视频生成任务（默认模型 sora-2），或按媒体任务编号查询任务结果。支持 OpenAI、Google、豆包、MiniMax 四家供应商。',
  tags: ['视频', '多模态', '内容生成'],
  icon: 'icon-video',
  tools: [
    {
      name: 'video_generate',
      description: '透传视频资源，或创建/查询视频生成任务并返回结果。',
      params: [
        {
          name: 'mode',
          type: 'string',
          required: true,
          description: '运行模式：passthrough 资源透传 / generate AI 原生生成',
          default: 'passthrough',
        },
        {
          name: 'operation',
          type: 'string',
          required: false,
          description: '生成模式下的任务动作：create 创建任务 / query 查询任务',
          default: 'create',
        },
        {
          name: 'url',
          type: 'string',
          required: false,
          description: '资源透传模式下的视频地址（必填）',
        },
        {
          name: 'prompt',
          type: 'string',
          required: false,
          description: '创建任务时的画面描述提示词（必填）',
        },
        {
          name: 'taskId',
          type: 'string',
          required: false,
          description: '查询任务时使用的媒体任务编号（必填）',
        },
        {
          name: 'provider',
          type: 'string',
          required: false,
          description: '生成供应商：openai / google / doubao / minimax',
          default: 'openai',
        },
        {
          name: 'model',
          type: 'string',
          required: false,
          description: '视频模型 ID',
          default: 'sora-2',
        },
        {
          name: 'durationSeconds',
          type: 'number',
          required: false,
          description: '视频时长（秒），MiniMax H3 支持 4–15 秒，其他供应商以模型限制为准',
          default: 5,
        },
      ],
      outputs: [
        { name: 'url', type: 'string', description: '视频资源地址' },
        { name: 'jobId', type: 'string', description: '媒体任务编号' },
        { name: 'poster', type: 'string', description: '视频封面地址' },
        { name: 'status', type: 'string', description: '任务状态' },
      ],
    },
  ],
  capability: '需要传递视频或创建、查询视频生成任务时使用。',
};

// ───────────────────────────── 扩展能力 ─────────────────────────────

const HTTP_PLUGIN: PluginCatalogEntry = {
  id: 'http',
  nodeType: 'http',
  name: 'API 请求',
  category: '扩展能力',
  summary: '调用外部 API，支持认证、请求头、查询参数与请求体。',
  description:
    '向外部 HTTP 接口发起 GET/POST/PUT/DELETE/PATCH/HEAD 请求，支持 Bearer 令牌、API 密钥和 Basic 认证。可自定义请求头与查询参数，请求体支持 JSON 与纯文本，并可配置超时与失败重试。输出响应状态码、响应头与响应内容。',
  tags: ['API', 'HTTP', '集成'],
  icon: 'icon-http',
  tools: [
    {
      name: 'http_request',
      description: '发起一次 HTTP 请求并返回响应。',
      params: [
        {
          name: 'method',
          type: 'string',
          required: true,
          description: '请求方法：GET / POST / PUT / DELETE / PATCH / HEAD',
          default: 'GET',
        },
        {
          name: 'url',
          type: 'string',
          required: true,
          description: '请求地址，需以 http:// 或 https:// 开头，支持引用变量',
        },
        {
          name: 'headers',
          type: 'object',
          required: false,
          description: '自定义请求头键值对',
        },
        {
          name: 'params',
          type: 'object',
          required: false,
          description: 'URL 查询参数键值对',
        },
        {
          name: 'bodyType',
          type: 'string',
          required: false,
          description: '请求体类型：none / JSON / raw-text',
          default: 'none',
        },
        {
          name: 'body',
          type: 'string',
          required: false,
          description: '请求体内容，JSON 类型需为合法 JSON 或引用变量',
        },
        {
          name: 'authorizationType',
          type: 'string',
          required: false,
          description: '认证方式：none / bearer / api-key / basic',
          default: 'none',
        },
        {
          name: 'timeout',
          type: 'number',
          required: false,
          description: '超时时间（毫秒），范围 1–120000',
          default: 30000,
        },
      ],
      outputs: [
        { name: 'statusCode', type: 'integer', description: '响应状态码' },
        { name: 'body', type: 'string', description: '响应内容' },
        { name: 'headers', type: 'object', description: '响应头' },
      ],
    },
  ],
  capability: '需要调用第三方 API 或 Webhook 时使用。',
};

const CODE_PLUGIN: PluginCatalogEntry = {
  id: 'code',
  nodeType: 'code',
  name: '代码执行',
  category: '扩展能力',
  summary: '执行自定义 JavaScript 脚本并返回结果。',
  description:
    '在节点内编写 JavaScript 脚本处理数据，脚本通过 params 读取上游输入，返回自定义结构的输出对象。支持本地试运行，发布后转换为 Dify 代码节点在云端执行。',
  tags: ['JavaScript', '脚本', '数据处理'],
  icon: 'icon-script',
  tools: [
    {
      name: 'code_execute',
      description: '执行 JavaScript 脚本并返回脚本定义的输出对象。',
      params: [
        {
          name: 'input',
          type: 'any',
          required: false,
          description: '默认输入参数，脚本中通过 params.input 读取；可在输入面板添加更多参数',
        },
        {
          name: 'language',
          type: 'string',
          required: true,
          description: '脚本语言，当前仅支持 javascript',
          default: 'javascript',
        },
        {
          name: 'code',
          type: 'string',
          required: true,
          description: '脚本内容，需定义 function main({ params }) 并 return 输出对象',
        },
      ],
      outputs: [{ name: 'ret', type: 'object', description: '脚本返回的自定义输出对象' }],
    },
  ],
  capability: '需要对数据做自定义 JavaScript 转换或计算时使用。',
};

const KNOWLEDGE_PLUGIN: PluginCatalogEntry = {
  id: 'knowledge',
  nodeType: 'knowledge',
  name: '知识检索',
  category: '扩展能力',
  summary: '在知识库中检索与查询语句最相关的内容片段。',
  description:
    '选择已创建的知识库，用上游变量作为查询语句做相似度检索，返回最相关的内容片段。返回数量可设置为 1–10，默认 4 条，适合为问答或写作补充事实依据。',
  tags: ['知识库', '检索', 'RAG'],
  icon: 'icon-knowledge',
  tools: [
    {
      name: 'knowledge_search',
      description: '在指定知识库中检索最相关的文档片段。',
      params: [
        {
          name: 'datasetId',
          type: 'string',
          required: true,
          description: '知识库 ID',
        },
        {
          name: 'query',
          type: 'string',
          required: true,
          description: '检索语句，需引用一个上游变量',
        },
        {
          name: 'topK',
          type: 'number',
          required: false,
          description: '返回片段数量，范围 1–10',
          default: 4,
        },
      ],
      outputs: [{ name: 'result', type: 'array', description: '命中的内容片段数组' }],
    },
  ],
  capability: '需要基于私有知识库检索资料时使用。',
};

const SUBWORKFLOW_PLUGIN: PluginCatalogEntry = {
  id: 'subworkflow',
  nodeType: 'subworkflow',
  name: '子工作流',
  category: '扩展能力',
  summary: '把另一个已发布工作流作为节点复用。',
  description:
    '选择另一个已发布的工作流作为当前流程的节点使用，通过输入映射把当前画布的变量传给子工作流。发布时子工作流会内联展开，适合把通用流程封装后复用。',
  tags: ['子流程', '复用', '编排'],
  icon: 'icon-subflow',
  tools: [
    {
      name: 'subworkflow_invoke',
      description: '按输入映射调用一个已发布的工作流。',
      params: [
        {
          name: 'targetWorkflowId',
          type: 'string',
          required: true,
          description: '目标工作流 ID（需已发布）',
        },
        {
          name: 'inputMappings',
          type: 'object',
          required: false,
          description: '输入映射：把当前节点的变量映射为子工作流输入',
        },
      ],
      outputs: [{ name: 'result', type: 'string', description: '子工作流输出' }],
    },
  ],
  capability: '需要复用另一个已发布工作流时使用。',
};

const MCP_PLUGIN: PluginCatalogEntry = {
  id: 'mcp',
  nodeType: 'mcp',
  name: 'MCP 工具',
  category: '扩展能力',
  summary: '调用已注册 MCP 服务器上的工具。',
  description:
    '从网关已注册的 MCP 服务器中选择工具，以 JSON 参数调用并返回工具结果。服务器凭据保存在网关，不会出现在画布、版本历史或结果包中。',
  tags: ['MCP', '工具调用', '集成'],
  icon: 'icon-mcp',
  tools: [
    {
      name: 'mcp_call_tool',
      description: '调用 MCP 服务器上的指定工具。',
      params: [
        {
          name: 'serverId',
          type: 'string',
          required: true,
          description: 'MCP 服务器 ID',
        },
        {
          name: 'tool',
          type: 'string',
          required: true,
          description: '要调用的工具名称',
        },
        {
          name: 'arguments',
          type: 'object',
          required: false,
          description: '工具参数 JSON',
          default: '{}',
        },
      ],
      outputs: [{ name: 'result', type: 'string', description: '工具返回结果' }],
    },
  ],
  capability: '需要调用 MCP 工具扩展平台能力时使用。',
};

const PYTHON_PLUGIN: PluginCatalogEntry = {
  id: 'python',
  nodeType: 'python',
  name: 'Python 执行',
  category: '扩展能力',
  summary: '在本机 Python 3 中执行 main({params}) 并返回结果。',
  description:
    '编写 Python 代码并定义 main(params) 函数，通过参数字典读取上游变量，返回可 JSON 序列化的结果对象。本地试运行时经网关代理在本机 Python 3 中真实执行，超时 15 秒。',
  tags: ['Python', '脚本', '数据处理'],
  icon: 'icon-python',
  tools: [
    {
      name: 'python_execute',
      description: '执行 Python 函数并返回其结果对象。',
      params: [
        {
          name: 'code',
          type: 'string',
          required: true,
          description: 'Python 代码，必须定义 def main(params) 并返回可 JSON 序列化的对象',
        },
      ],
      outputs: [{ name: 'result', type: 'object', description: 'main 函数返回的结果对象' }],
    },
  ],
  capability: '需要用 Python 做数据处理或计算时使用。',
};

// ───────────────────────────── 流程控制 ─────────────────────────────

const CONDITION_PLUGIN: PluginCatalogEntry = {
  id: 'condition',
  nodeType: 'condition',
  name: '条件分支',
  category: '流程控制',
  summary: '按条件选择下游分支。',
  description:
    '为每条分支配置一个 IF 条件，支持等于、不等于、大于、包含、为空等运算符，并提供 else 兜底端口。运行时仅继续执行满足条件的分支。',
  tags: ['分支', '条件', '路由'],
  icon: 'icon-condition',
  tools: [
    {
      name: 'condition_branch',
      description: '按条件表达式把流程路由到对应分支。',
      params: [
        {
          name: 'conditions',
          type: 'array',
          required: true,
          description: '分支条件列表，每项包含唯一 key 与条件表达式（左值、运算符、右值）',
        },
      ],
      outputs: [
        {
          name: 'branch',
          type: 'boolean',
          description: '每个 IF 条件对应一个动态输出端口，条件命中时走该端口',
        },
        { name: 'else', type: 'boolean', description: '所有条件都不满足时走 else 端口' },
      ],
    },
  ],
  capability: '需要按数据值走向不同分支时使用。',
};

const VARIABLE_AGGREGATOR_PLUGIN: PluginCatalogEntry = {
  id: 'variable-aggregator',
  nodeType: 'variable-aggregator',
  name: '变量聚合',
  category: '流程控制',
  summary: '把多个分支的输出聚合起来：每个分组返回第一个非空的值。',
  description:
    '聚合策略为「返回每个分组中第一个非空的值」：每个分组给出一串变量引用，运行时按顺序取第一个非空值作为该分组的输出；分组内变量类型需要一致，全部为空时返回该类型的安全空值。常用于多分支汇合后统一取值。',
  tags: ['聚合', '合并', '变量', '汇合'],
  icon: 'icon-variable-aggregator',
  tools: [
    {
      name: 'aggregate_variables',
      description: '按分组把多个变量聚合为每组一个输出值。',
      params: [
        {
          name: 'groups',
          type: 'array',
          required: true,
          description: '分组列表，每项包含输出名 key 与变量引用数组 values',
        },
        {
          name: 'strategy',
          type: 'string',
          required: false,
          description: '聚合策略，当前仅支持 first-non-empty（每个分组返回第一个非空的值）',
        },
      ],
      outputs: [
        {
          name: 'result',
          type: 'dynamic',
          description: '每个分组对应一个输出，值为该分组第一个非空的值',
        },
      ],
    },
  ],
  capability: '多分支汇合后需要统一取值时使用。',
};

const MULTI_CONDITION_PLUGIN: PluginCatalogEntry = {
  id: 'multi-condition',
  nodeType: 'multi-condition',
  name: '多条件分支',
  category: '流程控制',
  summary: '多条件组合的分支路由，支持且/或逻辑。',
  description:
    '每个分支可由多条条件按“且/或”组合，比条件分支支持更复杂的判断逻辑，并提供 else 兜底端口。运行时命中第一个满足条件的分支后继续执行。',
  tags: ['分支', '条件', '组合逻辑'],
  icon: 'icon-condition',
  tools: [
    {
      name: 'multi_condition_branch',
      description: '按多条件组合逻辑把流程路由到对应分支。',
      params: [
        {
          name: 'branch',
          type: 'array',
          required: true,
          description: '分支列表，每项包含 logic（and/or）与 conditions 条件数组',
        },
      ],
      outputs: [
        {
          name: 'branch',
          type: 'boolean',
          description: '每个分支对应一个动态输出端口，分支命中时走该端口',
        },
        { name: 'else', type: 'boolean', description: '所有分支都不满足时走 else 端口' },
      ],
    },
  ],
  capability: '需要多条件组合判断分支走向时使用。',
};

const LOOP_PLUGIN: PluginCatalogEntry = {
  id: 'loop',
  nodeType: 'loop',
  name: '循环',
  category: '流程控制',
  summary: '循环处理字符串或数字数组，最多 20 项。',
  description:
    '选择一个字符串或数字数组，按顺序逐项执行循环体中的同步 JavaScript 处理节点，并用循环输出收集每项结果。限制：数组最多 20 项，循环体固定为一个同步 JavaScript 节点，不支持嵌套、API、大语言模型、媒体、变量、继续或中断。',
  tags: ['循环', '批处理', '数组'],
  icon: 'icon-loop',
  tools: [
    {
      name: 'loop_batch',
      description: '对数组每一项串行执行处理脚本并汇总结果。',
      params: [
        {
          name: 'loopFor',
          type: 'array',
          required: true,
          description: '循环数组，仅支持字符串或数字数组，最多 20 项',
        },
        {
          name: 'code',
          type: 'string',
          required: false,
          description: '子画布内同步 JavaScript 节点的脚本，返回逐项处理结果',
        },
        {
          name: 'loopOutputs',
          type: 'object',
          required: true,
          description: '循环输出：从子画布节点选择每项要收集的输出字段',
        },
      ],
      outputs: [{ name: 'result', type: 'array', description: '每项处理结果组成的数组' }],
    },
  ],
  capability: '需要对数组每一项重复执行相同处理时使用。',
};

const VARIABLE_PLUGIN: PluginCatalogEntry = {
  id: 'variable',
  nodeType: 'variable',
  name: '变量赋值',
  category: '流程控制',
  summary: '变量赋值与声明。',
  description:
    'declare 操作可声明新变量（变量名以字母或下划线开头），assign 操作可修改流程中已有的顶层变量。赋值内容可以是固定值或上游变量引用，供下游节点使用。',
  tags: ['变量', '赋值', '状态'],
  icon: 'icon-variable',
  tools: [
    {
      name: 'variable_assign',
      description: '声明新变量或更新已有变量的值。',
      params: [
        {
          name: 'assign',
          type: 'array',
          required: true,
          description: '赋值列表，每项包含 operator（declare/assign）、变量名或目标变量与赋值内容',
        },
      ],
      outputs: [
        { name: 'variables', type: 'object', description: '声明或更新后的变量，可被下游按名称引用' },
      ],
    },
  ],
  capability: '需要保存中间结果或更新流程变量时使用。',
};

/** 插件目录按分类分组排列，顺序与画布添加节点面板一致。 */
export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  // 智能与内容
  LLM_PLUGIN,
  TEXT_PLUGIN,
  IMAGE_PLUGIN,
  VIDEO_PLUGIN,
  // 扩展能力
  HTTP_PLUGIN,
  CODE_PLUGIN,
  KNOWLEDGE_PLUGIN,
  SUBWORKFLOW_PLUGIN,
  MCP_PLUGIN,
  PYTHON_PLUGIN,
  // 流程控制
  CONDITION_PLUGIN,
  MULTI_CONDITION_PLUGIN,
  LOOP_PLUGIN,
  VARIABLE_PLUGIN,
  VARIABLE_AGGREGATOR_PLUGIN,
];
