import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';

export interface McpExecutionScope {
  workflowId: string;
  runId: string;
  serverIds: readonly string[];
}

export interface McpAuthenticatedRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  user?: { id: string };
  mcpExecution?: McpExecutionScope;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * MCP 执行令牌守卫：与媒体执行令牌同构的短时窄权限令牌。
 * 只允许 POST /mcp/proxy，且 serverId 必须在签发范围内。
 */
@Injectable()
export class McpExecutionGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    // 与 JwtAuthGuard / MediaExecutionGuard 保持一致：在守卫本地按 sub 查账号并
    // 强制 active。**少了这一步，封禁/删除在令牌有效期内就不生效**——而 MCP 服务器
    // 上存的是租户自己的 Bearer 令牌，一个被封的账号拿 15 分钟有效期的执行令牌
    // 还能继续调用。另外两个守卫都有这个检查，这里不能是例外。
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<McpAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Authorization 头');
    }
    const token = header.slice(7).trim();
    if (!token) throw new UnauthorizedException('Token 不能为空');

    let payload: Record<string, any>;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('无效或过期的 Token');
    }
    if (payload.type !== 'mcp_execution') {
      throw new UnauthorizedException('此接口仅接受 MCP 执行令牌');
    }

    const path = String(request.originalUrl || request.url || '').split('?')[0];
    if (request.method !== 'POST' || !path.endsWith('/mcp/proxy')) {
      throw new UnauthorizedException('MCP 执行令牌只能调用工具代理接口');
    }

    const ids = payload.serverIds;
    if (
      !UUID.test(String(payload.sub || ''))
      || !UUID.test(String(payload.workflowId || ''))
      || !UUID.test(String(payload.runId || ''))
      || !Array.isArray(ids)
      || ids.length < 1
      || ids.length > 100
      || ids.some((id: any) => typeof id !== 'string' || !UUID.test(id))
    ) {
      throw new UnauthorizedException('MCP 执行令牌作用域无效');
    }

    const requestedServerId = String((request.body as any)?.serverId || '');
    if (!ids.includes(requestedServerId)) {
      throw new UnauthorizedException('MCP 执行令牌未授权该服务器');
    }

    const userId = String(payload.sub);
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('账号不存在或已被停用');
    }

    request.user = { id: userId };
    request.mcpExecution = {
      workflowId: String(payload.workflowId),
      runId: String(payload.runId),
      serverIds: ids,
    };
    return true;
  }
}
