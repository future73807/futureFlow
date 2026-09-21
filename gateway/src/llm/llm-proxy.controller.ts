import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FixedWindowRateLimiter, resolveRateLimit } from '../common/fixed-window-rate-limit';
import { describeError, describeErrorBrief } from '../common/describe-error';
import {
  LLM_PROXY_TOKEN_TYPE,
  clampLlmCostFields,
  classifyLlmProxyToken,
  resolveLlmTicketTtlSeconds,
} from './llm-proxy-ticket';

/**
 * LLM 直连代理（浏览器试运行专用）
 *
 * 画布「试运行」在浏览器端执行 runtime-js，大语言模型节点需要 OpenAI
 * 兼容的 chat/completions 端点。模型服务商通常不允许浏览器跨域直连
 * （CORS 预检 403），且 API Key 不应下发到浏览器，因此统一走网关代理：
 *
 *   浏览器 → POST /llm/chat/completions → ${LLM_API_HOST}/chat/completions
 *
 * - 鉴权：调用方必须先登录领取短期票据（POST /llm/ticket），请求方的凭证只用于
 *   确认「是谁在花额度」，上游仍然使用服务端 LLM_API_KEY
 * - 模型：服务端 LLM_DEFAULT_MODEL 具有最高优先级（画布上的模型名仅作展示）
 * - 转发：仅转发到 LLM_API_HOST 配置的单一上游，不构成开放代理
 *
 * 为什么要票据：本控制器此前没有任何 guard，而全项目也没有全局守卫，等于
 * 任何人只要能连到网关端口就能消耗平台级 LLM_API_KEY。票据把这件事收回到
 * 「登录用户」范围内，且有效期很短（见 llm-proxy-ticket.ts）。
 */
@Controller('llm')
export class LlmProxyController {
  private readonly logger = new Logger(LlmProxyController.name);

  /**
   * 每次调用都真实消耗平台的 LLM 额度，票据只解决「是谁在花」，不解决「花多少」，
   * 因此按用户限流（默认每分钟 30 次）。
   */
  private readonly limiter: FixedWindowRateLimiter;

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.limiter = new FixedWindowRateLimiter({
      limit: resolveRateLimit(this.config.get<string>('LLM_PROXY_MAX_PER_MINUTE'), 30),
    });
  }

  /**
   * 领取 LLM 代理票据。
   *
   * 浏览器试运行在前端执行，拿不到网关的会话，只能把凭证放进节点输入里；
   * 直接放登录 JWT 会让 7 天有效的长期令牌随工作流定义落库，因此这里改为
   * 签发一张「只能调 LLM 代理」的短期票。
   */
  @UseGuards(JwtAuthGuard)
  @Post('ticket')
  issueTicket(@Req() req: any) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('未认证');
    const ttlSeconds = resolveLlmTicketTtlSeconds(
      this.config.get<string>('LLM_PROXY_TICKET_TTL_SECONDS'),
    );
    const ticket = this.jwt.sign(
      { sub: userId, type: LLM_PROXY_TOKEN_TYPE },
      { expiresIn: ttlSeconds },
    );
    return {
      ticket,
      ttlSeconds,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  @Post('chat/completions')
  async chatCompletions(
    @Body() body: Record<string, any>,
    @Req() req: any,
    @Res() res: Response,
  ) {
    // 没有凭证就直接花掉平台 LLM 额度，是本端点此前最大的问题：
    // 无全局守卫 + 无控制器守卫 = 谁能连到端口谁就能用。
    const authHeader = String(req?.headers?.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      throw new UnauthorizedException('缺少 LLM 代理票据，请登录后重新试运行');
    }

    let claims: unknown;
    try {
      claims = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('LLM 代理票据无效或已过期，请重新试运行');
    }
    const decision = classifyLlmProxyToken(claims);
    if (!decision.ok) throw new UnauthorizedException(decision.reason);

    const userId = String((claims as { sub?: unknown }).sub || 'unknown');
    this.limiter.assertAllowed(userId, 'LLM 代理调用');

    const apiHost = (this.config.get<string>('LLM_API_HOST', '') || '').trim().replace(/\/+$/, '');
    const apiKey = (this.config.get<string>('LLM_API_KEY', '') || '').trim();
    const defaultModel = (this.config.get<string>('LLM_DEFAULT_MODEL', '') || '').trim();

    if (!apiHost || !apiKey) {
      throw new BadRequestException('服务端未配置 LLM_API_HOST / LLM_API_KEY，无法执行大语言模型节点');
    }

    let upstreamUrl: string;
    try {
      upstreamUrl = new URL(`${apiHost}/chat/completions`).toString();
    } catch {
      throw new BadRequestException('LLM_API_HOST 不是有效的 HTTP(S) 地址');
    }

    // 单次成本也要有上限：票据管身份、限流管频率，这里管「一次最多花多少」
    const limits = {
      maxTokens: resolveRateLimit(this.config.get<string>('LLM_PROXY_MAX_TOKENS'), 4096),
      maxCompletions: resolveRateLimit(this.config.get<string>('LLM_PROXY_MAX_COMPLETIONS'), 1),
    };
    const { payload: bounded, clamped } = clampLlmCostFields(body, limits);
    if (clamped.length) {
      // 频率已被限流器压住，这里的日志不会变成刷屏；留一条便于运营发现滥用
      this.logger.warn(`LLM 代理请求超出单次上限，已收敛：${clamped.join('、')}（用户 ${userId}）`);
    }
    const payload = {
      ...bounded,
      model: defaultModel || body?.model || 'gpt-4o-mini',
    };

    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });

      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.send(text);
    } catch (error: any) {
      this.logger.error(`LLM 代理请求失败: ${describeError(error)}`);
      res.status(502).json({
        statusCode: 502,
        message: `LLM 代理请求失败: ${describeErrorBrief(error, '上游不可达')}`,
      });
    }
  }
}