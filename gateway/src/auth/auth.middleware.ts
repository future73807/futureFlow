import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import { User } from '../database/entities/user.entity';
import { ApiKeyService } from './api-key.service';

/**
 * 鉴权中间件（双模式）
 * 1. 优先尝试 JWT Token 验证
 * 2. JWT 失败则尝试哈希存储的平台 API Key
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async use(req: Request & { user?: User }, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Authorization 头或格式不正确');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Token 不能为空');
    }

    // 1. 尝试 JWT 验证
    try {
      const payload = this.jwtService.verify(token);
      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });
      if (user && user.status === 'active') {
        req.user = user;
        return next();
      }
    } catch {
      // JWT 验证失败，继续尝试 API Key
    }

    // 2. 尝试用户在个人中心创建的平台 API Key
    const apiKeyUser = await this.apiKeyService.authenticate(token);
    if (apiKeyUser) {
      req.user = apiKeyUser;
      return next();
    }

    throw new UnauthorizedException('无效的 Token 或 API Key');
  }
}
