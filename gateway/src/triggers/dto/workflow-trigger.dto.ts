import { IsIn, IsObject, IsOptional, IsString, MaxLength, Min, IsInt } from 'class-validator';

export class CreateWorkflowTriggerDto {
  @IsString()
  @MaxLength(96)
  name: string;

  @IsIn(['webhook', 'schedule'])
  type: 'webhook' | 'schedule';

  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

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
  @IsInt()
  @Min(1)
  intervalMinutes?: number;

  @IsOptional()
  @IsObject()
  staticInputs?: Record<string, string | number | boolean>;
}
