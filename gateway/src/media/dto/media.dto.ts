import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MEDIA_PROVIDERS, MediaProvider } from '../../database/entities/media-credential.entity';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// The canvas uses "auto" as an unset select value. Normalize it at the HTTP
// boundary so it is never forwarded as a literal provider parameter.
const optionalMediaSetting = ({ value }: { value: unknown }) => {
  const normalized = trimmed({ value });
  return typeof normalized === 'string' && normalized.toLowerCase() === 'auto'
    ? undefined
    : normalized;
};

export class CreateMediaCredentialDto {
  @IsIn(MEDIA_PROVIDERS)
  provider: MediaProvider;

  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  label: string;

  @IsString()
  @Length(8, 8192)
  apiKey: string;
}

export class UpdateMediaCredentialDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(8, 8192)
  apiKey?: string;
}

export class GenerateImageDto {
  @IsUUID()
  credentialId: string;

  @Transform(trimmed)
  @IsString()
  @Matches(/^[A-Za-z0-9._:/-]{1,160}$/)
  model: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  prompt: string;

  @IsOptional()
  @Transform(optionalMediaSetting)
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,40}$/)
  size?: string;

  @IsOptional()
  @Transform(optionalMediaSetting)
  @IsString()
  @Matches(/^\d{1,2}:\d{1,2}$/)
  aspectRatio?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,32}$/)
  quality?: string;
}

export class GenerateVideoDto extends GenerateImageDto {
  @IsOptional()
  @Transform(optionalMediaSetting)
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,40}$/)
  resolution?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  durationSeconds?: number;
}
