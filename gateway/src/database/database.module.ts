import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { BalanceLog } from './entities/balance-log.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { DifyIntegration } from './entities/dify-integration.entity';
import { SeedService } from './seed.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, BalanceLog, WorkflowRun, DifyIntegration])],
  providers: [SeedService],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
