import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  // AuthModule 导出 JwtAuthGuard 及其依赖的 User 仓库
  imports: [AuthModule, TypeOrmModule.forFeature([WorkflowRun])],
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}
