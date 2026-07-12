/**
 * 模型定价表(元 / 1K tokens)
 * 实际生产环境应从数据库或外部配置读取
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-3.5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  'deepseek-chat': { input: 0.001, output: 0.002 },
  'deepseek-reasoner': { input: 0.004, output: 0.016 },
  // DeepSeek v4 系列（用户提供的配置）
  'deepseek-v4-pro': { input: 0.002, output: 0.008 },
  'deepseek-v4-flash': { input: 0.0005, output: 0.002 },
  'gemini-pro': { input: 0.0005, output: 0.0015 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  'qwen-turbo': { input: 0.0005, output: 0.001 },
  'qwen-plus': { input: 0.002, output: 0.006 },
  'qwen-max': { input: 0.005, output: 0.02 },
};

/** 默认定价(未在表中列出的模型) */
export const DEFAULT_PRICING = { input: 0.005, output: 0.015 };
