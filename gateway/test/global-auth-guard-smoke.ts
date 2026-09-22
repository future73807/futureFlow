import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { GlobalAuthGuard } from '../src/common/guards/global-auth.guard';
import { JwtAuthGuard } from '../src/auth/jwt.guard';
import { IS_PUBLIC_KEY, Public } from '../src/common/decorators/public.decorator';

/**
 * 全局鉴权守卫的行为回归（不连数据库、不起服务）。
 *
 * 配套的 `auth-coverage-smoke.ts` 只做源码清点（「有没有标」），这里验证**标了之后
 * 运行时到底怎么判**（「标了算不算」）。核心要守住的一条：忘了挂守卫的新控制器，
 * 默认结果是 401，而不是裸奔 —— 这正是 `LlmProxyController` / `PythonExecController`
 * 两次事故的复发路径。
 */

const contextOf = (handler: unknown, cls: unknown, req: unknown = {}): ExecutionContext => ({
  getHandler: () => handler,
  getClass: () => cls,
  switchToHttp: () => ({ getRequest: () => req }),
}) as unknown as ExecutionContext;

/** 计数用的替身 JWT 守卫：只关心「有没有被调用」。 */
function stubJwtGuard(): { guard: JwtAuthGuard; calls: () => number } {
  let count = 0;
  const guard = {
    canActivate: async () => {
      count += 1;
      return true;
    },
  } as unknown as JwtAuthGuard;
  return { guard, calls: () => count };
}

const guardWith = (jwt: JwtAuthGuard) => new GlobalAuthGuard(new Reflector(), jwt);

class Probe {
  publicRoute() {}

  bareRoute() {}

  guardedRoute() {}
}

Public()(Probe.prototype, 'publicRoute', { value: Probe.prototype.publicRoute } as PropertyDescriptor);
Reflect.defineMetadata(GUARDS_METADATA, [JwtAuthGuard], Probe.prototype.guardedRoute);

class PublicClassProbe {
  route() {}
}
Reflect.defineMetadata(IS_PUBLIC_KEY, true, PublicClassProbe);

class GuardedClassProbe {
  route() {}
}
Reflect.defineMetadata(GUARDS_METADATA, [JwtAuthGuard], GuardedClassProbe);

/** 模拟「新同事加了个控制器、忘了挂守卫」。 */
class ForgetfulProbe {
  route() {}
}

async function main() {
  // ── 0. @Public() 确实把元数据打在方法上 ───────────────────────────────
  assert.equal(
    Reflect.getMetadata(IS_PUBLIC_KEY, Probe.prototype.publicRoute),
    true,
    '@Public() 应把 IS_PUBLIC_KEY 打在处理器方法上，否则全局守卫认不出来',
  );

  // ── 1. 标了 @Public() 的路由：放行，且不惊动 JWT 守卫 ─────────────────
  {
    const { guard: jwt, calls } = stubJwtGuard();
    const ok = await guardWith(jwt).canActivate(contextOf(Probe.prototype.publicRoute, Probe));
    assert.equal(ok, true, '带 @Public() 的路由应放行');
    assert.equal(calls(), 0, '带 @Public() 的路由不应再走 JWT 守卫');
  }

  // ── 2. 类级 @Public()：整类放行 ───────────────────────────────────────
  {
    const { guard: jwt, calls } = stubJwtGuard();
    const ok = await guardWith(jwt).canActivate(
      contextOf(PublicClassProbe.prototype.route, PublicClassProbe),
    );
    assert.equal(ok, true, '类级 @Public() 应让该类所有路由放行');
    assert.equal(calls(), 0, '类级 @Public() 不应再走 JWT 守卫');
  }

  // ── 3. 自带 @UseGuards 的路由：交回那个专用守卫，不叠加 JWT ────────────
  {
    const { guard: jwt, calls } = stubJwtGuard();
    const ok = await guardWith(jwt).canActivate(contextOf(Probe.prototype.guardedRoute, Probe));
    assert.equal(ok, true, '自带 @UseGuards 的路由应交给专用守卫判（MCP 回调令牌等不是 JWT）');
    assert.equal(calls(), 0, '自带守卫的路由不应被全局守卫用 JWT 覆盖掉');
  }

  // ── 4. 类级 @UseGuards：同样交回专用守卫 ──────────────────────────────
  {
    const { guard: jwt, calls } = stubJwtGuard();
    const ok = await guardWith(jwt).canActivate(
      contextOf(GuardedClassProbe.prototype.route, GuardedClassProbe),
    );
    assert.equal(ok, true, '类级 @UseGuards 应交给专用守卫判');
    assert.equal(calls(), 0, '类级守卫的路由不应被全局守卫用 JWT 覆盖掉');
  }

  // ── 5. 什么都不带的裸路由：结果由 JWT 守卫说了算 ──────────────────────
  {
    const { guard: jwt, calls } = stubJwtGuard();
    const ok = await guardWith(jwt).canActivate(contextOf(Probe.prototype.bareRoute, Probe));
    assert.equal(ok, true, '裸路由应落到 JWT 守卫，其结果就是全局守卫的结果');
    assert.equal(calls(), 1, '裸路由必须真的走到 JWT 守卫');
  }

  // ── 6. 关键：全新控制器忘了挂守卫 → 401，不是裸奔 ─────────────────────
  {
    const realJwt = new JwtAuthGuard({} as never, {} as never);
    await assert.rejects(
      () => guardWith(realJwt).canActivate(
        contextOf(ForgetfulProbe.prototype.route, ForgetfulProbe, { headers: {} }),
      ),
      UnauthorizedException,
      '没带 Authorization 头的裸路由必须被挡成 401',
    );

    // 带了个无效令牌同样要被挡住，不能因为「有 Authorization 头」就放行。
    const invalidTokenJwt = new JwtAuthGuard(
      { verify: () => { throw new Error('bad signature'); } } as never,
      {} as never,
    );
    await assert.rejects(
      () => guardWith(invalidTokenJwt).canActivate(
        contextOf(
          ForgetfulProbe.prototype.route,
          ForgetfulProbe,
          { headers: { authorization: 'Bearer invalid' } },
        ),
      ),
      UnauthorizedException,
      '无效令牌必须被挡成 401',
    );
  }

  console.log(
    '全局鉴权守卫行为检查通过: @Public() 与自带守卫放行且不叠加 JWT，'
    + '裸路由一律落到 JwtAuthGuard（无凭据 / 无效凭据均 401）',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
