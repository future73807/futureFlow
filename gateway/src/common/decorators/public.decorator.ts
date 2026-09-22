import { SetMetadata } from '@nestjs/common';

/**
 * 显式标记「这条路由不需要 JWT」。
 *
 * 全局守卫上线后默认是「要鉴权」，忘了挂 `@UseGuards` 不再等于裸奔，而是直接
 * 401。真正需要匿名的入口必须在这里显式声明，并且要在
 * `test/auth-coverage-smoke.ts` 的 PUBLIC_ROUTES 里写明理由——两边不一致会测红。
 *
 * 适用的两类路由：
 *   1. 必须匿名：登录、注册、健康检查探针；
 *   2. 用别的方式验身份：Webhook 密钥、LLM 短期票据、AuthMiddleware 覆盖的
 *      执行入口（支持 JWT 与平台 API Key 两种身份）。
 */
export const IS_PUBLIC_KEY = 'futureflow:is-public';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
