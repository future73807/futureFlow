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

  /** 覆盖 Start 节点默认值的本次运行参数。 */
  @IsOptional()
  @IsObject()
  inputs?: Record<string, string | number | boolean>;

  @IsOptional()
  @IsString()
  user?: string;
}

/** 已发布工作流的调用参数，不允许客户端传入或篡改工作流定义。 */
export class RunPublishedWorkflowDto {
  @IsOptional()
  @IsObject()
  inputs?: Record<string, string | number | boolean>;
}
