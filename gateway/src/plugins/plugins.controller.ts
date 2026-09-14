import {
  Controller,
  Get,
  Param,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt.guard';
import { PluginsService } from './plugins.service';

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

  @Get()
  async list() {
    return { items: await this.plugins.list() };
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.plugins.detail(id);
  }
}
