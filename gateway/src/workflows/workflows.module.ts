import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowVersion } from '../database/entities/workflow-version.entity';
import { DraftSandbox } from '../database/entities/draft-sandbox.entity';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowCrudController } from './workflow-crud.controller';
import { WorkflowCrudService } from './workflow-crud.service';
import { DraftRunService } from './draft-run.service';
import { WorkflowExecutionGuardService } from './services/workflow-execution-guard.service';
import { ConverterModule } from '../converter/converter.module';
import { DifyModule } from '../dify/dify.module';
import { BillingModule } from '../billing/billing.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowRun, Workflow, WorkflowVersion, DraftSandbox]),
    ConverterModule,
    DifyModule,
    BillingModule,
    AuthModule,
  ],
  controllers: [WorkflowsController, WorkflowCrudController],
  providers: [
    WorkflowsService,
    WorkflowCrudService,
    DraftRunService,
    WorkflowExecutionGuardService,
  ],
  exports: [WorkflowsService, WorkflowCrudService],
})
export class WorkflowsModule {}
