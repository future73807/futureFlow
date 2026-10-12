import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Inject, Injectable, Param, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IsIn, IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { HOST_CONFIG } from './host.types';
import type { HostConfig } from './host.config';
import { ProjectControlService } from './project-control.service';
import { WORKFLOW_ID_PIPE } from '../security/uuid-param.pipe';

@Injectable()
export class HostProjectControlGuard implements CanActivate {
  constructor(@Inject(HOST_CONFIG) private readonly config: HostConfig) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const auth = request.headers.authorization;
    const expected = createHash('sha256').update(`Bearer ${this.config.sharedSecret}`).digest();
    const actual = createHash('sha256').update(typeof auth === 'string' ? auth : '').digest();
    if (this.config.mode !== 'embedded' || !this.config.sharedSecret || request.headers['x-ff-embed-protocol'] !== 'v1' || !timingSafeEqual(actual, expected)) throw new ForbiddenException('宿主控制授权无效');
    return true;
  }
}
class ProjectControlDto {
  @IsIn(['snapshot', 'quiesce', 'complete-relink']) action: 'snapshot' | 'quiesce' | 'complete-relink';
  @IsString() @MaxLength(256) hostSubject: string;
  @IsUUID() operationId: string;
  @IsInt() @Min(0) expectedGeneration: number;
}
@UseGuards(HostProjectControlGuard)
@Controller('host/ff-embed/v1/projects')
export class HostProjectControlController {
  constructor(private readonly controlService: ProjectControlService) {}
  @Post(':projectId/control')
  control(@Param('projectId', WORKFLOW_ID_PIPE) projectId: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })) body: ProjectControlDto) {
    return this.controlService.control(projectId, body);
  }
}
