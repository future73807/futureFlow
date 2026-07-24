import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { User } from '../database/entities/user.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowTrigger } from '../database/entities/workflow-trigger.entity';
import { WorkflowsModule } from '../workflows/workflows.module';
import { WebhookController } from './webhook.controller';
import { WorkflowTriggerController } from './workflow-trigger.controller';
import { WorkflowTriggerSchedulerService } from './workflow-trigger-scheduler.service';
import { WorkflowTriggerService } from './workflow-trigger.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowTrigger, Workflow, User]),
    AuthModule,
    WorkflowsModule,
  ],
  controllers: [WorkflowTriggerController, WebhookController],
  providers: [WorkflowTriggerService, WorkflowTriggerSchedulerService],
})
export class WorkflowTriggerModule {}
