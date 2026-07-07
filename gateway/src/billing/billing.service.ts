import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { User } from '../database/entities/user.entity';
import { BalanceLog } from '../database/entities/balance-log.entity';
import { MODEL_PRICING, DEFAULT_PRICING } from './pricing.config';

/**
 * 扣费服务
 * 实现执行前冻结、执行后扣费、失败退款的全流程
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(BalanceLog)
    private readonly balanceLogRepo: Repository<BalanceLog>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 扣费预检:校验余额是否充足,并冻结预估费用
   *
   * @param userId 用户 ID
   * @param estimatedCost 预估费用(元)
   * @param workflowRunId 工作流运行 ID
   * @returns 冻结金额
   */
  async freezeBalance(
    userId: string,
    estimatedCost: number,
    workflowRunId: string,
  ): Promise<number> {
    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        throw new BadRequestException('用户不存在');
      }

      const availableBalance = user.balance - user.frozenBalance;
      if (availableBalance < estimatedCost) {
        throw new BadRequestException(
          `余额不足:需要 ${estimatedCost.toFixed(4)} 元,可用 ${availableBalance.toFixed(4)} 元`,
        );
      }

      // 冻结预估费用
      user.frozenBalance = parseFloat(user.frozenBalance.toString()) + estimatedCost;
      await manager.save(user);

      // 记录冻结流水
      const log = manager.create(BalanceLog, {
        userId,
        type: 'freeze',
        amount: -estimatedCost,
        balanceAfter: parseFloat(user.balance.toString()),
        workflowRunId,
        remark: `工作流预扣费冻结`,
      });
      await manager.save(log);

      this.logger.log(
        `冻结余额: userId=${userId}, amount=${estimatedCost}, frozenTotal=${user.frozenBalance}`,
      );

      return estimatedCost;
    });
  }

  /**
   * 执行后扣费:根据实际 token 用量计算最终费用并扣除
   * 解冻预扣金额,扣除实际费用,剩余部分返还
   *
   * @param userId 用户 ID
   * @param frozenAmount 之前冻结的金额
   * @param actualCost 实际费用
   * @param workflowRunId 工作流运行 ID
   * @param remark 备注(如 token 用量明细)
   */
  async settleBilling(
    userId: string,
    frozenAmount: number,
    actualCost: number,
    workflowRunId: string,
    remark: string,
  ): Promise<void> {
    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        this.logger.error(`扣费时用户不存在: ${userId}`);
        return;
      }

      // 1. 解冻预扣金额
      user.frozenBalance = parseFloat(user.frozenBalance.toString()) - frozenAmount;
      if (user.frozenBalance < 0) user.frozenBalance = 0;

      // 2. 扣除实际费用
      user.balance = parseFloat(user.balance.toString()) - actualCost;

      await manager.save(user);

      // 记录解冻流水
      const unfreezeLog = manager.create(BalanceLog, {
        userId,
        type: 'unfreeze',
        amount: frozenAmount,
        balanceAfter: parseFloat(user.balance.toString()),
        workflowRunId,
        remark: `解冻预扣金额`,
      });
      await manager.save(unfreezeLog);

      // 记录实际扣费流水
      const deductLog = manager.create(BalanceLog, {
        userId,
        type: 'deduct',
        amount: -actualCost,
        balanceAfter: parseFloat(user.balance.toString()),
        workflowRunId,
        remark,
      });
      await manager.save(deductLog);

      this.logger.log(
        `扣费完成: userId=${userId}, frozen=${frozenAmount}, actual=${actualCost}, balance=${user.balance}`,
      );
    });
  }

  /**
   * 执行失败退款:解冻全部预扣金额
   */
  async refund(
    userId: string,
    frozenAmount: number,
    workflowRunId: string,
  ): Promise<void> {
    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) return;

      user.frozenBalance = parseFloat(user.frozenBalance.toString()) - frozenAmount;
      if (user.frozenBalance < 0) user.frozenBalance = 0;

      await manager.save(user);

      const log = manager.create(BalanceLog, {
        userId,
        type: 'unfreeze',
        amount: frozenAmount,
        balanceAfter: parseFloat(user.balance.toString()),
        workflowRunId,
        remark: '工作流执行失败,全额解冻退款',
      });
      await manager.save(log);

      this.logger.log(
        `退款完成: userId=${userId}, amount=${frozenAmount}`,
      );
    });
  }

  /**
   * 根据 token 用量计算费用(元)
   * 使用 Dify 返回的 total_price 优先,否则按本地定价表计算
   *
   * @param totalTokens 总 token 数
   * @param modelName 模型名(用于查定价表)
   * @param difyTotalPrice Dify 返回的 total_price(USD)
   * @returns 费用(元)
   */
  calculateCost(
    totalTokens: number,
    modelName: string,
    difyTotalPrice?: number,
  ): number {
    // 优先使用 Dify 返回的费用(USD → 元,按 7.2 汇率)
    if (difyTotalPrice && difyTotalPrice > 0) {
      return Math.round(difyTotalPrice * 7.2 * 10000) / 10000;
    }

    // 按 token 数粗略估算(假设 input:output = 1:1)
    const pricing = MODEL_PRICING[modelName] || DEFAULT_PRICING;
    const avgPricePer1K = (pricing.input + pricing.output) / 2;
    const cost = (totalTokens / 1000) * avgPricePer1K;
    return Math.round(cost * 10000) / 10000;
  }
}
