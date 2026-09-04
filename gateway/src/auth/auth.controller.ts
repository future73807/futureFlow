import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from './jwt.guard';
import { VIP_NODE_PERMISSIONS } from './auth.module';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 限流键的客户端地址默认取 socket 地址（不可伪造）；仅当部署方显式
   * 设置 TRUST_PROXY_HEADERS=true（确认存在可信反向代理）时才改用
   * X-Forwarded-For，否则攻击者可伪造该头绕过登录限流。
   */
  private clientAddress(req: ExpressRequest): string {
    const trustProxy = this.config.get<string>('TRUST_PROXY_HEADERS') === 'true';
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.ip || 'unknown';
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Request() req: ExpressRequest) {
    return this.authService.register(dto, this.clientAddress(req));
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Request() req: ExpressRequest) {
    const clientKey = `${this.clientAddress(req)}|${String(dto.account || '').toLowerCase()}`;
    return this.authService.login(dto, clientKey);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Request() req) {
    return this.authService.getProfile(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  async updateProfile(@Request() req, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('vip-info')
  async getVipInfo(@Request() req) {
    const user = req.user;
    const allowedNodes =
      VIP_NODE_PERMISSIONS[user.vipLevel] || VIP_NODE_PERMISSIONS['free'];
    const allNodeTypes = [
      'start',
      'end',
      'llm',
      'http',
      'code',
      'text',
      'image',
      'video',
      'variable',
      'condition',
      'multi-condition',
      'loop',
    ];
    const deniedNodes = allNodeTypes.filter(
      (t) => !allowedNodes.includes(t),
    );

    return {
      vipLevel: user.vipLevel,
      allowedNodes,
      deniedNodes,
      balance: parseFloat(user.balance.toString()),
      frozenBalance: parseFloat(user.frozenBalance.toString()),
    };
  }
}
