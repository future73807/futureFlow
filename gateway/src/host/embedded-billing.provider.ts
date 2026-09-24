import { Logger } from '@nestjs/common';

import type { BillingService } from '../billing/billing.service';
import type { HostConfig } from './host.config';
import { HostHttpClient } from './host-http.client';
import type { HostBillingProvider, HostCapabilities } from './host.types';

/**
 * 内嵌形态的计费 Provider：把三段事务**交给宿主**（宿主 credits / 第三方网关）。
 *
 * 三条口径：
 *  ① **幂等键固定为 `flow:<runId>:<op>`**：网关重试、宿主重试、进程重启后重跑同一 run
 *     都不会重复扣费（宿主只需按这个键去重）；
 *  ② **宿主没有计费回调 = 回落自带 balance**（缝缺失时降级到独立实现）；
 *  ③ **有回调但调用失败 = 直接失败**：静默降级会变成「用了服务但没人付钱」，
 *     比报错严重得多（与凭证缝同一条纪律）。
 */
export class EmbeddedBillingProvider implements HostBillingProvider {
  readonly kind = 'embedded' as const;
  private readonly logger = new Logger(EmbeddedBillingProvider.name);

  constructor(
    private readonly config: HostConfig,
    private readonly http: HostHttpClient,
    private readonly billing: BillingService,
    readonly capabilities: HostCapabilities,
  ) {}

  async freezeBalance(
    userId: string,
    estimatedCost: number,
    runId: string,
  ): Promise<number> {
    if (!this.config.endpoints.billing) {
      return this.billing.freezeBalance(userId, estimatedCost, runId);
    }

    await this.http.postJson<unknown>(
      this.config.endpoints.billing,
      {
        op: 'reserve',
        protocolVersion: this.config.protocolVersion,
        runId,
        userId,
        amount: estimatedCost,
      },
      { label: '计费预扣', idempotencyKey: this.key(runId, 'reserve') },
    );
    this.logger.log(`宿主计费预扣成功: runId=${runId}, amount=${estimatedCost}`);
    return estimatedCost;
  }

  async settleBilling(
    userId: string,
    frozenAmount: number,
    actualCost: number,
    runId: string,
    remark: string,
    usage?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.endpoints.billing) {
      await this.billing.settleBilling(
        userId,
        frozenAmount,
        actualCost,
        runId,
        remark,
      );
      return;
    }

    await this.http.postJson<unknown>(
      this.config.endpoints.billing,
      {
        op: 'settle',
        protocolVersion: this.config.protocolVersion,
        runId,
        userId,
        frozenAmount,
        actualCost,
        usage: usage ?? {},
        remark,
      },
      { label: '计费结算', idempotencyKey: this.key(runId, 'settle') },
    );
    this.logger.log(`宿主计费结算成功: runId=${runId}, cost=${actualCost}`);
  }

  async refund(
    userId: string,
    frozenAmount: number,
    runId: string,
  ): Promise<void> {
    if (!this.config.endpoints.billing) {
      await this.billing.refund(userId, frozenAmount, runId);
      return;
    }

    await this.http.postJson<unknown>(
      this.config.endpoints.billing,
      {
        op: 'refund',
        protocolVersion: this.config.protocolVersion,
        runId,
        userId,
        amount: frozenAmount,
      },
      { label: '计费退款', idempotencyKey: this.key(runId, 'refund') },
    );
    this.logger.log(`宿主计费退款成功: runId=${runId}, amount=${frozenAmount}`);
  }

  /**
   * 计价仍用 flow 自己的价目表：它是**账目参考**（宿主可以按自己的口径重算），
   * 但预扣与结算的实际金额以传给宿主的 amount / actualCost 为准。
   */
  calculateCost(
    totalTokens: number,
    modelName: string,
    difyTotalPrice?: number,
  ): number {
    return this.billing.calculateCost(totalTokens, modelName, difyTotalPrice);
  }

  private key(runId: string, op: string): string {
    return `flow:${runId}:${op}`;
  }
}
