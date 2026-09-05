/**
 * 每日定时触发（daily schedule）专项冒烟测试。
 *
 * 直接验证 WorkflowTriggerService 的 nextRun 计算（interval / daily），
 * 以及 dailyTime 格式校验（通过 create 路径的拒绝分支）。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { WorkflowTrigger } from '../src/database/entities/workflow-trigger.entity';
import { WorkflowTriggerService } from '../src/triggers/workflow-trigger.service';

function makeService() {
  const rows: any[] = [];
  let seq = 0;
  const repo: any = {
    create(data: any) { return { id: '', ...data }; },
    async save(row: any) {
      row.id = row.id || `trigger-${++seq}`;
      const index = rows.findIndex((r) => r.id === row.id);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return row;
    },
    async find() { return rows; },
    async findOne(opts: any) { return rows.find((r) => r.id === opts.where.id) || null; },
    async count() { return 0; },
    async remove(row: any) {
      const index = rows.findIndex((r) => r.id === row.id);
      if (index >= 0) rows.splice(index, 1);
      return row;
    },
    createQueryBuilder: () => { throw new Error('not used in this smoke'); },
  };
  const emptyRepo: any = { createQueryBuilder: () => { throw new Error('not used'); } };
  const config = { get: () => '' } as unknown as ConfigService;
  return new WorkflowTriggerService(
    repo as unknown as Repository<WorkflowTrigger>,
    emptyRepo as unknown as Repository<any>,
    emptyRepo as unknown as Repository<any>,
    config,
  );
}

function publishedWorkflow() {
  return {
    id: 'wf-1',
    userId: 'user-1',
    publishedVersion: 1,
    status: 'active',
    publishedFlowgramJson: {
      nodes: [{
        id: 'start_1',
        type: 'start',
        data: { outputs: { type: 'object', properties: { query: { type: 'string' } } } },
      }],
      edges: [],
    },
  };
}

function harness(service: WorkflowTriggerService, workflow: any) {
  return {
    getOwnedPublishedWorkflow: async () => workflow,
    validateInputs: () => undefined,
  };
}

function withInternals(service: WorkflowTriggerService, workflow: any) {
  const harnessObject = harness(service, workflow);
  for (const [key, value] of Object.entries(harnessObject)) {
    (service as any)[key] = value;
  }
}

async function main() {
  const service = makeService();

  // create: daily 调度创建成功，nextRunAt 是未来最近的 HH:MM。
  withInternals(service, publishedWorkflow());
  const created = await service.create('user-1', 'wf-1', {
    name: '每日触发',
    type: 'schedule',
    scheduleType: 'daily',
    dailyTime: '09:00',
  } as any);
  assert.equal(created.trigger.scheduleType, 'daily');
  assert.equal(created.trigger.dailyTime, '09:00');
  assert.ok(created.trigger.nextRunAt, 'daily 触发器必须计算 nextRunAt');

  // nextRun 计算本身：09:00 已过 → 明天 09:00。
  const next = (service as any).nextRun({ type: 'daily', time: '09:00' }, new Date('2026-09-04T10:30:00'));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), new Date('2026-09-04T10:30:00').getDate() + 1);
  const sameDay = (service as any).nextRun({ type: 'daily', time: '09:00' }, new Date('2026-09-04T01:00:00'));
  assert.equal(sameDay.getDate(), new Date('2026-09-04T01:00:00').getDate(), '当天未到点应排当天');

  // create: 拒绝 daily 缺 dailyTime、拒绝 interval 与 dailyTime 混用。
  await assert.rejects(
    () => service.create('user-1', 'wf-1', { name: 'x', type: 'schedule', scheduleType: 'daily' } as any),
    (error: unknown) => error instanceof BadRequestException && /dailyTime/.test((error as Error).message),
  );
  await assert.rejects(
    () => service.create('user-1', 'wf-1', {
      name: 'x', type: 'schedule', scheduleType: 'daily', dailyTime: '09:00', intervalMinutes: 60,
    } as any),
    (error: unknown) => error instanceof BadRequestException && /不能同时设置/.test((error as Error).message),
  );

  // create: interval 调度保持原语义。
  const interval = await service.create('user-1', 'wf-1', {
    name: '间隔触发', type: 'schedule', scheduleType: 'interval', intervalMinutes: 60,
  } as any);
  assert.equal(interval.trigger.scheduleType, 'interval');
  assert.equal(interval.trigger.intervalMinutes, 60);

  console.log('trigger daily schedule smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
