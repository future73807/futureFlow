import { IsString, MinLength, MaxLength, IsOptional, IsIn, IsObject } from 'class-validator';

export class CreateWorkflowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  flowgram: string; // JSON 字符串
}

export class UpdateWorkflowDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  flowgram?: string;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'archived'])
  status?: string;
}

/** 另存为版本只接收说明文本，快照内容由服务端从当前草稿读取，避免客户端伪造历史。 */
export class CreateWorkflowVersionDto {
  @IsOptional()
  @IsString({ message: '版本说明必须是字符串' })
  @MaxLength(200, { message: '版本说明长度不能超过 200 个字符' })
  comment?: string;
}

/** 说明允许清空，因此只限制长度上限，不要求非空。 */
export class UpdateVersionCommentDto {
  @IsString({ message: '版本说明必须是字符串' })
  @MaxLength(200, { message: '版本说明长度不能超过 200 个字符' })
  comment: string;
}

/**
 * 导入接口的 flowgram 是真实 JSON 对象（不是 POST /workflows 的字符串），
 * 名称可选并回退为默认名，因此这里单独建 DTO 而不改动既有创建契约。
 */
export class ImportWorkflowDto {
  @IsOptional()
  @IsString({ message: '工作流名称必须是字符串' })
  @MinLength(1, { message: '工作流名称长度必须在 1..128 之间' })
  @MaxLength(128, { message: '工作流名称长度必须在 1..128 之间' })
  name?: string;

  @IsOptional()
  @IsString({ message: '工作流描述必须是字符串' })
  description?: string;

  @IsObject({ message: 'flowgram 必须是包含 nodes 与 edges 的 JSON 对象' })
  flowgram: Record<string, any>;
}
