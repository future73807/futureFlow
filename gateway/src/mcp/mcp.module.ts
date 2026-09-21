import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
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
  imports: [AuthModule, TypeOrmModule.forFeature([McpServer, User]), JwtModule],
  controllers: [McpController],
  providers: [McpCrypto, McpExecutionGuard, McpService],
})
export class McpModule {}
