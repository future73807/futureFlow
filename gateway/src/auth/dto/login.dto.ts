import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  account: string; // 用户名或邮箱

  @IsString()
  @MinLength(1)
  password: string;
}
