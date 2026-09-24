import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { HostConfig } from './host/host.config';
import { HOST_CONFIG } from './host/host.types';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const port = config.get<number>('GATEWAY_PORT', 3001);
  const host = config.get<string>('GATEWAY_HOST', '127.0.0.1').trim() || '127.0.0.1';
  const isProduction = config.get<string>('NODE_ENV') === 'production';

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const configuredOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const isLocalDevelopmentOrigin = (origin?: string) => {
    if (isProduction || !origin) return false;

    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname === '::1'
      );
    } catch {
      return false;
    }
  };

  // 内嵌形态（ff-embed）：宿主页面里的 flow 前端会**跨域**调本网关，
  // 所以宿主 origin 必须进 CORS 允许列表——它的权威来源是 HOST_ALLOWED_ORIGINS
  // （网关据此下发白名单给前端做 postMessage 校验，两处用的是同一份配置）。
  const hostConfig = app.get<HostConfig>(HOST_CONFIG);
  const allowedOrigins = new Set([...configuredOrigins, ...hostConfig.allowedOrigins]);

  // 被拒来源只提示一次，避免页面反复重试或扫描器把日志刷满。
  const warnedOrigins = new Set<string>();

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin) || isLocalDevelopmentOrigin(origin)) {
        callback(null, true);
        return;
      }
      // 不回 CORS 头即可：浏览器会自行拦截，无需在服务端制造 500。
      // 之前用 callback(new Error(...)) 会把每个被拒来源变成一条完整堆栈，
      // 既污染日志，又让排查方向被误导向服务端故障。
      if (warnedOrigins.size < 50 && !warnedOrigins.has(origin)) {
        warnedOrigins.add(origin);
        Logger.warn(
          `拒绝跨域来源 ${origin}；允许列表：${[...allowedOrigins].join(', ') || '(空)'}`
            + '（本地开发下 http(s)://localhost|127.0.0.1 自动放行）',
          'CORS',
        );
      }
      callback(null, false);
    },
    credentials: true,
  });

  warnMediaGatewayPortMismatch(config, Number(port));

  await app.listen(port, host);
  Logger.log(`futureFlow gateway started: http://${host}:${port}`, 'Bootstrap');
  Logger.log(
    'Dify API: ' + (config.get('DIFY_API_BASE') || '(not configured)'),
    'Bootstrap',
  );
}

/**
 * 检查「Dify 回连网关」的端口是否与网关监听端口一致，不一致就在启动时点出来。
 *
 * 原生图片/视频节点发布后走「Dify → SSRF 代理 → 宿主网关」回调，这条链路要求
 * 三处端口一致：网关监听端口、网关侧回连地址（`DIFY_MEDIA_GATEWAY_URL` 或
 * `DIFY_MEDIA_GATEWAY_PORT`）、以及 SSRF 代理的白名单（compose 的
 * `MEDIA_GATEWAY_PORT`，默认值已改为跟随 `GATEWAY_PORT`）。
 *
 * 不一致时媒体节点会以 **Squid 403** 失败 —— 报错发生在 SSRF 代理层，
 * 与真因（改了 GATEWAY_PORT 但没同步另外两处）隔得很远，很容易查错方向。
 * 这里在启动日志里直接点明，省掉那趟弯路。
 *
 * 只告警、不阻断启动：走反向代理时两者本就允许不同，而且只在地址里**写了明确端口**
 * 时才比较（没写端口说明前面有代理，无法推断真实端口）。
 */
function warnMediaGatewayPortMismatch(config: ConfigService, listenPort: number): void {
  const explicitUrl = String(config.get<string>('DIFY_MEDIA_GATEWAY_URL') || '').trim();
  const explicitPort = String(config.get<string>('DIFY_MEDIA_GATEWAY_PORT') || '').trim();

  let effectivePort: number | null = null;
  if (explicitUrl) {
    try {
      const parsed = new URL(explicitUrl);
      effectivePort = parsed.port ? Number.parseInt(parsed.port, 10) : null;
    } catch {
      effectivePort = null;
    }
  } else if (explicitPort) {
    const parsed = Number.parseInt(explicitPort, 10);
    effectivePort = Number.isNaN(parsed) ? null : parsed;
  }

  if (effectivePort === null || effectivePort === listenPort) return;

  Logger.warn(
    `媒体回连端口与网关监听端口不一致：回连地址指向 ${effectivePort}，但网关监听 ${listenPort}。`
    + '原生图片/视频节点会以 Squid 403 失败（报错在 SSRF 代理层，与真因相隔很远）。'
    + '请把 .env 里的 GATEWAY_PORT、DIFY_MEDIA_GATEWAY_URL、DIFY_MEDIA_GATEWAY_PORT 改成一致，'
    + '并重建 SSRF 代理让白名单重新生成；若确实走反向代理，请忽略本条。',
    'Bootstrap',
  );
}

void bootstrap();
