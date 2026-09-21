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
  trigger?: {
    id: string;
    name: string;
    type: string;
    failureCount: number;
    status?: 'active' | 'paused';
  } | null;
  alertThreshold?: string;
  autoPauseFailures?: string;
}) {
  const logs: Array<{ level: 'error' | 'warn'; message: string }> = [];
  const saved: any[] = [];

  const repo = {
    findOne: async () => (options.trigger === null ? null : {
      status: 'active',
      ...(options.trigger ?? {
        id: 't1',
        name: '日报任务',
        type: 'schedule',
        failureCount: 0,
      }),
    }),
    save: async (entity: any) => {
      saved.push({ ...entity });
      return entity;
    },
  };

  const config = {
    get: (key: string, fallback?: string) => {
      if (key === 'WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD') return options.alertThreshold ?? fallback;
      if (key === 'WORKFLOW_TRIGGER_AUTO_PAUSE_FAILURES') return options.autoPauseFailures ?? fallback;
      return fallback;
    },
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
    await h.service.recordResult('t1', false);
    assert.equal(h.saved[0].failureCount, 2, '失败应累加计数并落库');
    assert.equal(h.logs.length, 0, '未达阈值不应告警');
  }

  // ── 达到阈值：error 级告警，含触发器名与次数 ────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 2 },
      alertThreshold: '3',
    });
    await h.service.recordResult('t1', false);
    assert.equal(h.saved[0].failureCount, 3, '计数应落库');
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
    await h.service.recordResult('t1', false);
    assert.equal(h.saved[0].failureCount, 42, '计数应落库');
    assert.match(h.logs[0].message, /连续失败 42 次/);
  }

  // ── 成功：计数清零且不告警 ──────────────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '日报任务', type: 'schedule', failureCount: 9 },
      alertThreshold: '3',
    });
    await h.service.recordResult('t1', true);
    assert.equal(h.saved[0].failureCount, 0, '成功应把连续失败清零并落库');
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
    await h.service.recordResult('gone', false);
    assert.equal(h.saved.length, 0, '触发器已被删除时不应抛错、也不应写入');
    assert.equal(h.logs.length, 0);
  }

  // ── 自动暂停：达到阈值就停，不再继续烧额度与并发名额 ───────────────
  // 一个「注定失败」的触发器会按周期永远跑下去。实测三个这样的触发器就吃满了
  // 默认 3 个并发名额，让完全不相干的工作流报 concurrency_limit。
  {
    const h = buildService({
      trigger: { id: 't1', name: '注定失败的任务', type: 'schedule', failureCount: 19 },
      autoPauseFailures: '20',
    });
    await h.service.recordResult('t1', false);
    const paused = h.saved[h.saved.length - 1];
    assert.equal(paused.status, 'paused', '达到阈值应自动暂停');
    assert.equal(paused.failureCount, 20, '暂停时计数应为阈值');
    assert.ok(
      h.logs.some((l) => l.level === 'error' && /自动暂停/.test(l.message)),
      '自动暂停应留下 error 级日志，否则没人知道触发器为什么停了',
    );
    assert.match(
      h.logs[h.logs.length - 1].message,
      /手动恢复/,
      '日志要告诉用户怎么恢复，否则只会看到「触发器不动了」',
    );
  }

  // ── 未达阈值：保持 active ────────────────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '偶发失败', type: 'schedule', failureCount: 3 },
      autoPauseFailures: '20',
    });
    await h.service.recordResult('t1', false);
    assert.equal(h.saved[h.saved.length - 1].status, 'active', '未达阈值不应暂停');
  }

  // ── 阈值 0 = 关闭自动暂停（有的部署就是要一直重试）─────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '永不放弃', type: 'schedule', failureCount: 999 },
      autoPauseFailures: '0',
    });
    await h.service.recordResult('t1', false);
    assert.equal(h.saved[h.saved.length - 1].status, 'active', '阈值 0 表示不自动暂停');
  }

  // ── 已暂停的不再重复写库 ─────────────────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '已停', type: 'schedule', failureCount: 50, status: 'paused' },
      autoPauseFailures: '20',
    });
    await h.service.recordResult('t1', false);
    assert.equal(
      h.saved.filter((row) => row.status === 'paused').length,
      1,
      '已暂停的触发器不应反复落库',
    );
  }

  // ── 成功时不会误暂停 ─────────────────────────────────────────────
  {
    const h = buildService({
      trigger: { id: 't1', name: '恢复', type: 'schedule', failureCount: 19 },
      autoPauseFailures: '20',
    });
    await h.service.recordResult('t1', true);
    assert.equal(h.saved[h.saved.length - 1].status, 'active', '成功不应触发暂停');
    assert.equal(h.saved[h.saved.length - 1].failureCount, 0, '成功应清零计数');
  }

  console.log('trigger result alert tests passed: 计数累加 / 阈值告警 / 超阈值持续告警 / 成功清零 / webhook 覆盖 / 已删除安全返回 / 自动暂停达阈值 / 未达阈值不暂停 / 阈值0关闭 / 已暂停不重复写 / 成功不误暂停');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
