import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { User } from '../database/entities/user.entity';

/**
 * 鉴权中间件（双模式）
 * 1. 优先尝试 JWT Token 验证
 * 2. JWT 失败则尝试 API Key 验证（向后兼容）
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
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

    // 2. 尝试 API Key 验证（向后兼容）
    const user = await this.userRepository.findOne({
      where: { apiKey: token },
    });

    if (!user) {
      throw new UnauthorizedException('无效的 Token 或 API Key');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException('账号已被封禁或暂停');
    }

    req.user = user;
    next();
  }
}
