import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const port = config.get<number>('GATEWAY_PORT', 3001);

  // 全局 DTO 校验
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // CORS:白名单模式，仅允许配置的前端来源
  const corsOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim());
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  await app.listen(port);
  Logger.log(`🚀 futureFlow 网关已启动: http://localhost:${port}`, 'Bootstrap');
  Logger.log(
    `   Dify API: ${config.get('DIFY_API_BASE') || '(未配置,将使用默认 http://localhost/v1)'}`,
    'Bootstrap',
  );
}
bootstrap();
