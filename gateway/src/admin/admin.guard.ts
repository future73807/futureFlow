import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';

/**
 * 管理员权限守卫
 * 校验 JWT Token 且要求 role === 'admin'
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    // 授权数据流在守卫本地完成（同 jwt.guard），并额外要求 role === 'admin'。
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ForbiddenException('缺少 Authorization 头');
    }

    const token = authHeader.slice(7).trim();

    try {
      const payload = this.jwtService.verify(token);
      const user = await this.userRepo.findOne({ where: { id: payload.sub } });
      if (
        !user
        || user.status !== 'active'
        || user.id !== payload.sub
        || user.tokenVersion !== (payload.tv ?? 0)
      ) {
        throw new ForbiddenException('登录状态已失效，请重新登录');
      }
      if (user.role !== 'admin') {
        throw new ForbiddenException('需要管理员权限');
      }
      req.user = user;
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new ForbiddenException('无效或过期的 Token');
    }
  }
}
