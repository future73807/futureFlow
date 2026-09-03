import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DifyModule } from '../dify/dify.module';
import { KnowledgeDatasetOwner } from '../database/entities/knowledge-dataset-owner.entity';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [AuthModule, DifyModule, TypeOrmModule.forFeature([KnowledgeDatasetOwner])],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
