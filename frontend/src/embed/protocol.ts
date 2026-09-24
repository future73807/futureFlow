/**
 * `ff-embed/v1` 协议（纯逻辑，无 DOM/React 依赖，便于单测）。
 *
 * 两侧的角色分工：
 *   - **宿主（host）**：承载 iframe 的应用。它签发身份、可下发引擎凭证 / 承担计费 /
 *     接收事件 / 提供视觉令牌 / 接收导航通知；
 *   - **flow（本前端）**：被嵌的一方。它**不信任宿主消息**——入站消息一律走
 *     origin 白名单 + schema 校验（安全边界见《flow 集成方案》§3.3）。
 *
 * 版本协商：两侧各自声明支持的版本，不匹配即**降级到独立模式并在界面明示**
 * （不放无提示的空壳）。`v1` 对外承诺稳定：破坏性变更必须升版本号 + 给兼容窗口。
 */

export const FF_EMBED_PROTOCOL_VERSION = 'v1';

/** 握手 / 协商 / 身份 / 视觉 / 导航 / 事件 / 卸载 —— v1 的全部消息类型。 */
export const FF_EMBED_MESSAGE_TYPES = [
  // flow → 宿主
  'ff-embed/hello',
  'ff-embed/ready',
  'ff-embed/run-event',
  'ff-embed/navigation',
  'ff-embed/error',
  'ff-embed/bye',
  // 宿主 → flow
  'ff-embed/hello-ack',
  'ff-embed/identity',
  'ff-embed/theme',
  // 内嵌形态下导航由宿主侧栏承担（flow 自己的侧栏隐藏）：
  // 宿主侧栏点「工作流 / 任务中心」时发这条，flow 据此路由跳转。
  'ff-embed/navigate',
] as const;

export type FfEmbedMessageType = (typeof FF_EMBED_MESSAGE_TYPES)[number];

const FLOW_TO_HOST = new Set<FfEmbedMessageType>([
  'ff-embed/hello',
  'ff-embed/ready',
  'ff-embed/run-event',
  'ff-embed/navigation',
  'ff-embed/error',
  'ff-embed/bye',
]);

const HOST_TO_FLOW = new Set<FfEmbedMessageType>([
  'ff-embed/hello-ack',
  'ff-embed/identity',
  'ff-embed/theme',
  'ff-embed/navigate',
]);

export interface FfEmbedMessage {
  type: FfEmbedMessageType;
  version: string;
  [key: string]: unknown;
}

/** 宿主在 capabilities 里声明的六缝归属（与网关 `/host/ff-embed/v1/capabilities` 同形）。 */
export interface FfEmbedCapabilities {
  identity: boolean;
  credentials: boolean;
  billing: boolean;
  events: boolean;
  theme: boolean;
  navigation: boolean;
}

export interface FfEmbedIdentityMessage extends FfEmbedMessage {
  type: 'ff-embed/identity';
  /** 宿主签发的令牌；flow 只把它交给**网关**去验签，前端不解析它。 */
  hostToken: string;
}

export interface FfEmbedNavigateMessage extends FfEmbedMessage {
  type: 'ff-embed/navigate';
  /** flow 内部路由路径（必须以 `/` 开头，防宿主消息把页面带去任意外部 URL）。 */
  path: string;
}

export interface FfEmbedThemeMessage extends FfEmbedMessage {
  type: 'ff-embed/theme';
  /** `--ff-*` 视觉令牌（宿主的外观变量，直接覆盖到 :root）。 */
  tokens?: Record<string, string>;
  mode?: 'light' | 'dark';
  /** 内嵌形态默认去品牌；宿主可显式要求保留（用于 demo / 文档站）。 */
  brand?: boolean;
}

export type VersionNegotiation = { ok: true } | { ok: false; reason: string };

/**
 * 版本协商。两侧各报一个版本字符串；相同才算谈成。
 *
 * 不匹配时**不抛异常**：由调用方降级到独立模式并在界面明示（错误信息要能给人看）。
 */
export function negotiateVersion(hostVersion: unknown): VersionNegotiation {
  if (typeof hostVersion !== 'string' || !hostVersion.trim()) {
    return {
      ok: false,
      reason: '宿主没有声明 ff-embed 协议版本（缺少 hello-ack.version）',
    };
  }
  if (hostVersion !== FF_EMBED_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason:
        `协议版本不匹配：宿主 ${hostVersion}，flow ${FF_EMBED_PROTOCOL_VERSION}。` +
        '请升级落后的一侧；本次已降级为独立模式运行。',
    };
  }
  return { ok: true };
}

/** 入站消息的 origin 白名单判定（白名单由**网关**下发，不采信 URL 参数）。 */
export function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.some((allowed) => allowed === origin);
}

/**
 * 校验一条宿主入站消息。
 *
 * 返回 `null` 表示「不认识 / 不合规」——调用方**静默丢弃**并计数（不抛错）：
 * 页面里可能同时有别的库在 postMessage，把噪音当故障会让排查看错方向。
 */
export function parseHostMessage(
  raw: unknown,
  context: { origin: string; allowedOrigins: readonly string[] }
): FfEmbedMessage | null {
  if (!isAllowedOrigin(context.origin, context.allowedOrigins)) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string') return null;
  if (!HOST_TO_FLOW.has(type as FfEmbedMessageType)) return null;

  const message: FfEmbedMessage = {
    ...candidate,
    type: type as FfEmbedMessageType,
    version: typeof candidate.version === 'string' ? candidate.version : '',
  };

  if (message.type === 'ff-embed/identity') {
    const token = candidate.hostToken;
    if (typeof token !== 'string' || !token.trim()) return null;
    if (token.length > 8 * 1024) return null;
    return { ...message, hostToken: token };
  }

  if (message.type === 'ff-embed/navigate') {
    const path = candidate.path;
    // 只收站内路径：防宿主消息把页面带去任意外部 URL
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 256) return null;
    return { ...message, path };
  }

  if (message.type === 'ff-embed/theme') {
    const tokens = candidate.tokens;
    if (tokens !== undefined) {
      if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
        return null;
      }
      for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
        // 视觉令牌只接受 `--ff-*`（防注入任意 CSS 变量）且值必须是短字符串。
        if (!key.startsWith('--ff-') || typeof value !== 'string' || value.length > 200) {
          return null;
        }
      }
    }
    const mode = candidate.mode;
    if (mode !== undefined && mode !== 'light' && mode !== 'dark') return null;
    const brand = candidate.brand;
    if (brand !== undefined && typeof brand !== 'boolean') return null;
    return message;
  }

  return message;
}

/** 构造出站消息（统一带协议版本，宿主据此判断对端版本）。 */
export function buildMessage(
  type: FfEmbedMessageType,
  payload: Record<string, unknown> = {}
): FfEmbedMessage {
  if (!FLOW_TO_HOST.has(type)) {
    throw new Error(`buildMessage 只用于 flow → 宿主 的消息，收到：${type}`);
  }
  return { type, version: FF_EMBED_PROTOCOL_VERSION, ...payload };
}

/**
 * 视觉令牌 → CSS 变量名。
 *
 * 内嵌形态让 flow 的界面**随宿主**：宿主给什么就覆盖什么（`--ff-primary` 这类），
 * 我们自己的默认值仍在 `styles/index.css` 里兜底（宿主没给的令牌不会被清空）。
 */
export function themeTokenToCssVar(token: string): string | null {
  const name = token.trim();
  if (!name.startsWith('--ff-')) return null;
  return name;
}

/** 运行事件 → 宿主事件消息（run-event）：带 seq，宿主可做断线重放。 */
export function buildRunEventMessage(input: {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
}): FfEmbedMessage {
  return buildMessage('ff-embed/run-event', {
    runId: input.runId,
    seq: input.seq,
    eventType: input.type,
    payload: input.payload,
    at: new Date().toISOString(),
  });
}
