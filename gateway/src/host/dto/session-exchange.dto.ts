import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 宿主换会话请求：只认一个宿主令牌，任何身份字段都以宿主服务端的验签结果为准。 */
export class SessionExchangeDto {
  @IsString()
  @IsNotEmpty({ message: 'hostToken 不能为空' })
  @MaxLength(8 * 1024, { message: 'hostToken 过长' })
  hostToken: string;
}
