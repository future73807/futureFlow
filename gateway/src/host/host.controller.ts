import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';

import { Public } from '../common/decorators/public.decorator';
import { hostCapabilities, type HostConfig } from './host.config';
import { SessionExchangeDto } from './dto/session-exchange.dto';
import { HostSessionService } from './host-session.service';
import { HOST_CONFIG } from './host.types';

/**
 * `ff-embed/v1` 的网关侧端点（内嵌模式握手用）。
 *
 * 两条路由都是 `@Public()`，理由各不相同、都登记在 `auth-coverage-smoke` 的台账里：
 *  - `capabilities`：握手**发生在前端还没有任何 flow 凭据之前**，否则「谁能嵌我」只能靠前端猜；
 *    它只回协议版本、能力归属、允许的宿主 origin 与降级原因，不含任何密钥或用户数据。
 *  - `session`：调用方出示的是**宿主令牌**而不是 flow 令牌，验证方式是由宿主服务端验签
 *    （共享密钥 + 回调），因此不能要求 flow 的 JWT。
 */
@Controller('host/ff-embed/v1')
export class HostController {
  constructor(
    @Inject(HOST_CONFIG) private readonly config: HostConfig,
    private readonly sessions: HostSessionService,
  ) {}

  @Public()
  @Get('capabilities')
  capabilities() {
    const { capabilities, notes } = hostCapabilities(this.config);
    return {
      protocolVersion: this.config.protocolVersion,
      mode: this.config.mode,
      capabilities,
      allowedOrigins: this.config.allowedOrigins,
      sessionPath: '/host/ff-embed/v1/session',
      notes,
    };
  }

  @Public()
  @Post('session')
  @HttpCode(200)
  exchange(@Body() dto: SessionExchangeDto) {
    return this.sessions.exchange(dto.hostToken);
  }
}
