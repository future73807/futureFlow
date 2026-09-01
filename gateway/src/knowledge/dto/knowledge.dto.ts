import { IsInt, IsString, MaxLength, Max, Min, MinLength, IsOptional } from 'class-validator';

export class CreateKnowledgeDatasetDto {
  @IsString()
  @MinLength(1, { message: '知识库名称不能为空' })
  @MaxLength(100, { message: '知识库名称不能超过 100 个字符' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400, { message: '知识库描述不能超过 400 个字符' })
  description: string = '';
}

export class CreateKnowledgeDocumentDto {
  @IsString()
  @MinLength(1, { message: '文档名称不能为空' })
  @MaxLength(200, { message: '文档名称不能超过 200 个字符' })
  name!: string;

  @IsString()
  @MinLength(1, { message: '文档内容不能为空' })
  @MaxLength(1_000_000, { message: '文档内容不能超过 100 万个字符' })
  text!: string;
}
