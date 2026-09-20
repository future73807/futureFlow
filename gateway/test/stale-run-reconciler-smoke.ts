import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { DataType, newDb } from 'pg-mem';
import type { ConfigService } from '@nestjs/config';
import type { Logger } from '@nestjs/common';

import { BillingService } from '../src/billing/billing.service';
import { StaleRunReconcilerService } from '../src/workflows/services/stale-run-reconciler.service';
import { WorkflowRun } from '../src/database/entities/workflow-run.entity';
import { BalanceLog } from '../src/database/entities/balance-log.entity';
import { User } from '../src/database/entities/user.entity';

/**
 * 残留运行对账回归。
 *
 * 背景（已在真实环境复现）：进程在「已冻结、未结算」之间死亡会留下永远
 * `status='running'` 的记录；`WorkflowExecutionGuardService` 用 running 计数做并发
 * 限流，因此每条残留记录同时占用**冻结余额**与**并发额度**，累计到上限（默认 3）后
 * 用户再也无法启动工作流，且不会自愈。实测响应为
 * `429 {"code":"concurrency_limit"}`。
 *
 * 用 pg-mem 建真实 schema、跑真实 SQL 认领语句与真实 BillingService，验证：
 *   - 超阈值的残留被回收为终态，其冻结金额被释放
 *   - 未超阈值的活跃运行**不被误伤**（最关键的安全边界）
 *   - 重复扫描不会重复退款、不动历史终态记录
 *   - estimatedCost 为 0 的残留同样要回收状态（它仍占并发额度）
 */
async function main() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'futureflow_test',
  });
  database.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'PostgreSQL 16 test',
  });
  // 实体主键用了 uuid_generate_v4()（见 platform.integration 的同名注册）
  database.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });

  const dataSource = database.adapters.createTypeormDataSource({
    type: 'postgres',
    entities: [User, WorkflowRun, BalanceLog],
    synchronize: true,
  });
  await dataSource.initialize();

  const config = {
    get: (key: string, fallback?: string) => {
      if (key === 'WORKFLOW_STALE_RUN_MINUTES') return '30';
      if (key === 'WORKFLOW_STALE_RUN_SWEEP_SECONDS') return '300';
      return fallback;
    },
  } as unknown as ConfigService;

  const billing = new BillingService(
    dataSource.getRepository(User),
    dataSource.getRepository(BalanceLog),
    dataSource,
  );
  const reconciler = new StaleRunReconcilerService(
    dataSource.getRepository(WorkflowRun),
    dataSource,
    billing,
    config,
  );
  // 静音日志，避免污染测试输出（含 BillingService 的退款日志）
  const logger = (reconciler as any).logger as Logger;
  logger.warn = () => {};
  logger.error = () => {};
  logger.log = () => {};
  (billing as any).logger.log = () => {};
  (billing as any).logger.error = () => {};

  const stamp = Date.now();
  let seq = 0;

  const makeUser = async (balance: number, frozen: number) => {
    return dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        username: `stale-test-${stamp}-${seq}`,
        email: `stale-${stamp}-${seq++}@example.test`,
        passwordHash: 'x'.repeat(32),
        role: 'user',
        balance,
        frozenBalance: frozen,
      }),
    );
  };

  const makeRun = async (
    userId: string,
    status: string,
    estimatedCost: number,
    minutesAgo: number,
  ) => {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    const saved = await dataSource.getRepository(WorkflowRun).save(
      dataSource.getRepository(WorkflowRun).create({
        userId,
        status,
        estimatedCost,
        flowgramJson: { nodes: [], edges: [] },
      }),
    );
    // createdAt 是 CreateDateColumn，需用原生 SQL 覆写才能模拟「很久以前」
    await dataSource.query(
      'UPDATE workflow_runs SET "createdAt" = $1 WHERE id = $2',
      [createdAt, saved.id],
    );
    return saved.id;
  };

  const runStatus = async (id: string) => {
    const row = await dataSource.getRepository(WorkflowRun).findOne({ where: { id } });
    return row?.status;
  };
  const frozenOf = async (userId: string) => {
    const row = await dataSource.getRepository(User).findOne({ where: { id: userId } });
    return Number(row?.frozenBalance);
  };

  // ── 场景 1：超阈值的残留被回收，且冻结金额释放 ──────────────────
  {
    const user = await makeUser(100, 5);
    const runId = await makeRun(user.id, 'running', 5, 60);

    const result = await reconciler.sweep();
    assert.ok(result.reclaimed >= 1, `应回收至少 1 条，实际 ${result.reclaimed}`);
    assert.ok(result.refunded >= 1, `应解冻至少 1 条，实际 ${result.refunded}`);

    assert.equal(await runStatus(runId), 'failed', '残留运行应被置为终态 failed');
    const row = await dataSource.getRepository(WorkflowRun).findOne({ where: { id: runId } });
    assert.ok(row?.finishedAt, '应写入 finishedAt');
    assert.match(String(row?.errorMessage), /对账回收/, '应说明回收原因');
    assert.equal(await frozenOf(user.id), 0, '冻结金额应被释放');
  }

  // ── 场景 2：未超阈值的活跃运行**不得**被误伤（最关键）───────────
  {
    const user = await makeUser(100, 3);
    const runId = await makeRun(user.id, 'running', 3, 1); // 1 分钟前，远未超阈值

    await reconciler.sweep();

    assert.equal(
      await runStatus(runId),
      'running',
      '活跃运行不能被误回收（否则会打断正在执行的工作流）',
    );
    assert.equal(await frozenOf(user.id), 3, '活跃运行的冻结金额必须保留');
  }

  // ── 场景 3：重复扫描不会重复退款 ────────────────────────────────
  {
    const user = await makeUser(100, 4);
    await makeRun(user.id, 'running', 4, 90);

    const first = await reconciler.sweep();
    assert.ok(first.reclaimed >= 1, '首次应回收到该记录');
    const second = await reconciler.sweep();
    assert.equal(await frozenOf(user.id), 0, '重复扫描不应把冻结余额做成负数');
    assert.ok(second.reclaimed <= first.reclaimed, '第二轮认领数不应超过第一轮');
  }

  // ── 场景 4：已终态的历史记录不受影响 ────────────────────────────
  {
    const user = await makeUser(100, 0);
    const okRun = await makeRun(user.id, 'succeeded', 2, 120);
    await reconciler.sweep();
    assert.equal(await runStatus(okRun), 'succeeded', '已成功的历史记录不应被改动');
  }

  // ── 场景 5：estimatedCost 为 0 的残留也要回收状态（它仍占并发额度）──
  {
    const user = await makeUser(100, 0);
    const runId = await makeRun(user.id, 'running', 0, 60);
    await reconciler.sweep();
    assert.equal(
      await runStatus(runId),
      'failed',
      '无金额的残留同样要回收，否则并发额度一直被占',
    );
  }

  await dataSource.destroy();
  console.log(
    'stale run reconciler tests passed: 回收终态 / 释放冻结 / 不误伤活跃 / 不重复退款 / 不动历史 / 零金额也回收',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
