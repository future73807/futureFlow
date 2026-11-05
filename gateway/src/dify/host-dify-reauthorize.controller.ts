import { Controller, Post, UseGuards } from '@nestjs/common';

import { HostProjectControlGuard } from '../host/project-control.controller';
import { DifyIntegrationService } from './dify-integration.service';

/**
 * 宿主安装完 Dify 引擎栈后的「控制面补授权」入口。
 *
 * 鉴权沿用宿主共享密钥（与 `/projects/:id/control` 同一个 Guard），因此既不是
 * 免鉴权端点，也不需要宿主持有网关管理员 JWT；服务侧直接复用
 * `DifyIntegrationService.reauthorizeControlPlane()`，绕过 `/admin/*` 的 AdminGuard。
 * 网关 `onModuleInit` 只在启动期 30×2s 窗口内自动授权，引擎是用户后来点按钮装的，
 * 这个端点把「装完」与「控制面已授权」接上。
 */
@UseGuards(HostProjectControlGuard)
@Controller('host/ff-embed/v1/dify')
export class HostDifyReauthorizeController {
  constructor(private readonly dify: DifyIntegrationService) {}

  @Post('reauthorize')
  async reauthorize() {
    await this.dify.reauthorizeControlPlane();
    return { ok: true };
  }
}
