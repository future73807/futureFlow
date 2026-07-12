import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowCrudController } from './workflow-crud.controller';
import { WorkflowCrudService } from './workflow-crud.service';
import { DirectLlmService } from './direct-llm.service';
import { ConverterModule } from '../converter/converter.module';
import { DifyModule } from '../dify/dify.module';
import { BillingModule } from '../billing/billing.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowRun, Workflow]),
    ConverterModule,
    DifyModule,
    BillingModule,
    AuthModule,
  ],
  controllers: [WorkflowsController, WorkflowCrudController],
  providers: [WorkflowsService, WorkflowCrudService, DirectLlmService],
})
export class WorkflowsModule {}
