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
import { LoginRateLimitService } from './login-rate-limit.service';

/**
 * VIP 等级与可用节点类型映射
 */
export const VIP_NODE_PERMISSIONS: Record<string, string[]> = {
  // 条件分支已接入 Dify 转换，应作为所有工作流的基础能力，
  // 而不是在运行时被误拒绝；退出节点同理，它只是提前结束运行的控制流节点。
  free: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'condition', 'multi-condition', 'exit'],
  pro: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'condition', 'multi-condition', 'exit', 'http', 'code', 'loop', 'knowledge', 'subworkflow', 'mcp'],
  enterprise: ['start', 'end', 'llm', 'text', 'image', 'video', 'variable', 'variable-aggregator', 'condition', 'multi-condition', 'exit', 'http', 'code', 'loop', 'knowledge', 'subworkflow', 'mcp'],
};

/**
 * 已实现但只在本地试运行链路成立的节点：不能发布，也不能云端试运行。
 *
 * 它们不在任何等级的 VIP 白名单里，但用「当前 VIP 等级无权使用」来解释会
 * 误导用户去升级套餐（升级后依然不可用）。因此单独识别，给出准确文案。
 * 与 gateway/src/converter/dify-converter.service.ts 中 python 的
 * BadRequestException、以及前端节点面板的「仅本地试运行」标记保持一致。
 */
export const LOCAL_ONLY_NODE_TYPES = ['python'];

const LOCAL_ONLY_NODE_LABELS: Record<string, string> = {
  python: 'Python 执行',
};

/**
 * 权限校验工具:检查用户 VIP 等级是否有权使用指定节点类型
 */
@Injectable()
export class PermissionChecker {
  /** 返回图中「仅本地试运行可用」节点的中文名，供调用方给出准确报错。 */
  findLocalOnlyNodes(nodeTypes: string[]): string[] {
    const matched = new Set(
      nodeTypes.filter((type) => LOCAL_ONLY_NODE_TYPES.includes(type)),
    );
    return [...matched].map((type) => LOCAL_ONLY_NODE_LABELS[type] || type);
  }

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
  providers: [PermissionChecker, AuthService, JwtAuthGuard, ApiKeyService, LoginRateLimitService],
  exports: [PermissionChecker, TypeOrmModule, AuthService, JwtAuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(
      'workflows/run',
      { path: 'workflows/:id/execute', method: RequestMethod.POST },
      { path: 'workflows/:id/draft-run', method: RequestMethod.POST },
    );
  }
}
