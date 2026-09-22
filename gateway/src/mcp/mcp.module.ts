import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { McpServer } from '../database/entities/mcp-server.entity';
import { User } from '../database/entities/user.entity';
import { McpController } from './mcp.controller';
import { McpCrypto } from './mcp-crypto.service';
import { McpExecutionGuard } from './mcp-execution.guard';
import { McpService } from './mcp.service';

@Module({
  // User 必须注册：McpExecutionGuard 要按 sub 查账号并强制 active。缺了它 Nest 在
  // 启动阶段就报「依赖无法解析」——是整个网关起不来，而不是这个接口不可用。
  //
  // 这里**不要**再 import 裸的 `JwtModule`（无 .register()）。裸模块只声明
  // `providers: [JwtService]`，会在本模块注入器里造出第二个 JwtService，
  // 而它的 `JWT_MODULE_OPTIONS` 是空的 —— 于是这个控制器里的 JwtAuthGuard 和
  // McpExecutionGuard 拿到的 JwtService 没有密钥，`verify()` 恒抛
  // `secret or public key must be provided`，MCP 的 4 个管理接口与 /mcp/proxy
  // 全部返回 401「无效或过期的 Token」。
  // app.module.ts 里的 `JwtModule.registerAsync({ global: true })` 已经把配置好的
  // JwtService 全局导出，直接用它即可。
  imports: [AuthModule, TypeOrmModule.forFeature([McpServer, User])],
  controllers: [McpController],
  providers: [McpCrypto, McpExecutionGuard, McpService],
})
export class McpModule {}
