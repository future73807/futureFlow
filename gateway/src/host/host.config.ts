import { Logger } from '@nestjs/common';

import {
  FF_EMBED_PROTOCOL_VERSION,
  type HostCapabilities,
  type HostMode,
} from './host.types';

/**
 * 宿主适配层的配置（fail loud）。
 *
 * 三条口径：
 *  ① `HOST_MODE` 缺省 `standalone`——**不配就是独立模式**，存量部署升级后行为不变；
 *  ② 内嵌模式缺关键配置（共享密钥 / 身份验签地址）**启动期直接报错**，不猜、不半残；
 *  ③ 凭证 / 计费 / 事件三项**可以缺**——缺项即该缝走 flow 自带兜底，但必须在
 *     capabilities 的 notes 里写明原因（降级要能被看见）。
 */
export interface HostConfig {
  mode: HostMode;
  protocolVersion: string;
  /** 网关 → 宿主回调时出示的共享密钥（内嵌模式必填）。 */
  sharedSecret: string;
  /** 宿主渲染方的 origin 白名单（前端据此校验入站 postMessage）。 */
  allowedOrigins: string[];
  /** 宿主提供的回调地址；'' 表示该缝未提供，走自带兜底。 */
  endpoints: {
    identity: string;
    credentials: string;
    billing: string;
    events: string;
  };
  requestTimeoutMs: number;
  /** 宿主开户用户在本网关的 VIP 档位（决定节点权限；宿主承担计费时默认 pro）。 */
  hostUserVipLevel: 'free' | 'pro' | 'enterprise';
}

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_SECRET_LENGTH = 16;

function readMode(raw: string | undefined): HostMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'standalone') return 'standalone';
  if (value === 'embedded') return 'embedded';
  throw new Error(
    `HOST_MODE 取值非法：${raw}。只接受 standalone（缺省）或 embedded；`
    + '写错时按独立模式静默启动会让宿主以为自己接通了，所以这里直接失败。',
  );
}

function readOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        const url = new URL(item);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('非 http(s)');
        }
        return url.origin;
      } catch {
        throw new Error(
          `HOST_ALLOWED_ORIGINS 里的来源不合法：${item}。`
          + '请写成 origin 形式（例如 http://127.0.0.1:3000），不要带路径。',
        );
      }
    });
}

function readEndpoint(raw: string | undefined, envName: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${envName} 不是合法 URL：${value}。内嵌模式下网关要用它回调宿主，`
      + '写错会在运行时才以「宿主不可达」暴露，所以这里直接失败。',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${envName} 只支持 http/https：${value}`);
  }
  return value;
}

function readTimeout(raw: string | undefined): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  if (value < 200 || value > 60_000) {
    throw new Error(
      `HOST_REQUEST_TIMEOUT_MS 应在 200~60000 之间，当前 ${raw}。`
      + '过小会把宿主的正常响应误判成故障，过大则会让一次 run 卡在回调上。',
    );
  }
  return value;
}

/**
 * 读环境变量的最小接口：`ConfigService` 与 `environment.validation.ts` 的纯 map 都满足它，
 * 于是**宿主配置的校验只有一处**（启动早期与模块实例化都走本函数，不写两份规则）。
 */
export interface HostEnvReader {
  get<T = string>(key: string): T | undefined;
}

export function readHostConfig(config: HostEnvReader): HostConfig {
  const logger = new Logger('HostConfig');
  const mode = readMode(config.get<string>('HOST_MODE'));
  const sharedSecret = (config.get<string>('HOST_SHARED_SECRET') ?? '').trim();
  const endpoints = {
    identity: readEndpoint(
      config.get<string>('HOST_IDENTITY_VERIFY_URL'),
      'HOST_IDENTITY_VERIFY_URL',
    ),
    credentials: readEndpoint(
      config.get<string>('HOST_CREDENTIALS_URL'),
      'HOST_CREDENTIALS_URL',
    ),
    billing: readEndpoint(
      config.get<string>('HOST_BILLING_URL'),
      'HOST_BILLING_URL',
    ),
    events: readEndpoint(
      config.get<string>('HOST_EVENTS_URL'),
      'HOST_EVENTS_URL',
    ),
  };
  const allowedOrigins = readOriginList(
    config.get<string>('HOST_ALLOWED_ORIGINS'),
  );

  if (mode === 'embedded') {
    if (sharedSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        'HOST_MODE=embedded 时必须配置 HOST_SHARED_SECRET（至少 '
        + `${MIN_SECRET_LENGTH} 位）。网关用它向宿主验签 / 回调；缺了它，`
        + '任何人都能伪造宿主身份换到会话。',
      );
    }
    if (!endpoints.identity) {
      throw new Error(
        'HOST_MODE=embedded 时必须配置 HOST_IDENTITY_VERIFY_URL：'
        + '内嵌模式的身份只能由宿主服务端验签后给出，缺了它无法判断「你是谁」。',
      );
    }
    if (!endpoints.identity.startsWith('https://')
      && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(endpoints.identity)) {
      logger.warn(
        `HOST_IDENTITY_VERIFY_URL 使用明文 http 且不是回环地址（${endpoints.identity}）：`
        + '宿主令牌会以明文过网。生产环境请走 https。',
      );
    }
    if (allowedOrigins.length === 0) {
      logger.warn(
        'HOST_ALLOWED_ORIGINS 为空：前端会拒绝一切入站 postMessage，'
        + '内嵌握手将停在「等待宿主 hello」这一步。请填宿主的 origin。',
      );
    }
    const missing = Object.entries(endpoints)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      logger.warn(
        `内嵌模式缺少回调地址：${missing.join(', ')}——对应缝回落自带实现`
        + '（凭证→.env 全局密钥 / 计费→自带 balance / 事件→仅本地 SSE）。',
      );
    }
  } else if (Object.values(endpoints).some(Boolean) || sharedSecret) {
    logger.warn(
      'HOST_MODE=standalone 但配置了宿主相关变量：已忽略（要启用宿主适配请设 HOST_MODE=embedded）。',
    );
  }

  return {
    mode,
    protocolVersion: FF_EMBED_PROTOCOL_VERSION,
    sharedSecret,
    allowedOrigins,
    endpoints,
    requestTimeoutMs: readTimeout(config.get<string>('HOST_REQUEST_TIMEOUT_MS')),
    hostUserVipLevel: readVipLevel(
      config.get<string>('HOST_USER_VIP_LEVEL'),
      mode === 'embedded' && Boolean(endpoints.billing),
    ),
  };
}

const VIP_LEVELS = ['free', 'pro', 'enterprise'] as const;

/**
 * 宿主开户用户在本网关的档位（决定节点权限）。
 *
 * 缺省规则：**宿主承担计费 → `pro`**（钱由宿主收，flow 的档位不该再拦节点），
 * 否则 `free`（宿主不承担计费时，本网关的自带 balance 与档位照旧生效）。
 */
function readVipLevel(
  raw: string | undefined,
  hostPays: boolean,
): 'free' | 'pro' | 'enterprise' {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return hostPays ? 'pro' : 'free';
  if (!(VIP_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `HOST_USER_VIP_LEVEL 取值非法：${raw}。只接受 ${VIP_LEVELS.join(' / ')}；`
      + '写错会让宿主用户拿到未知档位，节点权限判定会静默放行或全拦。',
    );
  }
  return value as 'free' | 'pro' | 'enterprise';
}

/**
 * 能力归属 + 降级原因。
 *
 * `notes` 是给**宿主与用户看的**：哪一项由谁承担、为什么降级。capabilities 接口原样返回它，
 * 前端把降级原因显示在界面上（「降级必须明示原因」）。
 */
export function hostCapabilities(config: HostConfig): {
  capabilities: HostCapabilities;
  notes: string[];
} {
  const embedded = config.mode === 'embedded';
  const capabilities: HostCapabilities = {
    identity: embedded && Boolean(config.endpoints.identity),
    credentials: embedded && Boolean(config.endpoints.credentials),
    billing: embedded && Boolean(config.endpoints.billing),
    events: embedded && Boolean(config.endpoints.events),
    // 视觉令牌与导航是前端侧的缝：内嵌形态一律由宿主承担（协议里协商），
    // 独立形态由 flow 自己的品牌与路由承担。
    theme: embedded,
    navigation: embedded,
  };

  const notes: string[] = [];
  if (!embedded) {
    notes.push(
      '独立模式：身份 / 凭证 / 计费 / 事件 / 视觉 / 导航均由 flow 自带实现承担。',
    );
    return { capabilities, notes };
  }

  notes.push('内嵌模式：身份由宿主签发（服务端验签后换 flow 会话）。');
  notes.push(
    capabilities.credentials
      ? '引擎凭证由宿主下发（宿主自己的 BYOK 实例或第三方网关）。'
      : '宿主未提供凭证回调：回落 .env 全局密钥。',
  );
  notes.push(
    capabilities.billing
      ? '计费由宿主承担（flow run id 作幂等键）。'
      : '宿主未提供计费回调：走 flow 自带 balance。',
  );
  notes.push(
    capabilities.events
      ? '运行事件透出给宿主通道（带 seq，宿主可断线重放）。'
      : '宿主未提供事件回调：仅本地 SSE。',
  );
  if (config.allowedOrigins.length === 0) {
    notes.push('未配置 HOST_ALLOWED_ORIGINS：前端会拒绝一切入站消息，握手无法完成。');
  }
  return { capabilities, notes };
}
