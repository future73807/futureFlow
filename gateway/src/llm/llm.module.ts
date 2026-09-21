import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { LlmProxyController } from './llm-proxy.controller';

/**
 * LLM 直连代理。
 *
 * 这里必须注册 User 仓储：`/llm/ticket` 用 JwtAuthGuard 校验登录态，而该守卫
 * 在内部按 sub 查账号并强制 active（见 jwt.guard.ts），缺了它 Nest 会在启动
 * 阶段就报「JwtAuthGuard 的依赖无法解析」——**整个网关起不来**，而不只是这个
 * 接口不可用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [LlmProxyController],
})
export class LlmModule {}
