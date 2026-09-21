import { getToken } from '../../utils/auth';
import { GATEWAY_URL } from '../../utils/config';

/**
 * 缓存的 LLM 代理票据。
 *
 * 试运行在浏览器端执行，LLM 节点只能把凭证放进节点输入里再由 runtime-js 发出。
 * 直接塞登录 JWT 会让 7 天有效的长期令牌随工作流定义一起落库，所以改由网关签发
 * 一张只能调 LLM 代理的短期票（默认 10 分钟）。这里缓存它，并在临近过期时续期。
 */
let cachedTicket: { ticket: string; expiresAtMs: number } | null = null;

/** 剩余不足这个时长就提前续期，避免长流程跑到一半票据失效。 */
const TICKET_RENEW_MARGIN_MS = 60_000;
const FALLBACK_TTL_MS = 600_000;

/** 同步读取有效票据；没有则返回 null（此时节点会退回到占位串，由网关给出明确报错）。 */
export const peekLlmProxyTicket = (): string | null => {
  if (cachedTicket && cachedTicket.expiresAtMs > Date.now()) return cachedTicket.ticket;
  return null;
};

/**
 * 在执行前预取票据。
 *
 * 取出失败时**不抛错**：未登录、网关未配置 LLM、或网关版本较旧没有该端点，
 * 都不应该让整条试运行链路在准备阶段就崩掉——让 LLM 节点自己带着明确报错失败，
 * 比在这里抛一个与 LLM 无关的异常更容易定位。
 */
export const ensureLlmProxyTicket = async (): Promise<string | null> => {
  if (cachedTicket && cachedTicket.expiresAtMs - Date.now() > TICKET_RENEW_MARGIN_MS) {
    return cachedTicket.ticket;
  }
  const token = getToken();
  if (!token) {
    cachedTicket = null;
    return null;
  }
  try {
    const response = await fetch(`${GATEWAY_URL}/llm/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      cachedTicket = null;
      return null;
    }
    const data = (await response.json()) as { ticket?: unknown; ttlSeconds?: unknown };
    const ticket = typeof data.ticket === 'string' ? data.ticket : '';
    if (!ticket) {
      cachedTicket = null;
      return null;
    }
    const ttlSeconds = Number(data.ttlSeconds);
    const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : FALLBACK_TTL_MS;
    cachedTicket = { ticket, expiresAtMs: Date.now() + ttlMs };
    return ticket;
  } catch {
    cachedTicket = null;
    return null;
  }
};

/** 测试用：清空缓存，避免用例之间互相污染。 */
export const resetLlmProxyTicketCache = (): void => {
  cachedTicket = null;
};

/**
 * 浏览器「试运行」由 runtime-js 直接执行大语言模型节点，执行器要求
 * apiKey / apiHost 两个输入。模型服务商不允许浏览器跨域直连，且 API Key
 * 不能下发到前端，因此这里把节点输入指到网关的 LLM 直连代理：
 *
 *   POST ${GATEWAY_URL}/llm/chat/completions
 *
 * 网关使用服务端配置的 LLM_API_KEY / LLM_DEFAULT_MODEL 完成真实调用，
 * 用户无需（也不能）在画布上手工填写密钥。仅当节点没有填写过这些输入
 * 时才注入，保留显式自定义行为的可能。
 */
export const prepareLLMNodesForRuntime = <T extends { nodes?: any[] }>(schema: T): T => {
  if (!Array.isArray(schema.nodes)) return schema;

  const transformNode = (node: any): any => {
    const blocks = Array.isArray(node.blocks) ? node.blocks.map(transformNode) : node.blocks;
    if (node.type !== 'llm') {
      return blocks === node.blocks ? node : { ...node, blocks };
    }

    const inputs = { ...(node.data?.inputs || { type: 'object', properties: {} }) };
    inputs.properties = {
      ...(inputs.properties || {}),
      apiKey: { type: 'string', title: 'API 密钥' },
      apiHost: { type: 'string', title: 'API 地址' },
    };

    const inputsValues = { ...(node.data?.inputsValues || {}) };
    if (!inputsValues.apiHost) {
      inputsValues.apiHost = { type: 'constant', content: `${GATEWAY_URL}/llm` };
    }
    if (!inputsValues.apiKey) {
      // 没有票据时退回占位串：网关会因此拒绝并给出「缺少 LLM 代理票据」的明确
      // 报错，好过这里静默填一个看起来像凭证的值。
      inputsValues.apiKey = {
        type: 'constant',
        content: peekLlmProxyTicket() ?? 'managed-by-gateway',
      };
    }

    return {
      ...node,
      blocks,
      data: {
        ...(node.data || {}),
        inputs,
        inputsValues,
      },
    };
  };

  return { ...schema, nodes: schema.nodes!.map(transformNode) };
};