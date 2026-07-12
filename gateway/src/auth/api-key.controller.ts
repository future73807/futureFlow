import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard';
import { ApiKeyService } from './api-key.service';

@Controller('user/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  async list(@Request() req) {
    const keys = await this.apiKeyService.listByUser(req.user.id);
    // 只返回安全字段
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    }));
  }

  @Post()
  async create(@Body() body: { name?: string }, @Request() req) {
    const result = await this.apiKeyService.create(req.user.id, body.name || 'default');
    // 创建时返回完整明文，仅此一次
    return {
      id: result.apiKey.id,
      name: result.apiKey.name,
      keyPrefix: result.apiKey.keyPrefix,
      plaintext: result.plaintext,
      message: '请妥善保存，此密钥仅显示一次',
    };
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Request() req) {
    await this.apiKeyService.revoke(id, req.user.id);
    return { success: true };
  }
}
