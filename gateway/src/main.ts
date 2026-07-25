import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const port = config.get<number>('GATEWAY_PORT', 3001);
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

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin) || isLocalDevelopmentOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by CORS'), false);
    },
    credentials: true,
  });

  await app.listen(port);
  Logger.log('futureFlow gateway started: http://localhost:' + port, 'Bootstrap');
  Logger.log(
    'Dify API: ' + (config.get('DIFY_API_BASE') || '(not configured)'),
    'Bootstrap',
  );
}

void bootstrap();
