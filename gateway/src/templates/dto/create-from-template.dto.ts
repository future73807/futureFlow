import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateFromTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;
}
