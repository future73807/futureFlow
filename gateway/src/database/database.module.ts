import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { BalanceLog } from './entities/balance-log.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { SeedService } from './seed.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, BalanceLog, WorkflowRun])],
  providers: [SeedService],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
