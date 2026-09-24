import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import type { HostConfig } from './host.config';

/**
 * 网关 → 宿主 的回调客户端（内嵌形态唯一的出口）。
 *
 * 四条口径：
 *  ① **凭据只在头里**：共享密钥走 `Authorization: Bearer`，绝不进日志、绝不进错误消息；
 *  ② **必带协议版本头**：宿主据此判断对端是不是它认识的 `ff-embed` 版本；
 *  ③ **幂等键由调用方给**：计费三段用 `flow:<runId>:<op>`，宿主可安全重放；
 *  ④ **错误可读**：非 2xx 时把宿主返回的正文（截断）一并带出，别让上层只看到「500」。
 */
export class HostHttpClient {
  private readonly logger = new Logger(HostHttpClient.name);

  constructor(private readonly config: HostConfig) {}

  async postJson<T>(
    url: string,
    body: unknown,
    options: { label: string; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<T> {
    if (!this.config.sharedSecret) {
      throw new Error(
        `宿主回调「${options.label}」缺少 HOST_SHARED_SECRET：内嵌模式必须带共享密钥，拒绝以匿名身份回调宿主。`,
      );
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.sharedSecret}`,
      'x-ff-embed-protocol': this.config.protocolVersion,
    };
    if (options.idempotencyKey) {
      headers['x-idempotency-key'] = options.idempotencyKey;
    }

    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`宿主回调失败（${options.label}）：${reason}`);
      throw new Error(
        `宿主回调失败（${options.label}）：${reason}。`
        + '请确认宿主服务在运行、地址可达，且 HOST_REQUEST_TIMEOUT_MS 足够。',
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const snippet = text.slice(0, 500);
      this.logger.error(
        `宿主回调返回 ${response.status}（${options.label}）：${snippet}`,
      );
      const message =
        `宿主回调失败（${options.label}）：宿主返回 ${response.status}`
        + (snippet ? `：${snippet}` : '（无正文）');
      // 状态映射：把「宿主的拒绝」翻成语义正确的 HTTP 状态，别一律 500。
      //  - 401/403：宿主不认这个令牌 / 不放行 → 401（握手失败就是没登录成功）
      //  - 400/402/409/422：宿主**明确拒绝**这次请求（额度不足、参数不对）→ 400，原因带出来
      //  - 其余（含 5xx）：宿主自身故障 → 503，属于「稍后重试可能好」
      if (response.status === 401 || response.status === 403) {
        throw new UnauthorizedException(message);
      }
      if ([400, 402, 409, 422].includes(response.status)) {
        throw new BadRequestException(message);
      }
      throw new ServiceUnavailableException(message);
    }

    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `宿主回调返回的不是 JSON（${options.label}）：${text.slice(0, 200)}`,
      );
    }
  }
}
