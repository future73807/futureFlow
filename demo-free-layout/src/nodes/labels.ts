/**
 * 节点类型中文名称映射
 * 用于节点面板列表和画布上的节点显示
 */
export const NodeLabels: Record<string, string> = {
  start: '开始',
  end: '结束',
  llm: '大语言模型',
  text: '文本处理',
  image: '图片处理',
  video: '视频处理',
  http: 'API 请求',
  code: '代码执行',
  variable: '变量赋值',
  condition: '条件分支',
  'multi-condition': '多条件分支',
  loop: '数组批处理',
  comment: '注释',
  group: '分组',
  'block-start': '块开始',
  'block-end': '块结束',
  continue: '继续',
  break: '中断',
};

/**
 * 节点中文描述映射
 */
export const NodeDescriptions: Record<string, string> = {
  start: '工作流的起始节点，用于设置启动工作流所需的信息。',
  end: '工作流的最终节点，用于返回工作流运行后的结果信息。',
  llm: '调用大语言模型，使用变量和提示词生成回复。',
  text: '组合、传递或格式化文本，支持引用上游变量。',
  image: '传递已有图片，或调用 OpenAI、Google、豆包、MiniMax 原生生成图片。',
  video: '传递已有视频，或调用 OpenAI、Google、豆包、MiniMax 创建和查询视频任务。',
  http: '调用外部 API，支持认证、请求头、参数、请求体、超时和重试。',
  code: '执行自定义 JavaScript 逻辑，可在本地试运行并发布到云端。',
  variable: '新建变量，或修改流程中已有变量的值。',
  condition: '连接多个下游分支，满足条件时执行对应分支。',
  'multi-condition': '多条件分支，支持更复杂的条件逻辑。',
  loop: '串行处理字符串或数字数组；最多 20 项，每项执行一次同步 JavaScript。',
  comment: '注释节点，用于添加说明备注。',
  group: '分组节点，将多个节点组织为一组。',
  'block-start': '块起始节点。',
  'block-end': '块结束节点。',
  continue: '跳过当前循环迭代；当前版本仅展示，暂不可运行或发布。',
  break: '跳出当前循环；当前版本仅展示，暂不可运行或发布。',
};
