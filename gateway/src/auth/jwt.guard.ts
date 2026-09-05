import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    // 授权数据流在守卫本地完成：按已验证 JWT 的 sub 查询账号并强制 active，
    // 保证封禁/删除在令牌有效期内立即生效，且不引入跨服务的间接层。
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Authorization 头');
    }

    const token = authHeader.slice(7).trim();

    try {
      const payload = this.jwtService.verify(token);
      if (payload?.type === 'media_execution') {
        throw new UnauthorizedException('媒体执行令牌不能访问此接口');
      }
      const user = await this.userRepo.findOne({ where: { id: payload.sub } });
      // tokenVersion 校验：改密码后旧 token 的 tv 落后即强制下线。
      // 旧 token 无 tv 字段，视为版本 0，与存量用户默认值兼容。
      if (
        !user
        || user.status !== 'active'
        || user.id !== payload.sub
        || user.tokenVersion !== (payload.tv ?? 0)
      ) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }
      req.user = user;
      req.auth = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('无效或过期的 Token');
    }
  }
}
