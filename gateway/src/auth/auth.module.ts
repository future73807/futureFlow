import {
  Injectable,
  MiddlewareConsumer,
  NestModule,
  Module,
  RequestMethod,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { ApiKey } from '../database/entities/api-key.entity';
import { AuthMiddleware } from './auth.middleware';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt.guard';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';

/**
 * VIP 等级与可用节点类型映射
 */
export const VIP_NODE_PERMISSIONS: Record<string, string[]> = {
  // 条件分支已接入 Dify 转换，应作为所有工作流的基础能力，
  // 而不是在运行时被误拒绝。
  free: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'condition', 'multi-condition'],
  pro: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'condition', 'multi-condition', 'http', 'code', 'loop'],
  enterprise: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'condition', 'multi-condition', 'http', 'code', 'loop'],
};

/**
 * 权限校验工具:检查用户 VIP 等级是否有权使用指定节点类型
 */
@Injectable()
export class PermissionChecker {
  checkNodePermissions(
    vipLevel: string,
    nodeTypes: string[],
  ): { allowed: boolean; deniedNodes: string[] } {
    const allowedTypes = VIP_NODE_PERMISSIONS[vipLevel] || VIP_NODE_PERMISSIONS.free;
    const deniedNodes = nodeTypes.filter((type) => !allowedTypes.includes(type));
    return {
      allowed: deniedNodes.length === 0,
      deniedNodes,
    };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([User, ApiKey])],
  controllers: [AuthController, ApiKeyController],
  providers: [PermissionChecker, AuthService, JwtAuthGuard, ApiKeyService],
  exports: [PermissionChecker, TypeOrmModule, AuthService, JwtAuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(
      'workflows/run',
      { path: 'workflows/:id/execute', method: RequestMethod.POST },
    );
  }
}
