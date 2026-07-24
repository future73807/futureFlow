import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { ApiKey } from '../database/entities/api-key.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { BalanceLog } from '../database/entities/balance-log.entity';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { DifyModule } from '../dify/dify.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, ApiKey, Workflow, WorkflowRun, BalanceLog]),
    AuthModule,
    DifyModule,
  ],
  controllers: [AdminController],
  providers: [AdminGuard, AdminService],
})
export class AdminModule {}
