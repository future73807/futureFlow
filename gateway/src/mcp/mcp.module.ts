import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { McpServer } from '../database/entities/mcp-server.entity';
import { McpController } from './mcp.controller';
import { McpCrypto } from './mcp-crypto.service';
import { McpExecutionGuard } from './mcp-execution.guard';
import { McpService } from './mcp.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([McpServer]), JwtModule],
  controllers: [McpController],
  providers: [McpCrypto, McpExecutionGuard, McpService],
})
export class McpModule {}
