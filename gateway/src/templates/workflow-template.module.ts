import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ConverterModule } from '../converter/converter.module';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowTemplate } from '../database/entities/workflow-template.entity';
import { WorkflowTemplateController } from './workflow-template.controller';
import { WorkflowTemplateService } from './workflow-template.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowTemplate, Workflow]), ConverterModule, AuthModule],
  controllers: [WorkflowTemplateController],
  providers: [WorkflowTemplateService],
})
export class WorkflowTemplateModule {}
