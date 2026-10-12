import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostProjectGate, HostProjectControlRecord } from '../src/database/entities/host-project-gate.entity';
import { MediaJob } from '../src/database/entities/media-job.entity';
import { User } from '../src/database/entities/user.entity';
import { ProjectControlService } from '../src/host/project-control.service';
import type { HostProjectBinding } from '../src/host/host.types';
import { MediaJobService } from '../src/media/media-job.service';

function memoryStorage() {
  const tables = new Map<any, any[]>();
  const table = (entity: any) => {
    if (!tables.has(entity)) tables.set(entity, []);
    return tables.get(entity)!;
  };
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
    if (expected?._type === 'in' || expected?.type === 'in') return (expected._value ?? expected.value).includes(row[key]);
    return row[key] === expected;
  });
  const manager: any = {
    getRepository(entity: any) {
      const rows = table(entity);
      const keys = entity === HostProjectGate
        ? ['hostSubject', 'projectId']
        : entity === HostProjectControlRecord
          ? ['hostSubject', 'projectId', 'operationId', 'action']
          : ['id'];
      return {
        manager,
        create: (row: any) => ({ ...row }),
        find: async ({ where }: any) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
        findOne: async ({ where }: any) => {
          const row = rows.find((item) => matches(item, where));
          return row ? { ...row } : null;
        },
        findOneOrFail: async ({ where }: any) => {
          const row = rows.find((item) => matches(item, where));
          if (!row) throw new Error('fixture row missing');
          return { ...row };
        },
        count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
        save: async (input: any) => {
          const index = rows.findIndex((row) => keys.every((key) => row[key] === input[key]));
          if (index < 0) rows.push({ ...input }); else rows[index] = { ...rows[index], ...input };
          return { ...input };
        },
        update: async (where: any, values: any) => {
          let affected = 0;
          for (const row of rows) if (matches(row, where)) { Object.assign(row, values); affected++; }
          return { affected };
        },
        delete: async (where: any) => {
          for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], where)) rows.splice(index, 1);
        },
        createQueryBuilder: () => queryBuilder(entity),
      };
    },
    createQueryBuilder: () => queryBuilder(undefined),
    save: async (entityOrInput: any, input?: any) => {
      // ProjectControlService calls manager.save(gate); resolve that overload to
      // the Gate entity so the repository uses its real composite key.
      const entity = input === undefined ? HostProjectGate : entityOrInput;
      const row = input === undefined ? entityOrInput : input;
      return manager.getRepository(entity).save(row);
    },
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback(manager),
  };
  function queryBuilder(initial: any) {
    let entity = initial;
    let values: any;
    let params: any;
    let isUpdate = false;
    const builder: any = {
      insert: () => builder,
      into: (target: any) => { entity = target; return builder; },
      values: (input: any) => { values = input; return builder; },
      orIgnore: () => builder,
      update: (target?: any) => { entity = target ?? entity; isUpdate = true; return builder; },
      set: (input: any) => { values = input; return builder; },
      where: (_sql: string, input: any) => { params = input; return builder; },
      execute: async () => {
        const rows = table(entity);
        if (!isUpdate) {
          const keys = entity === HostProjectGate ? ['hostSubject', 'projectId'] : ['id'];
          if (!rows.some((row) => keys.every((key: string) => row[key] === values[key]))) rows.push({ ...values });
          return { affected: 1 };
        }
        let affected = 0;
        for (const row of rows) {
          const projectId = row.hostProjectId ?? row.hostProjectBinding?.projectId;
          if (row.userId === params.userId && projectId === params.projectId
            && (params.generation === undefined || row.hostGeneration < params.generation)
            && (!params.statuses || params.statuses.includes(row.status))) {
            Object.assign(row, values);
            affected++;
          }
        }
        return { affected };
      },
    };
    return builder;
  }
  return { manager, table };
}

function makeBinding(projectId: string): HostProjectBinding {
  return { version: 'v1', generation: 1, projectId, bindingToken: 'opaque' };
}

function makeJob(userId: string, binding: HostProjectBinding, id: string, providerTaskId: string) {
  return {
    id,
    userId,
    hostProjectId: binding.projectId,
    hostGeneration: binding.generation,
    hostProjectBinding: binding,
    remoteStatus: 'outstanding',
    credentialId: 'credential',
    provider: 'minimax',
    kind: 'video',
    idempotencyKey: id,
    requestHash: 'hash',
    model: 'video-model',
    executionRunId: null,
    executionWorkflowId: null,
    executionWorkflowVersion: null,
    status: 'processing',
    providerTaskId,
    assetId: null,
    errorCode: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function main() {
  const store = memoryStorage();
  const subject = `media-relink-${randomUUID()}`;
  const userId = randomUUID();
  const userRepo = store.manager.getRepository(User);
  await userRepo.save({ id: userId, hostSubject: subject, status: 'active' });
  const control = new ProjectControlService(
    store.manager.getRepository(HostProjectGate),
    userRepo,
  );
  const jobs = store.manager.getRepository(MediaJob);
  const failedProjectId = randomUUID();
  const unknownProjectId = randomUUID();
  const assetProjectId = randomUUID();
  const failedBinding = makeBinding(failedProjectId);
  const unknownBinding = makeBinding(unknownProjectId);
  const assetBinding = makeBinding(assetProjectId);
  const failedJobId = randomUUID();
  const unknownJobId = randomUUID();
  const assetJobId = randomUUID();
  await jobs.save(makeJob(userId, failedBinding, failedJobId, 'provider-failed'));
  await jobs.save(makeJob(userId, unknownBinding, unknownJobId, 'provider-unknown'));
  await jobs.save(makeJob(userId, assetBinding, assetJobId, 'provider-asset-already-persisted'));
  const assetsByJob = new Map<string, { id: string }>([[assetJobId, { id: 'persisted-asset' }]]);
  let providerPolls = 0;
  const media = (binding: HostProjectBinding) => new MediaJobService(
    jobs as never,
    { decryptOwned: async () => ({ provider: 'minimax', apiKey: 'fixture-key' }) } as never,
    { get: () => ({ getVideoStatus: async (_key: string, taskId: string) => {
      providerPolls++;
      if (taskId === 'provider-failed') return { taskId, status: 'failed' };
      throw new Error('temporary provider network error');
    } }) } as never,
    { findByJob: async (_userId: string, jobId: string) => assetsByJob.get(jobId) ?? null } as never,
    { binding: () => binding } as never,
    control,
  );
  const controlInput = <T extends 'snapshot' | 'quiesce' | 'complete-relink'>(action: T, operationId: string, expectedGeneration: number) => ({
    action, hostSubject: subject, operationId, expectedGeneration,
  });
  const failedOperation = randomUUID();
  const failedJob = await jobs.findOne({ where: { id: failedJobId } });
  assert.ok(failedJob);
  const failed = await media(failedBinding).getAndPoll(userId, failedJob.id);
  assert.equal(failed.status, 'failed');
  const failedQuiesce = await control.control(failedProjectId, controlInput('quiesce', failedOperation, 1));
  assert.equal(failedQuiesce.localSettled, true);
  assert.equal((await control.control(failedProjectId, controlInput('snapshot', randomUUID(), 2))).remoteOutstanding, 0,
    'provider terminal failure must release remoteOutstanding');
  const completed = await control.control(failedProjectId, controlInput('complete-relink', failedOperation, 2));
  assert.equal(completed.draining, false);

  const assetJob = await jobs.findOne({ where: { id: assetJobId } });
  assert.ok(assetJob);
  const pollsBeforeAssetReconcile = providerPolls;
  const recovered = await media(assetBinding).getAndPoll(userId, assetJob.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(providerPolls, pollsBeforeAssetReconcile, 'persisted asset recovery is terminal evidence and does not repoll provider');
  const assetOperation = randomUUID();
  await control.control(assetProjectId, controlInput('quiesce', assetOperation, 1));
  assert.equal((await control.control(assetProjectId, controlInput('snapshot', randomUUID(), 2))).remoteOutstanding, 0,
    'asset reconciliation must release remoteOutstanding');
  assert.equal((await control.control(assetProjectId, controlInput('complete-relink', assetOperation, 2))).draining, false);

  const unknownOperation = randomUUID();
  const unknownJob = await jobs.findOne({ where: { id: unknownJobId } });
  assert.ok(unknownJob);
  const unknown = await media(unknownBinding).getAndPoll(userId, unknownJob.id);
  assert.ok('pollError' in unknown, 'a transport error remains an unknown poll result');
  const unknownQuiesce = await control.control(unknownProjectId, controlInput('quiesce', unknownOperation, 1));
  assert.equal(unknownQuiesce.localSettled, true);
  const pollsBeforeRevokedRequest = providerPolls;
  await assert.rejects(media(unknownBinding).getAndPoll(userId, unknownJob.id), /作用域已失效/);
  assert.equal(providerPolls, pollsBeforeRevokedRequest, 'old generation cannot poll the provider after quiesce');
  assert.equal((await control.control(unknownProjectId, controlInput('snapshot', randomUUID(), 2))).remoteOutstanding, 1,
    'network uncertainty must keep the remote task outstanding');
  await assert.rejects(control.control(unknownProjectId, controlInput('complete-relink', unknownOperation, 2)), /远端任务尚未确认结束/);
  assert.equal((await control.control(unknownProjectId, controlInput('snapshot', randomUUID(), 2))).draining, true);
  console.log('media-remote-terminal-relink: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
