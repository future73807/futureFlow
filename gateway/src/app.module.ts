import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GlobalAuthGuard } from './common/guards/global-auth.guard';
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
import { KnowledgeModule } from './knowledge/knowledge.module';
import { FilesModule } from './files/files.module';
import { McpModule } from './mcp/mcp.module';
import { LlmModule } from './llm/llm.module';
import { LocalToolsModule } from './localtools/localtools.module';
import { PluginsModule } from './plugins/plugins.module';
import { TasksModule } from './tasks/tasks.module';

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
      // 运行时优先用权限受限的应用账号。POSTGRES_USER 是镜像建出来的超级用户，
      // 只应由迁移脚本使用（见 database/data-source.ts）；注入或配置泄露时，
      // 用它能直接控制整个 Postgres 实例，用应用账号只能碰到 futureflow 库。
      username:
        config.get<string>('POSTGRES_APP_USER') ||
        config.get<string>('POSTGRES_USER', 'futureflow'),
      password:
        config.get<string>('POSTGRES_APP_PASSWORD') ||
        config.getOrThrow<string>('POSTGRES_PASSWORD'),
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
    KnowledgeModule,
    FilesModule,
    McpModule,
    LlmModule,
    LocalToolsModule,
    PluginsModule,
    TasksModule,
  ],
  providers: [
    // 全局鉴权：默认要登录，只有显式 @Public() 或自带守卫的路由才放行。
    // 之前「某控制器要不要鉴权」全靠开发者记得写 @UseGuards，出过两次事故。
    { provide: APP_GUARD, useClass: GlobalAuthGuard },
  ],
})
export class AppModule {}
