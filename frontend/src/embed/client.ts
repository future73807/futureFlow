/**
 * `ff-embed/v1` 客户端的**运行时**（DOM / fetch / localStorage 都在这里，纯协议在 protocol.ts）。
 *
 * 内嵌模式下的完整时序：
 *   ① 读网关的 `/host/ff-embed/v1/capabilities`：**由网关**回答「谁可以嵌我、有哪些能力」，
 *      而不是采信 URL 参数——否则任意站点都能声称自己是宿主；
 *   ② 向宿主 hello（带协议版本）；宿主回 hello-ack（版本协商）→ identity（宿主令牌）
 *      → flow 拿令牌去**网关**换会话（服务端验签，前端不解析令牌）；
 *   ③ 宿主 theme 消息覆盖 `--ff-*` 视觉令牌并隐藏品牌；
 *   ④ 运行事件 / 导航通知经 postMessage 透出给宿主。
 *
 * 两条兜底纪律：
 *   - 版本不匹配 / origin 不在白名单 / 身份交换失败 → **降级到独立模式**并在界面明示
 *     （`getFfEmbedStatus()` 带可读原因），不静默、不半残；
 *   - 宿主消息一律 origin 白名单 + schema 校验，不认识的静默丢弃（页面里可能有别的库在 postMessage）。
 */

import { applyTheme } from '../utils/theme';
import { gatewayFetch } from '../utils/config';
import { setToken, setUser } from '../utils/auth';
import {
  buildMessage,
  buildRunEventMessage,
  FF_EMBED_PROTOCOL_VERSION,
  negotiateVersion,
  parseHostMessage,
  themeTokenToCssVar,
  type FfEmbedCapabilities,
  type FfEmbedIdentityMessage,
  type FfEmbedThemeMessage,
} from './protocol';

/**
 * 宿主 → flow 的站内导航（`ff-embed/navigate`）由 React 侧注册的 router 回调执行
 * （`FfEmbedNavigateBridge`，见 react.tsx）；embed 客户端本身在 Router 之外。
 */
let navigateHandler: ((path: string) => void) | null = null;

export function setFfEmbedNavigateHandler(handler: (path: string) => void): void {
  navigateHandler = handler;
}

export type FfEmbedStatus =
  /** 不在宿主里（或网关以独立模式运行）：一切照旧。 */
  | { state: 'standalone' }
  /** 在 iframe 里但尚未确认能否内嵌：首帧不渲染独立 chrome（防「独立 UI 闪现」）。
   *  探测结论只会落回 standalone / degraded / handshaking——不会停在这里。 */
  | { state: 'probing' }
  /** 已识别到宿主，正在握手（等 hello-ack / identity）。 */
  | { state: 'handshaking' }
  /** 握手完成：身份由宿主注入，界面随宿主。 */
  | { state: 'embedded'; capabilities: FfEmbedCapabilities; brand: boolean }
  /** 降级：宿主不可信 / 版本不匹配 / 身份交换失败——按独立模式跑，并把原因显示出来。 */
  | { state: 'degraded'; reason: string };

interface GatewayCapabilities {
  protocolVersion: string;
  mode: 'standalone' | 'embedded';
  capabilities: FfEmbedCapabilities;
  allowedOrigins: string[];
  sessionPath: string;
  notes: string[];
}

/** flow 这一侧支持的能力（六缝里 theme / navigation / events 由前端承担）。 */
const FLOW_CLIENT_CAPABILITIES: FfEmbedCapabilities = {
  identity: true,
  credentials: false,
  billing: false,
  events: true,
  theme: true,
  navigation: true,
};

let status: FfEmbedStatus = { state: 'standalone' };
const listeners = new Set<() => void>();

function setStatus(next: FfEmbedStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

export function getFfEmbedStatus(): FfEmbedStatus {
  return status;
}

export function subscribeFfEmbed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 内嵌形态且宿主没要求保留品牌时，隐藏 flow 自己的 logo / 名字。 */
export function shouldHideBrand(): boolean {
  // probing / handshaking 阶段也隐藏：首帧就不出现品牌，避免内嵌时闪现后又被隐藏
  if (status.state === 'probing' || status.state === 'handshaking') return true;
  return status.state === 'embedded' && !status.brand;
}

interface EmbedSession {
  parentOrigin: string;
  sessionPath: string;
  capabilities: FfEmbedCapabilities;
  allowedOrigins: readonly string[];
  brand: boolean;
}

let session: EmbedSession | null = null;
let runSeq = 0;

function post(message: Record<string, unknown>): void {
  if (!session || typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage(message, session.parentOrigin);
}

async function readCapabilities(): Promise<GatewayCapabilities | null> {
  try {
    const response = await gatewayFetch('/host/ff-embed/v1/capabilities');
    if (!response.ok) return null;
    return (await response.json()) as GatewayCapabilities;
  } catch {
    return null;
  }
}

/**
 * 判断「谁是宿主」。三者按可信度取：
 *  ① `location.ancestorOrigins`（浏览器自己给的，伪造不了）；
 *  ② 白名单**唯一**时的那个 origin；
 *  ③ `document.referrer` 的 origin（且必须在白名单里）。
 * 一个都拿不到就拒绝握手——宁可降级，也不把会话交给一个来历不明的 frame。
 */
function resolveParentOrigin(
  allowedOrigins: readonly string[],
  requiredVersion: string
): { origin: string } | { reason: string } {
  const ancestors = (window.location as unknown as { ancestorOrigins?: DOMStringList })
    .ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    const parent = ancestors[0];
    if (allowedOrigins.includes(parent)) return { origin: parent };
    return {
      reason: `宿主 origin (${parent}) 不在网关下发的白名单里（HOST_ALLOWED_ORIGINS），已降级为独立模式。`,
    };
  }

  if (allowedOrigins.length === 1) return { origin: allowedOrigins[0] };

  try {
    const referrerOrigin = document.referrer ? new URL(document.referrer).origin : '';
    if (referrerOrigin && allowedOrigins.includes(referrerOrigin)) {
      return { origin: referrerOrigin };
    }
  } catch {
    // 落到下面的拒绝分支
  }

  return {
    reason:
      `无法确定宿主 origin（白名单 ${allowedOrigins.length} 项、参考来源为空或不在白名单），` +
      `已降级为独立模式。协议版本 ${requiredVersion}。`,
  };
}

async function exchangeIdentity(hostToken: string, message: FfEmbedIdentityMessage): Promise<void> {
  const path = session?.sessionPath ?? '/host/ff-embed/v1/session';
  try {
    const response = await gatewayFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostToken }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      setStatus({
        state: 'degraded',
        reason: `宿主身份交换失败（${response.status}）：${detail || '网关未给出原因'}`,
      });
      return;
    }
    const payload = (await response.json()) as { accessToken: string; user: unknown };
    setToken(payload.accessToken);
    setUser(payload.user);

    if (session) {
      const brand = typeof message.brand === 'boolean' ? message.brand : session.brand;
      session.brand = brand;
      setStatus({ state: 'embedded', capabilities: session.capabilities, brand });
    }
    post(buildMessage('ff-embed/ready', { user: payload.user }));
  } catch (err) {
    setStatus({
      state: 'degraded',
      reason: `宿主身份交换失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function applyHostTheme(message: FfEmbedThemeMessage): void {
  if (message.mode) applyTheme(message.mode);
  for (const [key, value] of Object.entries(message.tokens ?? {})) {
    const cssVar = themeTokenToCssVar(key);
    if (cssVar) document.documentElement.style.setProperty(cssVar, value);
  }
  if (typeof message.brand === 'boolean' && session) {
    session.brand = message.brand;
    if (status.state === 'embedded') {
      setStatus({ ...status, brand: message.brand });
    }
  }
}

async function onMessage(event: MessageEvent): Promise<void> {
  if (!session) return;
  const message = parseHostMessage(event.data, {
    origin: event.origin,
    allowedOrigins: session.allowedOrigins,
  });
  if (!message) return;

  if (message.type === 'ff-embed/hello-ack') {
    const negotiation = negotiateVersion(message.version);
    if (!negotiation.ok) {
      setStatus({ state: 'degraded', reason: negotiation.reason });
    }
    return;
  }
  if (message.type === 'ff-embed/identity') {
    await exchangeIdentity(
      (message as FfEmbedIdentityMessage).hostToken,
      message as FfEmbedIdentityMessage
    );
    return;
  }
  if (message.type === 'ff-embed/navigate') {
    const path = (message as { path?: unknown }).path;
    if (typeof path === 'string') navigateHandler?.(path);
    return;
  }
  if (message.type === 'ff-embed/theme') {
    applyHostTheme(message as FfEmbedThemeMessage);
  }
}

/**
 * 启动一次握手（幂等：不在 iframe 里、或网关以独立模式运行时直接返回）。
 *
 * 返回是否进入握手（供启动期打点/测试断言用）。
 */
export async function initFfEmbed(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (window.parent === window) {
    // 直接打开（非 iframe）：确定性独立模式，同步落定——首帧就是完整 chrome，无闪烁。
    return false;
  }
  // 在 iframe 里：能否内嵌要等 capabilities 探测（异步）——**同步**先进入 probing，
  // 让首帧跳过独立 chrome 渲染（MainLayout / 工作流页都按此状态隐藏宿主不该出现的部分）。
  // 这个 setStatus 必须留在第一个 await 之前：晚一帧，独立 UI 就闪出来了。
  setStatus({ state: 'probing' });

  const capabilities = await readCapabilities();
  if (!capabilities) return false;
  if (capabilities.mode !== 'embedded') {
    // 网关自己就是独立模式：这个 iframe 里的页面照样是独立 UI（不当宿主对待）。
    setStatus({ state: 'standalone' });
    return false;
  }

  const resolved = resolveParentOrigin(capabilities.allowedOrigins, capabilities.protocolVersion);
  if ('reason' in resolved) {
    setStatus({ state: 'degraded', reason: resolved.reason });
    return false;
  }

  session = {
    parentOrigin: resolved.origin,
    sessionPath: capabilities.sessionPath,
    capabilities: capabilities.capabilities,
    allowedOrigins: capabilities.allowedOrigins,
    brand: false,
  };
  setStatus({ state: 'handshaking' });

  window.addEventListener('message', onMessage);
  window.addEventListener('beforeunload', () => {
    post(buildMessage('ff-embed/bye'));
  });

  post(
    buildMessage('ff-embed/hello', {
      capabilities: FLOW_CLIENT_CAPABILITIES,
      // 我方支持的协议版本之外，再报一次给宿主对读（消息体里也有 version）
      protocolVersion: FF_EMBED_PROTOCOL_VERSION,
    })
  );
  return true;
}

/** 运行事件透出给宿主（带 seq，宿主可断线重放）；独立形态是空操作。 */
export function publishRunEvent(input: {
  runId: string;
  seq?: number;
  type: string;
  payload: unknown;
}): void {
  if (status.state !== 'embedded') return;
  runSeq = typeof input.seq === 'number' ? input.seq : runSeq + 1;
  post(buildRunEventMessage({ ...input, seq: runSeq }));
}

/** 导航通知：让宿主知道 flow 里发生了什么（例如新建了工作流）。 */
export function notifyNavigation(payload: Record<string, unknown>): void {
  if (status.state !== 'embedded') return;
  post(buildMessage('ff-embed/navigation', payload));
}

/** 内嵌形态下的可读错误上报（宿主可以据此提示或记日志）。 */
export function notifyHostError(reason: string): void {
  if (status.state !== 'embedded') return;
  post(buildMessage('ff-embed/error', { reason }));
}
