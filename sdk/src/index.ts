/**
 * ff-embed/v1 宿主端 SDK —— 把 futureFlow 嵌进任意宿主应用。
 *
 * 用法（最小接入）：
 * ```ts
 * import { mountFlowEmbed } from "@futureflow/ff-embed-host-sdk";
 *
 * const embed = mountFlowEmbed({
 *   container: document.getElementById("flow-root")!,
 *   frontendUrl: "http://127.0.0.1:8090",          // flow 前端地址（origin）
 *   getIdentity: async () => {
 *     // 用你自己的会话换取宿主侧稳定身份（subject 即宿主用户 id）
 *     return { hostToken: await yourSessionToken() };
 *   },
 *   onNavigate: (path) => yourRouter.push(path),   // 可选：flow 请求站内跳转
 * });
 * ```
 *
 * 协议细节见 `docs/插件/flow插件集成规划.md` 与 flow 仓 `docs/ff-embed-v1.md`。
 * 安全模型：入站（flow → 宿主）消息一律校验 origin；`identity` 回调拿到的是
 * **宿主自己的令牌**，flow 前端只转交给它的网关去做服务端验签——SDK 不解析令牌内容。
 */

export const FF_EMBED_PROTOCOL_VERSION = "v1";

/** flow → 宿主 的入站消息（宿主按需消费，未注册监听的类型静默忽略）。 */
export type FfEmbedHostInbound =
  | { type: "ff-embed/ready"; user?: unknown }
  | {
      type: "ff-embed/run-event";
      runId: string;
      seq: number;
      eventType: string;
      payload: unknown;
      at: string;
    }
  | { type: "ff-embed/navigation"; [key: string]: unknown }
  | { type: "ff-embed/error"; reason?: string }
  | { type: "ff-embed/bye" };

export interface FlowEmbedOptions {
  /** iframe 挂载容器（必填，须有尺寸）。 */
  container: HTMLElement;
  /** flow 前端地址（origin 形式，如 http://127.0.0.1:8090）。 */
  frontendUrl: string;
  /**
   * 身份供给：返回**宿主自己的会话令牌**。flow 前端把它原样交给 flow 网关，
   * 网关回调宿主的 `/api/flow/host/identity` 做服务端验签——SDK 与 flow 前端
   * 都不解析令牌内容。
   */
  getIdentity: () => Promise<{ hostToken: string } | null>;
  /** 宿主侧导航回调：flow 请求跳转宿主的某个视图（如「工作流插件」入口高亮）。 */
  onNavigate?: (path: string) => void;
  /** 运行事件回调（带 run 内单调 seq，宿主可断线重放）。 */
  onRunEvent?: (event: Extract<FfEmbedHostInbound, { type: "ff-embed/run-event" }>) => void;
  /** flow 报告的可读错误（画布内已展示，这里供宿主记日志/提示）。 */
  onError?: (reason: string) => void;
  /** iframe 标题（无障碍）。 */
  title?: string;
}

export interface FlowEmbedHandle {
  /** 挂载的 iframe（宿主可追加样式类）。 */
  iframe: HTMLIFrameElement;
  /** 卸载：移除 iframe 与监听，并向 flow 发 bye。 */
  destroy: () => void;
}

interface InboundFrame {
  type: string;
  version?: unknown;
  path?: unknown;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 挂载 flow 前端并完成 ff-embed/v1 握手。幂等性由调用方保证（一次 mount 一个容器）。 */
export function mountFlowEmbed(options: FlowEmbedOptions): FlowEmbedHandle {
  const origin = new URL(options.frontendUrl).origin;
  let destroyed = false;

  const iframe = document.createElement("iframe");
  iframe.src = options.frontendUrl;
  iframe.title = options.title ?? "futureFlow";
  iframe.style.border = "0";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.allow = "clipboard-read; clipboard-write; fullscreen";
  options.container.appendChild(iframe);

  const post = (message: Record<string, unknown>): void => {
    if (destroyed) return;
    iframe.contentWindow?.postMessage(message, origin);
  };

  const onMessage = async (event: MessageEvent): Promise<void> => {
    if (destroyed || event.origin !== origin) return;
    if (!isRecord(event.data)) return;
    const message = event.data as InboundFrame;
    if (typeof message.type !== "string" || !message.type.startsWith("ff-embed/")) return;

    if (message.type === "ff-embed/hello") {
      // 版本协商：SDK 只会 v1；flow 侧版本不同时 hello-ack 照发，
      // flow 自己按「降级独立模式并在界面明示」处理（协议 §7）。
      post({ type: "ff-embed/hello-ack", version: FF_EMBED_PROTOCOL_VERSION });
      try {
        const identity = await options.getIdentity();
        if (!destroyed && identity?.hostToken) {
          post({ type: "ff-embed/identity", version: FF_EMBED_PROTOCOL_VERSION, hostToken: identity.hostToken });
        }
      } catch (error) {
        options.onError?.(`身份供给失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (message.type === "ff-embed/ready") {
      return;
    }
    if (message.type === "ff-embed/navigate") {
      const path = message.path;
      if (typeof path === "string" && path.startsWith("/") && path.length <= 256) {
        options.onNavigate?.(path);
      }
      return;
    }
    if (message.type === "ff-embed/run-event") {
      if (typeof message.runId === "string" && typeof message.seq === "number") {
        options.onRunEvent?.({
          type: "ff-embed/run-event",
          runId: message.runId,
          seq: message.seq,
          eventType: String(message.eventType ?? ""),
          payload: message.payload,
          at: String(message.at ?? ""),
        });
      }
      return;
    }
    if (message.type === "ff-embed/error") {
      options.onError?.(String(message.reason ?? "flow 未知错误"));
      return;
    }
    // ff-embed/bye：无需处理（destroy 时监听一并移除）
  };

  const messageListener = (event: MessageEvent): void => {
    void onMessage(event);
  };
  window.addEventListener("message", messageListener);

  const handle: FlowEmbedHandle = {
    iframe,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      post({ type: "ff-embed/bye", version: FF_EMBED_PROTOCOL_VERSION });
      window.removeEventListener("message", messageListener);
      iframe.remove();
    },
  };
  return handle;
}
