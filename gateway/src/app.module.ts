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

@Module({
  imports: [
    // 环境变量配置
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
    }),
    // TypeORM 配置
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'futureflow',
      password: process.env.POSTGRES_PASSWORD || 'futureflow123',
      database: process.env.POSTGRES_DB || 'futureflow',
      autoLoadEntities: true,
      // 开发环境自动同步表结构,生产环境关闭
      synchronize: process.env.NODE_ENV !== 'production',
      logging: false,
    }),
    // JWT 配置（全局可用）
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('GATEWAY_JWT_SECRET', 'change-me-in-production'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '1h'),
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
  ],
})
export class AppModule {}
