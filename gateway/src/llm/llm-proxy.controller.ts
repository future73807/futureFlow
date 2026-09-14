import { BadRequestException, Controller, Post, Body, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { Logger } from '@nestjs/common';

/**
 * LLM 直连代理（浏览器试运行专用）
 *
 * 画布「试运行」在浏览器端执行 runtime-js，大语言模型节点需要 OpenAI
 * 兼容的 chat/completions 端点。模型服务商通常不允许浏览器跨域直连
 * （CORS 预检 403），且 API Key 不应下发到浏览器，因此统一走网关代理：
 *
 *   浏览器 → POST /llm/chat/completions → ${LLM_API_HOST}/chat/completions
 *
 * - 鉴权：使用服务端 LLM_API_KEY，请求方的 Authorization 头会被忽略
 * - 模型：服务端 LLM_DEFAULT_MODEL 具有最高优先级（画布上的模型名仅作展示）
 * - 转发：仅转发到 LLM_API_HOST 配置的单一上游，不构成开放代理
 */
@Controller('llm')
export class LlmProxyController {
  private readonly logger = new Logger(LlmProxyController.name);

  constructor(private readonly config: ConfigService) {}

  @Post('chat/completions')
  async chatCompletions(@Body() body: Record<string, any>, @Res() res: Response) {
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

    const payload = {
      ...body,
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
      this.logger.error(`LLM 代理请求失败: ${error?.message}`);
      res.status(502).json({
        statusCode: 502,
        message: `LLM 代理请求失败: ${error?.message || '上游不可达'}`,
      });
    }
  }
}