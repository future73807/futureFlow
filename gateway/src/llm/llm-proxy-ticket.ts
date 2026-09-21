/**
 * LLM 直连代理的短期票据（纯函数部分）。
 *
 * 背景：浏览器「试运行」在前端直接跑 runtime-js，大语言模型节点会拿节点输入里的
 * apiKey 当 Bearer 令牌去请求网关的 /llm/chat/completions。此前那个位置填的是
 * 占位串 `managed-by-gateway`，而网关**完全不校验**——于是谁能连到网关端口，谁就
 * 能花掉平台级的 LLM_API_KEY（全项目没有全局守卫，且该控制器上没有任何 guard）。
 *
 * 修法是给这个端点发一张专用短期票据：
 *   - 必须登录才能领（/llm/ticket 挂 JwtAuthGuard）；
 *   - 用途受限（type = llm_proxy，不能拿来访问其它接口）；
 *   - 有效期很短（默认 10 分钟），因为它会被写进节点的 inputsValues —— 万一
 *     工作流被保存，落到库里的也只是一张很快失效、且只能调 LLM 的票。
 *
 * 之所以不直接复用登录 JWT：那是个 7 天有效的长期令牌，一旦随工作流定义落库
 * 就是长期凭据泄露。票据把「落库风险」压到 10 分钟。
 */

/** 票据的用途标记，与 media_execution 等既有专用令牌保持同一套约定。 */
export const LLM_PROXY_TOKEN_TYPE = 'llm_proxy';

/** 默认有效期（秒）。可通过 LLM_PROXY_TICKET_TTL_SECONDS 覆盖。 */
export const DEFAULT_LLM_TICKET_TTL_SECONDS = 600;

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

/**
 * 解析票据有效期（纯函数）。
 *
 * 非法值一律回落到默认值而不是报错——这是可用性配置，写错了让功能按默认跑，
 * 比让整个试运行起不来更合适。上下限用于挡住「写了个 0」或「写了个 99999999」
 * 这种两端极端值。
 */
export function resolveLlmTicketTtlSeconds(raw?: string | null): number {
  const parsed = Number((raw ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_TICKET_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(parsed), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

/**
 * 收紧请求里与单次成本直接相关的字段（纯函数）。
 *
 * `/llm` 的请求体是原样转发给上游的，而上游用的是**平台自己的** API Key——票据和
 * 限流只约束了「谁、一分钟几次」，完全没约束单次花多少钱。一个登录用户只要把
 * max_tokens 写成几十万、或让 n=10，就能在配额内把额度放大几个数量级。
 *
 * 这里只动成本字段，其余原样透传：重塑整个请求体会打断正常调用（比如流式、工具
 * 调用），不值得为防滥用付出这个代价。
 */
export function clampLlmCostFields(
  body: Record<string, any> | undefined,
  limits: { maxTokens: number; maxCompletions: number },
): { payload: Record<string, any>; clamped: string[] } {
  const payload = { ...(body || {}) };
  const clamped: string[] = [];

  const tokens = Number(payload.max_tokens);
  if (Number.isFinite(tokens) && tokens > limits.maxTokens) {
    payload.max_tokens = limits.maxTokens;
    clamped.push(`max_tokens 收敛到 ${limits.maxTokens}`);
  }

  const completions = Number(payload.n);
  if (Number.isFinite(completions) && completions > limits.maxCompletions) {
    payload.n = limits.maxCompletions;
    clamped.push(`n 收敛到 ${limits.maxCompletions}`);
  }

  return { payload, clamped };
}

export type LlmTokenDecision =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 判断一个已验签的令牌能否用于 LLM 代理（纯函数，只看解码后的负载）。
 *
 * 接受两类：本文件签发的专用票据，以及普通登录令牌（后者权限更强，放行它既能
 * 让 API 调用方继续工作，也不构成降权）。明确拒绝其它专用令牌——它们的用途不同，
 * 混用会让「限定用途令牌」这一约定失效。
 */
export function classifyLlmProxyToken(payload: unknown): LlmTokenDecision {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: '令牌无效' };
  }
  const claims = payload as { sub?: unknown; type?: unknown };
  // 媒体执行令牌是给 Dify 容器回调用的，持有者不应因此获得 LLM 额度
  if (claims.type === 'media_execution') {
    return { ok: false, reason: '媒体执行令牌不能访问此接口' };
  }
  if (typeof claims.sub === 'string' && claims.sub) {
    return { ok: true };
  }
  return { ok: false, reason: '令牌缺少用户信息' };
}
