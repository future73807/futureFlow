import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(120)
  account: string; // 用户名或邮箱

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}
