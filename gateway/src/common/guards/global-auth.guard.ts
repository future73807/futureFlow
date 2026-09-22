import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * 全局鉴权守卫：**默认要鉴权**，忘了挂守卫不再等于裸奔。
 *
 * 历史上出现过两次真实事故（`LlmProxyController` 整类无守卫、`PythonExecController`
 * 只挂了 JwtAuthGuard 导致任何登录账号都能在宿主机执行代码），根因都是
 * 「某个控制器要不要鉴权」纯靠开发者记得手动写 `@UseGuards`。
 *
 * 判定顺序：
 *   1. 带 `@Public()` —— 放行（这类路由必须在 auth-coverage-smoke 里登记理由）；
 *   2. 处理器或控制器自带 `@UseGuards(...)` —— 放行，交给那个专门的守卫去判
 *      （MCP 回调的限定用途令牌、媒体执行令牌等各有各的凭据，不能一刀切用 JWT）；
 *   3. 其余 —— 一律走 JwtAuthGuard。新增控制器如果既没标 `@Public()` 也没带
 *      守卫，会自动 401，并在 auth-coverage-smoke 里被清点出来。
 */
@Injectable()
export class GlobalAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtAuthGuard: JwtAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const handler = context.getHandler();
    const target = context.getClass();
    const ownGuards =
      (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined)?.length ||
      (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined)?.length;
    if (ownGuards) return true;

    return this.jwtAuthGuard.canActivate(context);
  }
}
