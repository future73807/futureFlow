import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ConverterModule } from '../converter/converter.module';
import { BatchTask } from '../database/entities/batch-task.entity';
import { User } from '../database/entities/user.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { WorkflowsModule } from '../workflows/workflows.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * 任务中心模块：批量执行复用工作流模块的执行/发布快照/草稿沙箱能力，
 * AuthModule 提供 JwtAuthGuard（守卫也需要其导出的 User 仓库）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BatchTask, WorkflowRun, Workflow, User]),
    WorkflowsModule,
    AuthModule,
    ConverterModule,
  ],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
