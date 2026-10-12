import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostProjectGate, HostProjectControlRecord, HostProjectWorkRecord } from '../src/database/entities/host-project-gate.entity';
import { WorkflowRun } from '../src/database/entities/workflow-run.entity';
import { MediaJob } from '../src/database/entities/media-job.entity';
import { User } from '../src/database/entities/user.entity';
import { ProjectControlService } from '../src/host/project-control.service';
import { HostProjectControlGuard } from '../src/host/project-control.controller';
import { DifyClientService } from '../src/dify/dify-client.service';
import type { HostProjectBinding } from '../src/host/host.types';
import { readHostConfig } from '../src/host/host.config';

/** 本用例用串行事务仓储核真实service状态机，不用DBstatus替代unit.settled。 */
function storage() {
  const tables = new Map<any, any[]>();
  let tail = Promise.resolve();
  const table = (entity: any) => { if (!tables.has(entity)) tables.set(entity, []); return tables.get(entity)!; };
  const match = (row: any, where: any) => Object.entries(where || {}).every(([key, value]: [string, any]) => value?._type === 'in' ? value._value.includes(row[key]) : row[key] === value);
  const manager: any = {
    save: async (input: any) => manager.getRepository(HostProjectGate).save(input),
    getRepository: (entity: any) => {
      const rows = table(entity);
      return { manager, create: (input: any) => ({ ...input }),
        find: async ({ where }: any) => rows.filter((row) => match(row, where)).map((row) => ({ ...row })),
        findOne: async ({ where }: any) => { const row = rows.find((item) => match(item, where)); return row ? { ...row } : null; },
        findOneOrFail: async ({ where }: any) => { const row = rows.find((item) => match(item, where)); if (!row) throw new Error('missing'); return { ...row }; },
        count: async ({ where }: any) => rows.filter((row) => match(row, where)).length,
        save: async (input: any) => {
          const keys = entity === HostProjectGate ? ['hostSubject', 'projectId'] : entity === HostProjectControlRecord ? ['hostSubject', 'projectId', 'operationId', 'action'] : ['id'];
          const existing = rows.findIndex((row) => keys.every((key) => row[key] === input[key]));
          if (existing >= 0) rows[existing] = { ...input }; else rows.push({ ...input });
          return { ...input };
        },
        update: async (where: any, input: any) => { let affected = 0; for (const row of rows) if (match(row, typeof where === 'string' ? { id: where } : where)) { Object.assign(row, input); affected++; } return { affected }; },
        delete: async (where: any) => { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1); },
        createQueryBuilder: () => builder(entity),
      };
    },
    createQueryBuilder: () => builder(),
    transaction: async (work: any) => { const previous = tail; let release!: () => void; tail = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(manager); } finally { release(); } },
  };
  function builder(initial?: any) {
    let entity = initial; let values: any; let update = false; let params: any;
    const api: any = { insert: () => api, into: (target: any) => { entity = target; return api; },
      values: (input: any) => { values = input; return api; }, orIgnore: () => api,
      update: (target?: any) => { entity = target ?? entity; update = true; return api; },
      set: (input: any) => { values = input; return api; }, where: (_sql: string, input: any) => { params = input; return api; },
      execute: async () => {
        const rows = table(entity);
        if (!update) { if (!rows.some((row) => row.hostSubject === values.hostSubject && row.projectId === values.projectId)) rows.push({ ...values }); return {}; }
        let affected = 0;
        for (const row of rows) {
          const projectId = row.hostProjectId ?? row.hostProjectBinding?.projectId;
          if (row.userId === params.userId && projectId === params.projectId
            && (params.generation === undefined || row.hostGeneration < params.generation)
            && (!params.statuses || params.statuses.includes(row.status))) { Object.assign(row, values); affected++; }
        }
        return { affected };
      },
    }; return api;
  }
  return { manager, table };
}

async function main() {
  const store = storage(); const subject = randomUUID(); const userId = randomUUID(); const otherId = randomUUID();
  const control = new ProjectControlService(store.manager.getRepository(HostProjectGate), store.manager.getRepository(User));
  const binding: HostProjectBinding = { version: 'v1', generation: 1, projectId: randomUUID(), bindingToken: 'opaque' };
  const other: HostProjectBinding = { ...binding, projectId: otherId };
  const op = randomUUID();
  const snapshot = () => control.control(binding.projectId, { action: 'snapshot', hostSubject: subject, operationId: op, expectedGeneration: 0 });
  const first = await snapshot();
  assert.equal(first.generation, 1);
  assert.equal(first.localSettled, true);
  assert.deepEqual(first.activeRunIds, []);
  assert.equal(first.remoteOutstanding, 0);
  await assert.rejects(control.control(binding.projectId, { action: 'quiesce', hostSubject: subject, operationId: op, expectedGeneration: 1 }), /宿主实例未连接/);
  await assert.rejects(control.control(binding.projectId, { action: 'complete-relink', hostSubject: subject, operationId: op, expectedGeneration: 1 }), /宿主实例未连接/);
  // 没有User也必须看真实登记，不把首次初始化分支当成虚假的空运行证明。
  const orphanId = randomUUID();
  await store.manager.getRepository(HostProjectWorkRecord).save({ id: orphanId, hostSubject: subject, projectId: binding.projectId, generation: 1, runId: randomUUID() });
  assert.equal((await snapshot()).localSettled, false);
  await store.manager.getRepository(HostProjectWorkRecord).delete({ id: orphanId });
  await store.manager.getRepository(User).save({ id: userId, hostSubject: subject, status: 'active' });
  const unit = await control.begin(userId, binding, randomUUID());
  const untouched = await control.begin(userId, other, randomUUID());
  let remoteStops = 0; unit.remoteStop = async () => { remoteStops++; return false; };
  await store.manager.getRepository(MediaJob).save({ id: randomUUID(), userId, hostProjectId: binding.projectId, hostGeneration: 1, remoteStatus: 'outstanding', status: 'processing' });
  const pending = control.control(binding.projectId, { action: 'quiesce', hostSubject: subject, operationId: op, expectedGeneration: 1 });
  // 等待真实cancel信号，未finish前不能声称localSettled。
  await new Promise<void>((resolve) => unit.controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  assert.equal(untouched.controller.signal.aborted, false);
  const inFlight = await snapshot(); assert.equal(inFlight.generation, 2); assert.equal(inFlight.localSettled, false); assert.equal(inFlight.quiesceSettled, false);
  await assert.rejects(control.begin(userId, binding), /作用域已失效/);
  await unit.finish();
  const receipt = await pending;
  assert.equal(receipt.localSettled, true); assert.equal(receipt.quiesceSettled, true);
  assert.equal(receipt.remoteStopped, 0); assert.equal(receipt.remoteOutstanding, 1);
  assert.deepEqual(await control.control(binding.projectId, { action: 'quiesce', hostSubject: subject, operationId: op, expectedGeneration: 1 }), receipt);
  assert.equal(remoteStops, 1, '幂等回放不再次停止远端');
  const after = await snapshot(); assert.equal(after.quiesceSettled, true); assert.equal(after.operationId, op);
  await assert.rejects(control.control(binding.projectId, { action: 'complete-relink', hostSubject: subject, operationId: op, expectedGeneration: 2 }), /远端任务尚未确认结束/);
  assert.equal((await snapshot()).draining, true);
  assert.equal(remoteStops, 1);
  await store.manager.getRepository(MediaJob).update({ userId, hostProjectId: binding.projectId }, { remoteStatus: 'stopped' });
  const completed = await control.control(binding.projectId, { action: 'complete-relink', hostSubject: subject, operationId: op, expectedGeneration: 2 });
  assert.equal(completed.draining, false); assert.equal(completed.generation, 2);
  await assert.rejects(control.begin(userId, binding), /作用域已失效/);
  const fresh = await control.begin(userId, { ...binding, generation: 2 }); await fresh.finish(); await untouched.finish();
  // 重启/其他进程未释放登记不能根据DBstatus假造停稳。
  await store.manager.getRepository(HostProjectWorkRecord).save({ id: randomUUID(), hostSubject: subject, projectId: binding.projectId, generation: 1, runId: randomUUID() });
  assert.equal((await snapshot()).localSettled, false);

  const config = readHostConfig({ get: <T>(key: string) => ({ HOST_MODE: 'embedded', HOST_SHARED_SECRET: 'control-shared-secret', HOST_IDENTITY_VERIFY_URL: 'http://127.0.0.1/identity' }[key] as T) });
  const guard = new HostProjectControlGuard(config);
  assert.throws(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as any));
  assert.equal(guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer control-shared-secret', 'x-ff-embed-protocol': 'v1' } }) }) } as any), true);

  const originalFetch = globalThis.fetch; const requests: { url: string; options: RequestInit }[] = [];
  try {
    globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options: options! }); return new Response(JSON.stringify(requests.length === 1 ? { result: 'success' } : { id: 'run-exact', status: 'running' }), { status: 200 }); };
    const dify = new DifyClientService({} as any, {} as any);
    const stop = await dify.prepareStop('task-exact', 'run-exact', 'user-exact', {}, { apiBase: 'https://engine.example/v1', apiKey: 'memory-only' });
    assert.equal(await stop(), false, 'success请求回执不等于远端停稳');
    assert.equal(requests.length, 2); assert.equal(requests[0].url, 'https://engine.example/v1/workflows/tasks/task-exact/stop');
    assert.equal(requests[1].url, 'https://engine.example/v1/workflows/run/run-exact');
    assert.equal(requests[0].options.body, '{"user":"user-exact"}');
  } finally { globalThis.fetch = originalFetch; }
  console.log('host-project-control-smoke: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
