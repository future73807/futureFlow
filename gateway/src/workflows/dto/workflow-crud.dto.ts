import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

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
  status?: string;
}
