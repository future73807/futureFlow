import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DifyModule } from '../dify/dify.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [AuthModule, DifyModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
