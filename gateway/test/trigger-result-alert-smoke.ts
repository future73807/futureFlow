import assert from 'node:assert/strict';
import type { Logger } from '@nestjs/common';

import { WorkflowTriggerService } from '../src/triggers/workflow-trigger.service';

/**
 * `recordResult` 的连续失败告警回归。
 *
 * 背景：`failureCount` 原先只写不读——偶发失败会让这次调度直接丢失，持续失败更是
 * 无人知晓，触发器静默失败到永远。告警刻意放在 `recordResult` 里，因为它是定时调度
 * 与 webhook 两条执行链路的**唯一收口**；放在调用方就迟早会漏一条链路（webhook 当初
 * 就是这样漏掉的）。
 *
 * 这里直接驱动**真实服务**（只桩掉仓储与配置），所以断言的是真实实现，而不是测试自己
 * 搭的桩。
 */
function buildService(options: {
  trigger?: { id: string; name: string; type: string; failureCount: number } | null;
  alertThreshold?: string;
}) {
  const logs: Array<{ level: 'error' | 'warn'; message: string }> = [];
  const saved: any[] = [];

  const repo = {
    findOne: async () => (options.trigger === null ? null : { ...(options.trigger ?? {
      id: 't1',
      name: '日报任务',
      type: 'schedule',
      failureCount: 0,
    }) }),
    save: async (entity: any) => {
      saved.push({ ...entity });
      return entity;
    },
  };

  const config = {
    get: (key: string, fallback?: string) =>
      (key === 'WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD' ? options.alertThreshold : undefined) ?? fallback,
  };

  const service = new WorkflowTriggerService(
    repo as any,
    repo as any,
    repo as any,
    config as any,
  );

  const logger = (service as any).logger as Logger;
  logger.error = (message: any) => { logs.push({ level: 'error', message: String(message) }); };
  logger.warn = (message: any) => { logs.push({ level: 'warn', message: String(message) }); };

  return { service, logs, saved };
}

async function main() {
  // ── 未达阈值：不告警，但计数要累加 ──────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 1 },
      alertThreshold: '3',
    });
    const recorded = await h.service.recordResult('t1', false);
    assert.equal(recorded?.failureCount, 2, '失败应累加计数');
    assert.equal(h.logs.length, 0, '未达阈值不应告警');
  }

  // ── 达到阈值：error 级告警，含触发器名与次数 ────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 2 },
      alertThreshold: '3',
    });
    const recorded = await h.service.recordResult('t1', false);
    assert.equal(recorded?.failureCount, 3);
    assert.equal(h.logs.length, 1, '达到阈值应恰好告警一次');
    assert.equal(h.logs[0].level, 'error', '连续失败属于需要人工介入，应为 error 级');
    assert.match(h.logs[0].message, /连续失败 3 次/);
    assert.match(h.logs[0].message, /日报任务/, '告警必须能定位到具体触发器');
  }

  // ── 超过阈值：继续告警（否则「已经失败 50 次」反而安静下来）──────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 41 },
      alertThreshold: '3',
    });
    const recorded = await h.service.recordResult('t1', false);
    assert.equal(recorded?.failureCount, 42);
    assert.match(h.logs[0].message, /连续失败 42 次/);
  }

  // ── 成功：计数清零且不告警 ──────────────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 9 },
      alertThreshold: '3',
    });
    const recorded = await h.service.recordResult('t1', true);
    assert.equal(recorded?.failureCount, 0, '成功应把连续失败清零');
    assert.equal(h.logs.length, 0, '成功不应告警');
    assert.equal(h.saved[0].lastRunStatus, 'succeeded');
  }

  // ── webhook 类型同样告警（这正是当初漏掉的那条链路）─────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '入站回调', type: 'webhook', failureCount: 4 },
      alertThreshold: '3',
    });
    await h.service.recordResult('t1', false);
    assert.match(h.logs[0].message, /连续失败 5 次/);
    assert.match(h.logs[0].message, /类型=webhook/, '告警应能区分触发方式');
  }

  // ── 触发器已不存在：安静返回，不抛错 ────────────────────────────
  {
    const h = buildService({ trigger: null, alertThreshold: '3' });
    const recorded = await h.service.recordResult('gone', false);
    assert.equal(recorded, null, '触发器已被删除时不应抛错，避免污染调用方 finally');
    assert.equal(h.logs.length, 0);
  }

  console.log('trigger result alert tests passed: 计数累加 / 阈值告警 / 超阈值持续告警 / 成功清零 / webhook 覆盖 / 已删除安全返回');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
