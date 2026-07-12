import { Module } from '@nestjs/common';
import { DifyConfigService } from './dify-config.service';
import { DifyClientService } from './dify-client.service';
import { DifyConsoleService } from './dify-console.service';
import { ConverterModule } from '../converter/converter.module';

@Module({
  imports: [ConverterModule],
  providers: [DifyConfigService, DifyClientService, DifyConsoleService],
  exports: [DifyConfigService, DifyClientService, DifyConsoleService],
})
export class DifyModule {}
