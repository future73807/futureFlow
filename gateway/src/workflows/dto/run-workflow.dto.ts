import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * 运行工作流请求 DTO
 * FlowGram JSON 结构较为灵活,这里只做顶层校验,
 * 具体的节点/边结构由 DifyConverterService 在运行时校验
 */
export class RunWorkflowDto {
  @IsObject()
  flowgram: {
    nodes: any[];
    edges: any[];
  };

  @IsOptional()
  @IsString()
  user?: string;
}
