import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { BalanceLog } from '../database/entities/balance-log.entity';
import { BillingService } from './billing.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, BalanceLog])],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
