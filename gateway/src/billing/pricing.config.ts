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
  // GLM 系列（网关统一执行模型）
  'glm-5.3-flash': { input: 0.001, output: 0.002 },
  'gemini-pro': { input: 0.0005, output: 0.0015 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  'qwen-turbo': { input: 0.0005, output: 0.001 },
  'qwen-plus': { input: 0.002, output: 0.006 },
  'qwen-max': { input: 0.005, output: 0.02 },
};

/** 默认定价(未在表中列出的模型) */
export const DEFAULT_PRICING = { input: 0.005, output: 0.015 };

/**
 * 每 1K token 的单价（元）。
 *
 * **预估（冻结）与结算必须共用本函数**：原先两处各有一份定价表且算法不同，导致
 * 同一模型在两处的价格最高差 53 倍（gemini-1.5-flash 冻结按 0.01、结算按
 * 0.0001875），用户会被「余额不足」误拦；反向的偏差（claude-3-opus 冻结仅为结算的
 * 0.22 倍）则可能让结算金额超过冻结额。
 *
 * 入参与出参都不含 token 数，只表达「费率」本身，便于两处复用与测试。
 */
export function pricePer1KTokens(modelName: string): number {
  const pricing = MODEL_PRICING[modelName] || DEFAULT_PRICING;
  return (pricing.input + pricing.output) / 2;
}
