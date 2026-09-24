/**
 * 宿主适配层（Host Adapter）——六缝的 **Definition**（能力契约）。
 *
 * 为什么要有这一层：flow 子系统要同时成立两种形态（《flow 集成方案》`DEC-10`）——
 * **独立模式**自带登录 / 自带余额 / 自有品牌；**内嵌模式**被宿主应用嵌进自己的界面里，
 * 由宿主签发身份、下发引擎凭证、承担计费、承载事件、提供视觉令牌、接收导航通知。
 *
 * 纪律（与主仓「能力缝三元组」同一条）：
 *  1. 每个缝都必须有 **Definition（本文件）+ Provider（standalone / embedded 两套）+ Consumer（真实调用方）**，
 *     只写实现不声明接口与消费方的「半个缝」不允许合入；
 *  2. **独立 Provider 是兜底**：宿主不可信、或某项能力宿主没提供时，flow 降级到自带实现继续跑，
 *     而不是崩溃或半残；
 *  3. 降级必须**明示原因**（见 {@link HostCapabilities} 的 `notes`），不放无提示的空壳；
 *  4. 模式差异只准落在这六个缝上——画布、执行链路、DSL 转换里**禁止**出现 `if (embedded)` 之类的分支。
 */

/** `ff-embed` 协议版本。两侧各自声明，**版本不匹配时降级到独立模式并在界面明示**。 */
export const FF_EMBED_PROTOCOL_VERSION = 'v1';

/** 运行形态：自带一切的独立形态，或挂在宿主里的内嵌形态。 */
export type HostMode = 'standalone' | 'embedded';

/** 六缝的名字（顺序即协议里 capabilities 的键序，便于两侧对读）。 */
export const HOST_CAPABILITY_NAMES = [
  'identity',
  'credentials',
  'billing',
  'events',
  'theme',
  'navigation',
] as const;

export type HostCapabilityName = (typeof HOST_CAPABILITY_NAMES)[number];

/**
 * 能力归属：`true` = 该项**由宿主承担**；`false` = 走 flow 自带兜底。
 *
 * 注意这不是「能不能用」的开关——某一项为 false 只说明它由自己实现，
 * 每一项在两种形态下都必须可用（独立 Provider 常驻可用）。
 */
export type HostCapabilities = Record<HostCapabilityName, boolean>;

/** 宿主下发的身份（服务端交换后得到的稳定外部标识）。 */
export interface HostIdentity {
  /** 宿主侧稳定用户标识；flow 据此 get-or-create，不信任前端传来的任何身份字段。 */
  subject: string;
  displayName?: string;
  email?: string;
}

/**
 * 引擎凭证的解析结果。
 *
 * `local` = 用本机 `.env` 里的全局密钥（独立模式的常态）；
 * `host` = 宿主下发的凭证（内嵌模式：宿主自己的 BYOK 实例 / 第三方网关）。
 * 契约里**没有**省略状态：要么本地、要么宿主，避免「未配置时静默回落」这类不可见行为。
 */
export type EngineCredentialsResolution =
  | { source: 'local' }
  | { source: 'host'; apiBase: string; apiKey: string; label?: string };

export interface HostIdentityProvider {
  readonly kind: HostMode;
  readonly capabilities: HostCapabilities;
  /**
   * 用宿主下发的令牌换取外部身份。
   *
   * 独立模式没有宿主，调用即明确拒绝（**不静默降级**：静默会让宿主以为自己接通了）。
   */
  resolveIdentity(hostToken: string): Promise<HostIdentity>;
}

export interface HostCredentialsProvider {
  readonly kind: HostMode;
  readonly capabilities: HostCapabilities;
  resolveEngineCredentials(): Promise<EngineCredentialsResolution>;
}

/**
 * 计费缝：三段事务（预扣 / 结算 / 退款）+ 计价。
 *
 * 方法形状刻意与既有的 `BillingService` **逐参对齐**（多一个可选的 `usage`）：
 * 这样独立 Provider 就是一层薄转发，`WorkflowsService` 的调用点只换类型、不换调用形状，
 * 改造前后行为一致这件事实也就更容易被既有回归锁住。
 * 幂等键统一用 flow 的 run id（宿主按 `runId + op` 去重）。
 */
export interface HostBillingProvider {
  readonly kind: HostMode;
  readonly capabilities: HostCapabilities;
  /** 预扣：余额不足 / 宿主拒付时抛错，run 直接失败。返回冻结金额。 */
  freezeBalance(userId: string, estimatedCost: number, runId: string): Promise<number>;
  /**
   * 结算：解冻预扣 + 扣实际费用。`usage` 是给宿主折算自己计费单位的用量明细
   * （token / 步数 / 模型 / 引擎），独立实现忽略它。
   */
  settleBilling(
    userId: string,
    frozenAmount: number,
    actualCost: number,
    runId: string,
    remark: string,
    usage?: Record<string, unknown>,
  ): Promise<void>;
  /** 退款：执行失败或被客户端取消时全额解冻。 */
  refund(userId: string, frozenAmount: number, runId: string): Promise<void>;
  /** 计价（元）：`difyTotalPrice` 是引擎上报的美元价，存在时优先于本地价目表。 */
  calculateCost(
    totalTokens: number,
    modelName: string,
    difyTotalPrice?: number,
  ): number;
}

/** 一条要透出给宿主的运行事件（带该 run 内单调递增的 seq，供宿主做断线重放）。 */
export interface HostRunEvent {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  at: string;
}

export interface HostEventSink {
  readonly kind: HostMode;
  readonly capabilities: HostCapabilities;
  publish(event: HostRunEvent): Promise<void>;
  /** 冲刷缓冲（run 结束 / 进程退出前调用；独立实现为空操作）。 */
  flush(): Promise<void>;
}

/** DI 令牌：Definition 的注入点（消费者按令牌取 Provider，不认具体实现）。 */
export const HOST_CONFIG = 'HOST_CONFIG';
export const HOST_IDENTITY = 'HOST_IDENTITY';
export const HOST_CREDENTIALS = 'HOST_CREDENTIALS';
export const HOST_BILLING = 'HOST_BILLING';
export const HOST_EVENTS = 'HOST_EVENTS';

/** 独立形态的能力归属（六项全部自带；theme/navigation 由前端消费者直接读 mode）。 */
export const LOCAL_CAPABILITIES: HostCapabilities = {
  identity: false,
  credentials: false,
  billing: false,
  events: false,
  theme: false,
  navigation: false,
};
