import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DifyConfigService } from './dify-config.service';
import { DifyClientService } from './dify-client.service';
import { DifyConsoleService } from './dify-console.service';
import { DifyIntegrationService } from './dify-integration.service';
import { ConverterModule } from '../converter/converter.module';
import { DifyIntegration } from '../database/entities/dify-integration.entity';
import { HostModule } from '../host/host.module';
import { HostProjectControlGuard } from '../host/project-control.controller';
import { HostDifyReauthorizeController } from './host-dify-reauthorize.controller';

@Module({
  imports: [
    ConverterModule,
    TypeOrmModule.forFeature([DifyIntegration]),
    // 凭证缝：内嵌形态下引擎地址与 Key 由宿主下发（DifyClientService 消费）。
    // HostModule 导出 HOST_CONFIG，宿主共享密钥 Guard 在此复用不会形成循环依赖。
    HostModule,
  ],
  controllers: [HostDifyReauthorizeController],
  providers: [
    DifyConfigService,
    DifyClientService,
    DifyConsoleService,
    DifyIntegrationService,
    HostProjectControlGuard,
  ],
  exports: [
    DifyConfigService,
    DifyClientService,
    DifyConsoleService,
    DifyIntegrationService,
  ],
})
export class DifyModule {}
