import { Module } from '@nestjs/common';
import { DifyClientService } from './dify-client.service';
import { DifyConsoleService } from './dify-console.service';
import { ConverterModule } from '../converter/converter.module';

@Module({
  imports: [ConverterModule],
  providers: [DifyClientService, DifyConsoleService],
  exports: [DifyClientService, DifyConsoleService],
})
export class DifyModule {}
