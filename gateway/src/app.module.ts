import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ConverterModule } from './converter/converter.module';
import { DifyModule } from './dify/dify.module';
import { WorkflowsModule } from './workflows/workflows.module';

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
      synchronize: true, // 开发环境自动同步表结构,生产环境应关闭
      logging: false,
    }),
    DatabaseModule,
    AuthModule,
    BillingModule,
    ConverterModule,
    DifyModule,
    WorkflowsModule,
  ],
})
export class AppModule {}
