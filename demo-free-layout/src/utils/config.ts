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

    // The product's default local pair is 3000 -> 3001. A stale shell can
    // compile a dev frontend with an unavailable override, so recover only
    // after that configured endpoint fails.
    if (
      pageUrl.port === '3000' &&
      isLoopbackHost(pageUrl.hostname) &&
      isLoopbackHost(configuredUrl.hostname) &&
      configuredUrl.port !== '3001'
    ) {
      return `${configuredUrl.protocol}//${configuredUrl.hostname}:3001`;
    }
  } catch {
    // Keep the configured endpoint when either URL cannot be parsed.
  }

  return undefined;
}

let activeGatewayUrl = configuredGatewayUrl;
const localGatewayFallback = getLocalGatewayFallback();

export let GATEWAY_URL = activeGatewayUrl;

export async function gatewayFetch(path: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${activeGatewayUrl}${path}`, options);
  } catch (error) {
    if (!localGatewayFallback || activeGatewayUrl === localGatewayFallback) {
      throw error;
    }

    const response = await fetch(`${localGatewayFallback}${path}`, options);
    activeGatewayUrl = localGatewayFallback;
    GATEWAY_URL = activeGatewayUrl;
    return response;
  }
}
