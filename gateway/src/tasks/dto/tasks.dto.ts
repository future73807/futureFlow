import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const BATCH_TASK_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

/** 异步任务中心的运行来源：只暴露非画布/非批量的人工触发记录。 */
export const ASYNC_RUN_SOURCES = ['webhook', 'schedule', 'api'] as const;

/** 前端「全部」下拉通常提交空字符串，按未传处理。 */
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** query 参数都是字符串，显式转成数字后再交给 @IsInt 校验。 */
const toOptionalInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
};

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class PaginationQueryDto {
  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 最小为 1' })
  page?: number;

  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 最小为 1' })
  @Max(100, { message: 'pageSize 最大为 100' })
  pageSize?: number;
}

export class ListBatchTasksQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(BATCH_TASK_STATUSES, { message: 'status 参数无效' })
  status?: string;
}

export class ListAsyncRunsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(ASYNC_RUN_SOURCES, { message: 'source 参数无效' })
  source?: string;
}

export class CreateBatchTaskDto {
  @IsUUID(undefined, { message: 'workflowId 必须是有效的 UUID' })
  workflowId!: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString({ message: '任务名称必须是字符串' })
  @MaxLength(128, { message: '任务名称不能超过 128 个字符' })
  name?: string;

  @IsOptional()
  @IsIn(['published', 'draft'], { message: 'mode 只能是 published 或 draft' })
  mode?: 'published' | 'draft';

  /**
   * 行数与字段数的粗校验在 DTO 完成；每行值类型（仅标量）由服务层
   * sanitizeInputs 递归重建，确保落库的 jsonb 不携带嵌套结构。
   */
  @IsArray({ message: 'inputs 必须是数组' })
  @ArrayMinSize(1, { message: 'inputs 至少包含 1 条数据' })
  @ArrayMaxSize(200, { message: 'inputs 最多包含 200 条数据' })
  @IsObject({ each: true, message: 'inputs 的每一行必须是对象' })
  inputs!: Record<string, unknown>[];
}
