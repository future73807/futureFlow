import assert from 'node:assert/strict';

import { NotFoundException, type Logger } from '@nestjs/common';

import { WorkflowTriggerSchedulerService } from '../src/triggers/workflow-trigger-scheduler.service';

/**
 * 调度器重试接线的集成级回归（用桩服务，不需要数据库与 Dify）。
 *
 * 背景：`failureCount` 原先只写不读，偶发失败会让这次调度直接丢失、持续失败也无人
 * 知晓。这里守住调度器真正接上了「退避重试 + 失败升级」：偶发失败要能自愈、持续失败
 * 要有次数上限、不可重试的终态不能空转。
 */

interface Scenario {
  /**
   * 每次尝试的行为：
   *   ok        —— 成功
   *   fail      —— 抛异常
   *   softfail  —— 不抛异常，但工作流以 failed 状态正常结束（节点抛错被引擎捕获）
   *   gone      —— 触发器已删除/暂停（不可重试）
   */
  attempts: Array<'ok' | 'fail' | 'softfail' | 'gone'>;
}

function buildHarness(scenario: Scenario, config: Record<string, string> = {}) {
  const calls = { runOnce: 0, recorded: [] as Array<{ succeeded: boolean }> };
  const logs: Array<{ level: 'warn' | 'error'; message: string }> = [];
  let failureCount = 0;

  const triggers = {
    toRunnableById: async () => {
      const behavior = scenario.attempts[calls.runOnce] ?? 'fail';
      calls.runOnce += 1;
      if (behavior === 'gone') throw new NotFoundException('定时触发器不存在或已暂停');
      return {
        trigger: { staticInputs: {} },
        user: { id: 'u1' },
        workflow: { id: 'w1', publishedFlowgramJson: {}, publishedVersion: '1.0' },
      };
    },
    recordResult: async (_id: string, succeeded: boolean) => {
      calls.recorded.push({ succeeded });
      failureCount = succeeded ? 0 : failureCount + 1;
      return { id: 't1', name: '日报任务', failureCount };
    },
  };

  const workflows = {
    runWorkflow: async function* () {
      // 与 toRunnableById 同一轮尝试的结果保持一致
      const behavior = scenario.attempts[calls.runOnce - 1] ?? 'fail';
      if (behavior === 'fail') throw new Error('模型服务 503');
      if (behavior === 'softfail') {
        // 关键场景：不抛异常，工作流以 failed 状态结束（节点抛错被引擎捕获）
        yield { event: 'workflow_finished', data: { status: 'failed' } };
        return;
      }
      yield { event: 'workflow_finished', data: { status: 'succeeded' } };
    },
  };

  const configService = {
    get: (key: string, fallback?: string) => config[key] ?? fallback,
  };

  const scheduler = new WorkflowTriggerSchedulerService(
    triggers as any,
    workflows as any,
    configService as any,
  );

  // 只替换实例上的 logger，避免影响其他测试
  const logger = (scheduler as any).logger as Logger;
  logger.warn = (message: any) => { logs.push({ level: 'warn', message: String(message) }); };
  logger.error = (message: any) => { logs.push({ level: 'error', message: String(message) }); };
  logger.log = () => {};

  return { scheduler, calls, logs };
}

const FAST = { WORKFLOW_TRIGGER_RETRY_BASE_MS: '1' };

async function main() {
  // ── 1. 偶发失败：首次失败、重试成功 → 记为成功，不再告警 ──────────
  {
    const h = buildHarness({ attempts: ['fail', 'ok'] }, FAST);
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 2, '首次失败后应重试一次');
    assert.deepEqual(h.calls.recorded, [{ succeeded: true }], '重试成功应记为成功');
    assert.ok(
      h.logs.some((l) => l.level === 'warn' && /后重试/.test(l.message)),
      '应留下重试计划日志',
    );
    assert.ok(
      !h.logs.some((l) => /连续失败/.test(l.message)),
      '最终成功不应触发连续失败告警',
    );
  }

  // ── 2. 持续失败：尝试次数受上限约束，且记为失败 ──────────────────
  {
    const h = buildHarness(
      { attempts: ['fail', 'fail', 'fail'] },
      { ...FAST, WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '3' },
    );
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 3, '应尝试满 3 次后停止，不能无限重试');
    assert.deepEqual(h.calls.recorded, [{ succeeded: false }]);
    assert.ok(
      h.logs.some((l) => l.level === 'error' && /重试 3 次后仍失败/.test(l.message)),
      '耗尽重试后应留下明确的失败日志',
    );
  }

  // ── 3. 首次即成功：不应有任何重试 ───────────────────────────────
  {
    const h = buildHarness({ attempts: ['ok'] }, FAST);
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 1);
    assert.ok(!h.logs.some((l) => /后重试/.test(l.message)));
  }

  // ── 4. 触发器已被删除/暂停：不可重试，立即结束 ──────────────────
  {
    const h = buildHarness({ attempts: ['gone', 'ok'] }, FAST);
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 1, '不可重试的终态不应再尝试，否则只是空转');
    assert.deepEqual(h.calls.recorded, [{ succeeded: false }]);
    assert.ok(
      h.logs.some((l) => /不再重试/.test(l.message)),
      '应说明为何停止重试',
    );
  }

  // ── 5. 连续失败升级告警 ─────────────────────────────────────────
  // 该职责已下沉到 WorkflowTriggerService.recordResult（webhook 与定时两条链路
  // 的唯一收口），由 trigger-result-alert-smoke 直接测真实服务。这里改用桩服务，
  // 只断言调度器把「失败」如实回写，不再断言告警文案（否则测的是桩而非真实实现）。
  {
    const h = buildHarness({ attempts: ['fail', 'fail'] }, {
      ...FAST,
      WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '1',
    });
    await (h.scheduler as any).execute('t1');
    assert.deepEqual(h.calls.recorded, [{ succeeded: false }], '失败必须回写，供服务层判断是否告警');
  }

  // ── 6. 执行期间进入销毁：不再启动新的退避等待 ─────────────────────
  {
    const h = buildHarness(
      { attempts: ['fail', 'ok'] },
      { ...FAST, WORKFLOW_TRIGGER_RETRY_BASE_MS: '5000' },
    );
    (h.scheduler as any).stopping = true;
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 1, '销毁后不应再等待重试，避免拖住进程退出');
  }

  // ── 7. 「正常结束但状态 failed」也要有重试耗尽的汇总日志 ─────────
  // 这是真实环境实测发现的缺口：该场景不抛异常，早先的汇总日志以「有没有异常对象」
  // 为条件，于是日志里只有几次重试 WARN 就断了，无法判断最终是失败还是仍在进行中。
  {
    const h = buildHarness(
      { attempts: ['softfail', 'softfail', 'softfail'] },
      { ...FAST, WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS: '3' },
    );
    await (h.scheduler as any).execute('t1');
    assert.equal(h.calls.runOnce, 3, '软失败同样应重试到上限');
    assert.ok(
      h.logs.some((l) => l.level === 'error' && /重试 3 次后仍失败/.test(l.message)),
      `无异常时也必须给出重试耗尽汇总，实际日志: ${JSON.stringify(h.logs.map((l) => l.message))}`,
    );
    assert.deepEqual(h.calls.recorded, [{ succeeded: false }]);
  }

  console.log('trigger scheduler retry tests passed: 自愈 / 上限 / 首成功 / 不可重试 / 软失败汇总 / 失败回写 / 销毁中止');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
