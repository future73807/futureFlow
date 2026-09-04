import { Module } from '@nestjs/common';
import { DifyModule } from '../dify/dify.module';
import { HealthController } from './health.controller';

@Module({ imports: [DifyModule], controllers: [HealthController] })
export class HealthModule {}
