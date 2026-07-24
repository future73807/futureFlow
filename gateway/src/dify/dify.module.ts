import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DifyConfigService } from './dify-config.service';
import { DifyClientService } from './dify-client.service';
import { DifyConsoleService } from './dify-console.service';
import { DifyIntegrationService } from './dify-integration.service';
import { ConverterModule } from '../converter/converter.module';
import { DifyIntegration } from '../database/entities/dify-integration.entity';

@Module({
  imports: [ConverterModule, TypeOrmModule.forFeature([DifyIntegration])],
  providers: [
    DifyConfigService,
    DifyClientService,
    DifyConsoleService,
    DifyIntegrationService,
  ],
  exports: [
    DifyConfigService,
    DifyClientService,
    DifyConsoleService,
    DifyIntegrationService,
  ],
})
export class DifyModule {}
