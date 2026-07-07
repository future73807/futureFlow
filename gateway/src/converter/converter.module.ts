import { Module } from '@nestjs/common';
import { DifyConverterService } from './dify-converter.service';

@Module({
  providers: [DifyConverterService],
  exports: [DifyConverterService],
})
export class ConverterModule {}
