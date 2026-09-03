import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, Min, IsInt } from 'class-validator';

const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateWorkflowTriggerDto {
  @IsString()
  @MaxLength(96)
  name: string;

  @IsIn(['webhook', 'schedule'])
  type: 'webhook' | 'schedule';

  @IsOptional()
  @IsIn(['interval', 'daily'])
  scheduleType?: 'interval' | 'daily';

  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

  /** scheduleType=daily 时的执行时间（HH:MM，网关本地时区）。 */
  @IsOptional()
  @Matches(DAILY_TIME_PATTERN, { message: 'dailyTime 必须是 HH:MM 格式（00:00-23:59）' })
  dailyTime?: string;

  @IsOptional()
  @IsObject()
  staticInputs?: Record<string, string | number | boolean>;
}

export class UpdateWorkflowTriggerDto {
  @IsOptional()
  @IsString()
  @MaxLength(96)
  name?: string;

  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';

  @IsOptional()
  @IsIn(['interval', 'daily'])
  scheduleType?: 'interval' | 'daily';

  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

  @IsOptional()
  @Matches(DAILY_TIME_PATTERN, { message: 'dailyTime 必须是 HH:MM 格式（00:00-23:59）' })
  dailyTime?: string;

  @IsOptional()
  @IsObject()
  staticInputs?: Record<string, string | number | boolean>;
}
