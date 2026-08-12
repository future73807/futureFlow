import assert from 'node:assert/strict';

import { WorkflowExecutionGuardService } from '../src/workflows/services/workflow-execution-guard.service';

const admission = {
  id: 'run-1',
  userId: 'user-1',
  workflowId: 'workflow-1',
  flowgramJson: { nodes: [], edges: [] },
  estimatedCost: 0,
};

function createGuard(lockError?: Error & { data?: { hint?: string } }) {
  let lockedReads = 0;
  let unlockedReads = 0;
  let countCalls = 0;
  let saveCalls = 0;
  const manager = {
    async findOne(_entity: unknown, options: { lock?: unknown }) {
      if (options.lock) {
        lockedReads += 1;
        if (lockError) throw lockError;
      } else {
        unlockedReads += 1;
      }
      return { id: admission.userId };
    },
    async count() {
      countCalls += 1;
      return 0;
    },
    create(_entity: unknown, value: unknown) {
      return value;
    },
    async save(_entity: unknown, value: unknown) {
      saveCalls += 1;
      return value;
    },
  };
  const guard = new WorkflowExecutionGuardService(
    {} as any,
    { transaction: async (callback: (entityManager: typeof manager) => unknown) => callback(manager) } as any,
    { get: (_key: string, fallback: string) => fallback } as any,
  );

  return {
    guard,
    calls: () => ({ lockedReads, unlockedReads, countCalls, saveCalls }),
  };
}

function pgMemLockError() {
  const error = new Error('🔨 Not supported 🔨: SELECT ... FOR UPDATE row locking') as Error & {
    data?: { hint?: string };
  };
  error.data = { hint: 'pg-mem cannot implement row locks in its in-memory test adapter' };
  return error;
}

async function testPgMemLockFallback() {
  const { guard, calls } = createGuard(pgMemLockError());

  await guard.reserve(admission);

  assert.deepEqual(calls(), {
    lockedReads: 1,
    unlockedReads: 1,
    countCalls: 2,
    saveCalls: 1,
  });
}

async function testProductionLockErrorsFailClosed() {
  const errors = [
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    Object.assign(new Error('connection to server lost'), { code: '08006' }),
    Object.assign(new Error('permission denied for relation users'), { code: '42501' }),
  ];

  for (const lockError of errors) {
    const { guard, calls } = createGuard(lockError);
    await assert.rejects(
      () => guard.reserve(admission),
      (received) => received === lockError,
      `lock error ${lockError.code} must be propagated`,
    );
    assert.deepEqual(calls(), {
      lockedReads: 1,
      unlockedReads: 0,
      countCalls: 0,
      saveCalls: 0,
    });
  }
}

async function main() {
  await testPgMemLockFallback();
  await testProductionLockErrorsFailClosed();
  console.log('workflow execution guard lock fallback tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
