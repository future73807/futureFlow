import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service';

/**
 * 管理员权限守卫
 * 校验 JWT Token 且要求 role === 'admin'
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
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
      const user = await this.authService.validateJwtPayload(payload);
      if (!user) {
        throw new ForbiddenException('用户不存在或已被封禁');
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
