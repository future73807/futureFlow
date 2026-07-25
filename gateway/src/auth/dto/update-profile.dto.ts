import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Fields a signed-in user may manage for their own account. */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
