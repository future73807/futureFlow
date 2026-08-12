import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MediaExecutionScope {
  workflowId: string;
  workflowVersion: number;
  runId: string;
  credentialIds: readonly string[];
}

export interface MediaAuthenticatedRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  user?: { id: string };
  auth?: Record<string, unknown>;
  mediaExecution?: MediaExecutionScope;
}

/**
 * Ordinary user JWTs can manage all tenant-owned media resources. The narrow
 * media_execution token can only create/poll/download media for its published
 * workflow run and can never reach credential CRUD.
 */
@Injectable()
export class MediaExecutionGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MediaAuthenticatedRequest>();
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
    const user = await this.authService.validateJwtPayload(payload);
    if (!user) throw new UnauthorizedException('用户不存在或已被封禁');
    request.user = user;
    request.auth = payload;

    if (payload.type !== 'media_execution') return true;
    const scope = this.parseScope(payload);
    this.assertExecutionRoute(request, scope);
    request.mediaExecution = scope;
    return true;
  }

  private parseScope(payload: Record<string, any>): MediaExecutionScope {
    const ids = payload.credentialIds;
    if (
      !UUID.test(String(payload.sub || ''))
      || !UUID.test(String(payload.workflowId || ''))
      || !UUID.test(String(payload.runId || ''))
      || !Number.isInteger(payload.workflowVersion)
      || payload.workflowVersion < 1
      || !Array.isArray(ids)
      || ids.length < 1
      || ids.length > 100
      || ids.some((id) => typeof id !== 'string' || !UUID.test(id))
      || new Set(ids).size !== ids.length
    ) {
      throw new UnauthorizedException('媒体执行令牌作用域无效');
    }
    return {
      workflowId: payload.workflowId,
      workflowVersion: payload.workflowVersion,
      runId: payload.runId,
      credentialIds: Object.freeze([...ids]),
    };
  }

  private assertExecutionRoute(
    request: MediaAuthenticatedRequest,
    scope: MediaExecutionScope,
  ): void {
    const path = String(request.originalUrl || request.url || '').split('?')[0];
    const isCreate = request.method === 'POST' && (
      path === '/media/images/generate'
      || path === '/media/videos/generate'
    );
    const isRead = request.method === 'GET' && (
      /^\/media\/jobs\/[0-9a-f-]{36}$/i.test(path)
      || /^\/media\/assets\/[0-9a-f-]{36}$/i.test(path)
    );
    if (!isCreate && !isRead) {
      throw new ForbiddenException('媒体执行令牌无权访问此接口');
    }
    if (isCreate) {
      const credentialId = request.body?.credentialId;
      if (typeof credentialId !== 'string' || !scope.credentialIds.includes(credentialId)) {
        throw new ForbiddenException('媒体凭据不在本次工作流授权范围内');
      }
    }
  }
}

export function mediaExecutionScope(
  request: MediaAuthenticatedRequest,
): MediaExecutionScope | undefined {
  return request.mediaExecution;
}
