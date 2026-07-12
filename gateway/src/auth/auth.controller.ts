import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt.guard';
import { VIP_NODE_PERMISSIONS } from './auth.module';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Request() req) {
    return this.authService.getProfile(req.user.id);
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
      'condition',
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
