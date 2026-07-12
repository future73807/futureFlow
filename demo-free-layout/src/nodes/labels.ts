/**
 * 节点类型中文名称映射
 * 用于节点面板列表和画布上的节点显示
 */
export const NodeLabels: Record<string, string> = {
  start: '开始',
  end: '结束',
  llm: '大语言模型',
  http: 'HTTP 请求',
  code: '代码执行',
  variable: '变量赋值',
  condition: '条件分支',
  'multi-condition': '多条件分支',
  loop: '循环',
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
  http: '调用 HTTP API 接口。',
  code: '执行自定义代码逻辑。',
  variable: '设置或修改变量值。',
  condition: '连接多个下游分支，满足条件时执行对应分支。',
  'multi-condition': '多条件分支，支持更复杂的条件逻辑。',
  loop: '循环节点，对容器内节点重复执行。',
  comment: '注释节点，用于添加说明备注。',
  group: '分组节点，将多个节点组织为一组。',
  'block-start': '块起始节点。',
  'block-end': '块结束节点。',
  continue: '跳过当前循环迭代，进入下一次循环。',
  break: '跳出当前循环。',
};
