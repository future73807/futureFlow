import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ConverterModule } from './converter/converter.module';
import { DifyModule } from './dify/dify.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { AdminModule } from './admin/admin.module';
import { validateEnvironment } from './config/environment.validation';
import { HealthModule } from './health/health.module';
import { WorkflowTemplateModule } from './templates/workflow-template.module';
import { WorkflowTriggerModule } from './triggers/workflow-trigger.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [
    // 环境变量配置
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        '.futureflow.runtime.env',
        '.env',
        '../.futureflow.runtime.env',
        '../.env',
      ],
      validate: validateEnvironment,
    }),
    // TypeORM 配置
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
      type: 'postgres',
      host: config.get<string>('POSTGRES_HOST', 'localhost'),
      port: Number.parseInt(config.get<string>('POSTGRES_PORT', '5432'), 10),
      username: config.get<string>('POSTGRES_USER', 'futureflow'),
      password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
      database: config.get<string>('POSTGRES_DB', 'futureflow'),
      autoLoadEntities: true,
      // 开发环境自动同步表结构,生产环境关闭
      synchronize: config.get<string>('NODE_ENV') !== 'production',
      logging: false,
      }),
    }),
    // JWT 配置（全局可用）
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('GATEWAY_JWT_SECRET'),
        signOptions: {
          // 默认 7 天过期，避免画布长时间编辑后保存失败
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d'),
        } as any,
      }),
    }),
    DatabaseModule,
    AuthModule,
    BillingModule,
    ConverterModule,
    DifyModule,
    WorkflowsModule,
    AdminModule,
    HealthModule,
    WorkflowTemplateModule,
    WorkflowTriggerModule,
    MediaModule,
  ],
})
export class AppModule {}
