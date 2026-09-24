import { BadRequestException } from '@nestjs/common';

import type { BillingService } from '../billing/billing.service';
import {
  type EngineCredentialsResolution,
  type HostBillingProvider,
  type HostCapabilities,
  type HostEventSink,
  type HostIdentity,
  type HostIdentityProvider,
  type HostRunEvent,
  LOCAL_CAPABILITIES,
} from './host.types';

/**
 * 独立形态的四个 Provider —— **兜底实现，常驻可用**。
 *
 * 它们把「今天的行为」原样包进缝里：身份来自自带账号体系、凭证来自 `.env`、
 * 计费走自带 balance、事件只走本地 SSE。内嵌形态任何一项缺失或宿主不可信时，
 * flow 都降级到这里继续跑（而不是崩溃或半残）。
 *
 * 这些 Provider 刻意**很薄**：它们不是重新实现一遍业务，只是把既有实现接到缝上，
 * 因此独立形态的行为与改造前**逐字节一致**（回归由既有 smoke 套件保证）。
 */

const LOCAL = LOCAL_CAPABILITIES;

export class StandaloneIdentityProvider implements HostIdentityProvider {
  readonly kind = 'standalone' as const;
  readonly capabilities: HostCapabilities = LOCAL;

  async resolveIdentity(_hostToken: string): Promise<HostIdentity> {
    // 明确拒绝而不是抛未实现：宿主配错地址时，这条消息比「500」有用得多。
    throw new BadRequestException(
      '本网关以独立模式运行（HOST_MODE=standalone），不接受宿主身份注入。'
        + '要以内嵌形态挂在宿主里，请在 .env 里设 HOST_MODE=embedded 并配置 '
        + 'HOST_SHARED_SECRET / HOST_IDENTITY_VERIFY_URL。',
    );
  }
}

export class StandaloneCredentialsProvider {
  readonly kind = 'standalone' as const;
  readonly capabilities: HostCapabilities = LOCAL;

  /** 独立形态没有宿主凭证：消费方按 `local` 走 `.env` 全局密钥（既有路径）。 */
  async resolveEngineCredentials(): Promise<EngineCredentialsResolution> {
    return { source: 'local' };
  }
}

export class StandaloneBillingProvider implements HostBillingProvider {
  readonly kind = 'standalone' as const;
  readonly capabilities: HostCapabilities = LOCAL;

  constructor(private readonly billing: BillingService) {}

  async freezeBalance(
    userId: string,
    estimatedCost: number,
    runId: string,
  ): Promise<number> {
    return this.billing.freezeBalance(userId, estimatedCost, runId);
  }

  async settleBilling(
    userId: string,
    frozenAmount: number,
    actualCost: number,
    runId: string,
    remark: string,
  ): Promise<void> {
    await this.billing.settleBilling(
      userId,
      frozenAmount,
      actualCost,
      runId,
      remark,
    );
  }

  async refund(
    userId: string,
    frozenAmount: number,
    runId: string,
  ): Promise<void> {
    await this.billing.refund(userId, frozenAmount, runId);
  }

  calculateCost(
    totalTokens: number,
    modelName: string,
    difyTotalPrice?: number,
  ): number {
    return this.billing.calculateCost(totalTokens, modelName, difyTotalPrice);
  }
}

export class StandaloneEventSink implements HostEventSink {
  readonly kind = 'standalone' as const;
  readonly capabilities: HostCapabilities = LOCAL;

  /** 独立形态的事件通道就是本地 SSE（消费方直接透传），这里无需再发一份。 */
  async publish(_event: HostRunEvent): Promise<void> {}

  async flush(): Promise<void> {}
}
