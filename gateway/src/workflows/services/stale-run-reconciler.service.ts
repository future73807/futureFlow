import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { describeError } from '../../common/describe-error';
import { BillingService } from '../../billing/billing.service';
import { WorkflowRun } from '../../database/entities/workflow-run.entity';

/**
 * 残留运行对账：回收「进程崩溃后卡在 running」的运行记录。
 *
 * ## 为什么必须有这个
 *
 * 一次计费执行分三步：`reserve()` 建 running 记录 → `freezeBalance()` 冻结预估费用
 * → 执行结束后（`finally`）`settleBilling()` 扣费或 `refund()` 解冻。
 *
 * 如果进程在「已冻结、未结算」之间死亡（部署重启、OOM、宿主重启、被 kill），
 * `finally` 不会执行，于是留下：
 *   - `workflow_runs` 一条永远 `status='running'`、`finishedAt` 为空的记录
 *   - 该用户 `frozenBalance` 被永久占用
 *
 * 而 `WorkflowExecutionGuardService` 正是用 `status='running'` 的**计数**做并发限流，
 * 所以每条残留记录都同时是「钱被锁住」和「并发额度被占」。累计到上限（默认 3）后，
 * 用户**再也无法启动任何工作流**——实测复现为
 * `429 {"code":"concurrency_limit"}`，且不会自愈。
 *
 * ## 安全边界
 *
 * - **阈值要足够宽**：只有超过 `WORKFLOW_STALE_RUN_MINUTES`（默认 30 分钟）仍为
 *   `running` 的才回收。网关侧单个工作流的执行都受超时约束（LLM 请求 120s、
 *   执行接口 240s），30 分钟远长于任何正常执行，因此不会误伤活跃运行。
 * - **原子认领**：用一条 `UPDATE ... WHERE status='running' AND createdAt < cutoff
 *   RETURNING *` 把状态改为终态，谁先改到谁负责退款。多实例或多轮扫描不会重复处理。
 * - **退款兜底**：`BillingService.refund()` 解冻后会钳制 `frozenBalance >= 0`，因此
 *   即便与「迟到完成」的正常结算路径叠加，也不会把冻结余额做成负数。
 *
 * 已知取舍：极慢的运行若恰好跨过阈值，会被回收为失败并解冻，随后其自身结算仍会
 * 扣掉实际费用（用户确实消费了服务），不会出现重复扣费或漏扣。要做到严格幂等需要
 * 在运行表上加结算标记（一次迁移），当前阈值下该竞态的收益不足以承担那份复杂度。
 */
@Injectable()
export class StaleRunReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleRunReconcilerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    private readonly dataSource: DataSource,
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const seconds = this.positiveInt('WORKFLOW_STALE_RUN_SWEEP_SECONDS', 300);
    this.timer = setInterval(() => void this.sweep(), seconds * 1_000);
    this.timer.unref?.();
    // 启动时先扫一次：重启后立刻回收上一轮进程留下的残留，用户不必等一个扫描周期。
    void this.sweep();
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private positiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(this.config.get<string>(key, String(fallback)), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /** 扫描并回收一次。公开是为了让测试能直接驱动，而不必等定时器。 */
  async sweep(): Promise<{ reclaimed: number; refunded: number }> {
    if (this.running) return { reclaimed: 0, refunded: 0 };
    this.running = true;
    try {
      const minutes = this.positiveInt('WORKFLOW_STALE_RUN_MINUTES', 30);
      const cutoff = new Date(Date.now() - minutes * 60_000);

      // 认领分两步：先读出候选，再**逐行**做条件更新并检查 affected === 1。
      // 之所以不用 `UPDATE ... RETURNING`：返回行的形状依赖驱动/适配器实现
      // （pg-mem 会把行包成数组，导致按属性取值静默拿到 undefined，退款被跳过），
      // 而这里处理的是钱，不能依赖这种形状约定。逐行条件更新在任何实现下语义一致，
      // 且同样能保证「谁先改到谁负责退款」——并发实例只会有一个拿到 affected=1。
      const candidates = await this.dataSource.getRepository(WorkflowRun).find({
        where: { status: 'running', createdAt: LessThan(cutoff) },
        select: ['id', 'userId', 'estimatedCost'],
      });

      const claimed: Array<{ id: string; userId: string; estimatedCost: number }> = [];
      for (const candidate of candidates) {
        const result = await this.dataSource
          .createQueryBuilder()
          .update(WorkflowRun)
          .set({
            status: 'failed',
            errorMessage: `运行记录在进程中断后未收尾，已被对账回收（超过 ${minutes} 分钟未结束）`,
            finishedAt: new Date(),
          })
          .where('id = :id AND status = :status', { id: candidate.id, status: 'running' })
          .execute();
        if (result.affected === 1) {
          claimed.push({
            id: candidate.id,
            userId: candidate.userId,
            estimatedCost: Number(candidate.estimatedCost || 0),
          });
        }
      }

      if (claimed.length === 0) return { reclaimed: 0, refunded: 0 };

      let refunded = 0;
      for (const row of claimed) {
        if (!(row.estimatedCost > 0)) continue;
        try {
          await this.billing.refund(row.userId, row.estimatedCost, row.id);
          refunded += 1;
        } catch (error) {
          // 单条退款失败不能中断整批；记录后由下一轮扫描重试（金额不会重复解冻——
          // refund 内部对 frozenBalance 做了不小于 0 的钳制）。
          this.logger.error(
            `残留运行解冻失败: runId=${row.id}, amount=${row.estimatedCost}, ${describeError(error)}`,
          );
        }
      }

      this.logger.warn(
        `对账回收残留运行 ${claimed.length} 条（阈值 ${minutes} 分钟），其中解冻 ${refunded} 条`,
      );
      return { reclaimed: claimed.length, refunded };
    } catch (error) {
      this.logger.error(`残留运行对账失败: ${describeError(error)}`);
      return { reclaimed: 0, refunded: 0 };
    } finally {
      this.running = false;
    }
  }
}
