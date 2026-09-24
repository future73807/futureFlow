import { Logger } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

import type { HostConfig } from './host.config';
import { HostHttpClient } from './host-http.client';
import { parseHostPayload } from './host-payload';
import type {
  EngineCredentialsResolution,
  HostCapabilities,
  HostCredentialsProvider,
} from './host.types';

/** 宿主凭证回调的响应。 */
class HostCredentialsPayload {
  @IsUrl(
    { protocols: ['http', 'https'], require_tld: false },
    { message: 'apiBase 必须是 http(s) 地址' },
  )
  apiBase: string;

  @IsString()
  @IsNotEmpty({ message: 'apiKey 不能为空' })
  @MaxLength(512, { message: 'apiKey 过长' })
  apiKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}

/** 凭证缓存时长：宿主换了 Key 之后，最迟一分钟生效，不必重启网关。 */
const CACHE_TTL_MS = 60_000;

/**
 * 内嵌形态的凭证 Provider：向宿主要引擎凭证（宿主自己的 BYOK 实例 / 第三方网关）。
 *
 * 三条口径：
 *  ① **宿主没提供回调 = 回落本地**（`.env` 全局密钥），这是「缝缺失时降级到独立实现」；
 *  ② **宿主提供了回调但调用失败 = 直接失败**，不静默改用本地 Key——那会用我们自己的钱
 *     办宿主的请求，是比报错严重得多的行为；
 *  ③ 单飞 + 60s 缓存：一次 run 涉及多次解析（Service API / Console），不重复打宿主。
 */
export class EmbeddedCredentialsProvider implements HostCredentialsProvider {
  readonly kind = 'embedded' as const;
  private readonly logger = new Logger(EmbeddedCredentialsProvider.name);
  private cached: { value: EngineCredentialsResolution; expiresAt: number } | null = null;
  private inflight: Promise<EngineCredentialsResolution> | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly http: HostHttpClient,
    readonly capabilities: HostCapabilities,
  ) {}

  async resolveEngineCredentials(): Promise<EngineCredentialsResolution> {
    if (!this.config.endpoints.credentials) {
      return { source: 'local' };
    }

    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchFromHost()
      .then((value) => {
        this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchFromHost(): Promise<EngineCredentialsResolution> {
    const payload = parseHostPayload(
      HostCredentialsPayload,
      await this.http.postJson<unknown>(
        this.config.endpoints.credentials,
        { protocolVersion: this.config.protocolVersion },
        { label: '凭证下发' },
      ),
      '凭证下发',
    );

    const apiBase = payload.apiBase.replace(/\/+$/, '');
    if (!apiBase.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1])/.test(apiBase)) {
      this.logger.warn(
        `宿主下发的 Dify 地址是明文 http 且不是回环（${apiBase}）：凭证会以明文过网。`,
      );
    }

    return {
      source: 'host',
      apiBase,
      apiKey: payload.apiKey.trim(),
      label: payload.label?.trim() || '宿主下发',
    };
  }
}
