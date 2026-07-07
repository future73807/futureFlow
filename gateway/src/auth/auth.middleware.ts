import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response, NextFunction } from 'express';
import { User } from '../database/entities/user.entity';

/**
 * 鉴权中间件
 * 从 Authorization: Bearer {apiKey} 中提取 API Key,
 * 查找对应用户并挂载到 req.user
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async use(req: Request & { user?: User }, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Authorization 头或格式不正确');
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      throw new UnauthorizedException('API Key 不能为空');
    }

    const user = await this.userRepository.findOne({
      where: { apiKey },
    });

    if (!user) {
      throw new UnauthorizedException('无效的 API Key');
    }

    req.user = user;
    next();
  }
}
