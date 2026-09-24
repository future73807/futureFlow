import { BadRequestException } from '@nestjs/common';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import type { HostConfig } from './host.config';
import { HostHttpClient } from './host-http.client';
import { parseHostPayload } from './host-payload';
import type {
  HostCapabilities,
  HostIdentity,
  HostIdentityProvider,
} from './host.types';

/** 宿主身份回调的响应（宿主实现方按此形状返回）。 */
class HostIdentityPayload {
  @IsString()
  @IsNotEmpty({ message: 'subject 不能为空' })
  @MaxLength(256, { message: 'subject 不能超过 256 字符' })
  subject: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'email 必须是邮箱格式' })
  @MaxLength(320)
  email?: string;
}

/**
 * 内嵌形态的身份 Provider：把宿主下发的令牌交给**宿主服务端**验签，拿回稳定外部标识。
 *
 * 为什么必须走服务端：前端能伪造任何 postMessage，宿主给的 `sub` 只有经服务端验签才可信
 * （《flow 集成方案》§3.3 安全边界）。flow 侧只认这次回调的结果。
 */
export class EmbeddedIdentityProvider implements HostIdentityProvider {
  readonly kind = 'embedded' as const;

  constructor(
    private readonly config: HostConfig,
    private readonly http: HostHttpClient,
    readonly capabilities: HostCapabilities,
  ) {}

  async resolveIdentity(hostToken: string): Promise<HostIdentity> {
    const token = (hostToken ?? '').trim();
    if (!token) {
      throw new BadRequestException('缺少宿主令牌（hostToken）');
    }
    if (token.length > 8 * 1024) {
      throw new BadRequestException('宿主令牌过长（超过 8KB），拒绝处理');
    }

    const payload = parseHostPayload(
      HostIdentityPayload,
      await this.http.postJson<unknown>(
        this.config.endpoints.identity,
        { token, protocolVersion: this.config.protocolVersion },
        { label: '身份验签' },
      ),
      '身份验签',
    );

    return {
      subject: payload.subject.trim(),
      displayName: payload.displayName?.trim() || undefined,
      email: payload.email?.trim().toLowerCase() || undefined,
    };
  }
}
