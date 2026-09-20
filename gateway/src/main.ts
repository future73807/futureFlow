import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

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

  const allowedOrigins = new Set(configuredOrigins);

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

  await app.listen(port, host);
  Logger.log(`futureFlow gateway started: http://${host}:${port}`, 'Bootstrap');
  Logger.log(
    'Dify API: ' + (config.get('DIFY_API_BASE') || '(not configured)'),
    'Bootstrap',
  );
}

void bootstrap();
