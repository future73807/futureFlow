import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { BillingService } from '../billing/billing.service';
import { User } from '../database/entities/user.entity';
import { EmbeddedBillingProvider } from './embedded-billing.provider';
import { EmbeddedCredentialsProvider } from './embedded-credentials.provider';
import { EmbeddedEventSink } from './embedded-events.provider';
import { EmbeddedIdentityProvider } from './embedded-identity.provider';
import { HostController } from './host.controller';
import { HostHttpClient } from './host-http.client';
import { HostSessionService } from './host-session.service';
import {
  hostCapabilities,
  readHostConfig,
  type HostConfig,
} from './host.config';
import {
  StandaloneBillingProvider,
  StandaloneCredentialsProvider,
  StandaloneEventSink,
  StandaloneIdentityProvider,
} from './standalone-providers';
import {
  HOST_BILLING,
  HOST_CONFIG,
  HOST_CREDENTIALS,
  HOST_EVENTS,
  HOST_IDENTITY,
  HOST_SUBJECT_LOOKUP,
  type HostSubjectLookup,
} from './host.types';

/**
 * 宿主适配层模块：**一处**按 `HOST_MODE` 决定六缝用哪套 Provider。
 *
 * 装配规则（与《flow 集成方案》§3.2 一致）：
 *  - `standalone` → 四个自带 Provider（兜底实现，行为与改造前一致）；
 *  - `embedded`   → 宿主 Provider，但**每一项都能单独缺失**：缺回调地址的那一项
 *    回落自带实现，并在 `capabilities` 的 notes 里写明原因（降级要能被看见）。
 *
 * Consumer 只按 `HOST_*` 令牌取实现，不认具体类；装配之外的代码里**不允许**出现
 * `if (embedded)` 之类的模式分支。
 */
@Module({
  imports: [AuthModule, BillingModule, TypeOrmModule.forFeature([User])],
  controllers: [HostController],
  providers: [
    {
      provide: HOST_CONFIG,
      useFactory: (config: ConfigService) => readHostConfig(config),
      inject: [ConfigService],
    },
    {
      provide: HostHttpClient,
      useFactory: (config: HostConfig) => new HostHttpClient(config),
      inject: [HOST_CONFIG],
    },
    /**
     * 计费归属键解析：flow 用户 → `users.hostSubject`（身份缝开户时写入）。
     * 两种形态都提供（独立 Provider 用不到它，但装配保持一处、不按模式分叉）。
     */
    {
      provide: HOST_SUBJECT_LOOKUP,
      useFactory: (users: Repository<User>): HostSubjectLookup => ({
        async findHostSubject(userId: string) {
          const user = await users.findOne({ where: { id: userId } });
          return user?.hostSubject?.trim() || null;
        },
      }),
      inject: [getRepositoryToken(User)],
    },
    {
      provide: HOST_IDENTITY,
      useFactory: (config: HostConfig, http: HostHttpClient) =>
        config.mode === 'embedded'
          ? new EmbeddedIdentityProvider(
              config,
              http,
              hostCapabilities(config).capabilities,
            )
          : new StandaloneIdentityProvider(),
      inject: [HOST_CONFIG, HostHttpClient],
    },
    {
      provide: HOST_CREDENTIALS,
      useFactory: (config: HostConfig, http: HostHttpClient) =>
        config.mode === 'embedded'
          ? new EmbeddedCredentialsProvider(
              config,
              http,
              hostCapabilities(config).capabilities,
            )
          : new StandaloneCredentialsProvider(),
      inject: [HOST_CONFIG, HostHttpClient],
    },
    {
      provide: HOST_BILLING,
      useFactory: (
        config: HostConfig,
        http: HostHttpClient,
        billing: BillingService,
        subjectLookup: HostSubjectLookup,
      ) =>
        config.mode === 'embedded'
          ? new EmbeddedBillingProvider(
              config,
              http,
              billing,
              hostCapabilities(config).capabilities,
              subjectLookup,
            )
          : new StandaloneBillingProvider(billing),
      inject: [
        HOST_CONFIG,
        HostHttpClient,
        BillingService,
        HOST_SUBJECT_LOOKUP,
      ],
    },
    {
      provide: HOST_EVENTS,
      useFactory: (config: HostConfig, http: HostHttpClient) =>
        config.mode === 'embedded'
          ? new EmbeddedEventSink(config, http, hostCapabilities(config).capabilities)
          : new StandaloneEventSink(),
      inject: [HOST_CONFIG, HostHttpClient],
    },
    HostSessionService,
  ],
  exports: [
    HOST_CONFIG,
    HOST_IDENTITY,
    HOST_CREDENTIALS,
    HOST_BILLING,
    HOST_EVENTS,
    HostSessionService,
  ],
})
export class HostModule {}
