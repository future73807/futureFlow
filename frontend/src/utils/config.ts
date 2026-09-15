/** futureFlow 前端运行时配置 */
const configuredGatewayUrl = __GATEWAY_URL__.replace(/\/+$/, '');

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function getLocalGatewayFallback(): string | undefined {
  if (typeof window === 'undefined') return undefined;

  try {
    const pageUrl = new URL(window.location.href);
    const configuredUrl = new URL(configuredGatewayUrl);

    // 默认本地配对: 画布 :3000 → 网关 :3001
    // 仅当配置端点失效且页面在 localhost:3000 时，才回退到 :3001
    if (
      pageUrl.port === '3000' &&
      isLoopbackHost(pageUrl.hostname) &&
      isLoopbackHost(configuredUrl.hostname) &&
      configuredUrl.port !== '3001'
    ) {
      return `${configuredUrl.protocol}//${configuredUrl.hostname}:3001`;
    }
  } catch {
    // 保持配置的端点
  }

  return undefined;
}

let activeGatewayUrl = configuredGatewayUrl;
const localGatewayFallback = getLocalGatewayFallback();

export let GATEWAY_URL = activeGatewayUrl;

/** 连通性探测：通过 GET /healthz 检测哪个网关可用 */
async function probeGateway(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 解析当前激活的网关地址（带连通性探测） */
async function resolveGatewayUrl(): Promise<string> {
  // 先尝试配置的网关
  if (await probeGateway(configuredGatewayUrl)) {
    activeGatewayUrl = configuredGatewayUrl;
    GATEWAY_URL = activeGatewayUrl;
    return activeGatewayUrl;
  }

  // 配置网关不可用，尝试回退网关
  if (localGatewayFallback) {
    if (await probeGateway(localGatewayFallback)) {
      activeGatewayUrl = localGatewayFallback;
      GATEWAY_URL = activeGatewayUrl;
      return activeGatewayUrl;
    }
  }

  // 都不可用，返回配置网关（让后续请求抛出网络错误）
  return configuredGatewayUrl;
}

/** 判断请求是否为写操作（非幂等） */
function isWriteOperation(method?: string): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH';
}

/**
 * 统一的网关请求封装。
 *
 * 安全策略：
 * - 每次请求前先通过 /healthz 探测可用网关
 * - 写操作（POST/PUT/DELETE/PATCH）只发送一次，不重试到回退网关
 * - 读操作（GET/HEAD）在主网关失败时可尝试回退网关
 */
export async function gatewayFetch(path: string, options?: RequestInit): Promise<Response> {
  const method = options?.method || 'GET';
  const isWrite = isWriteOperation(method);

  // 解析当前可用的网关
  const baseUrl = await resolveGatewayUrl();

  try {
    return await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    // 写操作不重试，直接抛出错误（避免重复提交）
    if (isWrite) {
      throw error;
    }

    // 读操作：如果主网关失败且有回退网关，尝试一次
    if (localGatewayFallback && baseUrl !== localGatewayFallback) {
      const fallbackResponse = await fetch(`${localGatewayFallback}${path}`, options);
      activeGatewayUrl = localGatewayFallback;
      GATEWAY_URL = activeGatewayUrl;
      return fallbackResponse;
    }

    throw error;
  }
}
