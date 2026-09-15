import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt.guard';
import { PluginsService } from './plugins.service';

/** 插件 id 是目录 slug（如 llm、http），不是 uuid：限制字符集与长度以拒绝异常入参。 */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const strictValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

@UseGuards(JwtAuthGuard)
@UsePipes(strictValidation)
@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  private currentUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) throw new BadRequestException('未认证');
    return String(userId);
  }

  private assertPluginId(id: string): void {
    if (!PLUGIN_ID.test(id)) {
      throw new BadRequestException('插件 ID 格式无效');
    }
  }

  @Get()
  async list(@Request() req: any) {
    return { items: await this.plugins.list(this.currentUserId(req)) };
  }

  @Get(':id')
  detail(@Request() req: any, @Param('id') id: string) {
    this.assertPluginId(id);
    return this.plugins.detail(id, this.currentUserId(req));
  }

  /** 收藏 / 取消收藏（幂等切换），返回最新状态供详情页按钮直接渲染。 */
  @Post(':id/favorite')
  @HttpCode(200)
  toggleFavorite(@Request() req: any, @Param('id') id: string) {
    this.assertPluginId(id);
    return this.plugins.toggleFavorite(this.currentUserId(req), id);
  }
}
