import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: '新密码至少 8 个字符' })
  @MaxLength(64)
  newPassword!: string;
}
