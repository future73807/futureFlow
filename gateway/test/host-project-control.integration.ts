import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { ApiKey } from '../src/database/entities/api-key.entity';
import { BalanceLog } from '../src/database/entities/balance-log.entity';
import { BatchTask } from '../src/database/entities/batch-task.entity';
import { DraftSandbox } from '../src/database/entities/draft-sandbox.entity';
import { DifyIntegration } from '../src/database/entities/dify-integration.entity';
import { FileUpload } from '../src/database/entities/file-upload.entity';
import {
  HostProjectControlRecord,
  HostProjectGate,
  HostProjectWorkRecord,
} from '../src/database/entities/host-project-gate.entity';
import { KnowledgeDatasetOwner } from '../src/database/entities/knowledge-dataset-owner.entity';
import { McpServer } from '../src/database/entities/mcp-server.entity';
import { MediaAsset } from '../src/database/entities/media-asset.entity';
import { MediaCredential } from '../src/database/entities/media-credential.entity';
import { MediaJob } from '../src/database/entities/media-job.entity';
import { PluginFavorite } from '../src/database/entities/plugin-favorite.entity';
import { User } from '../src/database/entities/user.entity';
import { Workflow } from '../src/database/entities/workflow.entity';
import { WorkflowRun } from '../src/database/entities/workflow-run.entity';
import { WorkflowTemplate } from '../src/database/entities/workflow-template.entity';
import { WorkflowTrigger } from '../src/database/entities/workflow-trigger.entity';
import { WorkflowVersion } from '../src/database/entities/workflow-version.entity';
import { ProjectControlService } from '../src/host/project-control.service';
import type { HostProjectBinding } from '../src/host/host.types';

const ENTITIES = [
  HostProjectGate,
  HostProjectControlRecord,
  HostProjectWorkRecord,
  User,
  ApiKey,
  BalanceLog,
  Workflow,
  WorkflowVersion,
  WorkflowRun,
  WorkflowTemplate,
  WorkflowTrigger,
  DifyIntegration,
  MediaCredential,
  MediaJob,
  MediaAsset,
  FileUpload,
  McpServer,
  DraftSandbox,
  KnowledgeDatasetOwner,
  BatchTask,
  PluginFavorite,
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForGateLock(dataSource: DataSource, applicationName: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiters = await dataSource.query(
      `SELECT query FROM pg_stat_activity
       WHERE application_name = $1 AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query ILIKE '%host_project_gates%'`,
      [applicationName],
    );
    if (waiters.length > 0) return;
    await pause(10);
  }
  assert.fail('quiesce did not wait on the locked host project gate');
}

async function main() {
  const databaseUrl = process.env.FLOW_TEST_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log(
      'host-project-control.integration: SKIP (FLOW_TEST_DATABASE_URL is not set)',
    );
    return;
  }

  const schema = `host_control_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `flow_control_${schema}`;
  const admin = new Client({ connectionString: databaseUrl });
  let dataSource: DataSource | undefined;
  let schemaCreated = false;

  try {
    await admin.connect();
    const databaseResult = await admin.query<{ current_database: string }>(
      'SELECT current_database()',
    );
    const databaseName = databaseResult.rows[0]?.current_database;
    if (databaseName !== 'task_work_test')
      throw new Error(
        'FLOW_TEST_DATABASE_URL must point to the temporary task_work_test database',
      );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('application_name', applicationName);
    dataSource = new DataSource({
      type: 'postgres',
      url: isolatedUrl.toString(),
      schema,
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      extra: { max: 10 },
    });
    await dataSource.initialize();

    const gates = dataSource.getRepository(HostProjectGate);
    const users = dataSource.getRepository(User);
    const workRecords = dataSource.getRepository(HostProjectWorkRecord);
    const controls = dataSource.getRepository(HostProjectControlRecord);
    const runs = dataSource.getRepository(WorkflowRun);
    const hostSubject = `host-${randomUUID()}`;
    const user = await users.save(
      users.create({
        username: `host-control-${randomUUID()}`,
        hostSubject,
        status: 'active',
      }),
    );
    const service = new ProjectControlService(gates, users);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const binding: HostProjectBinding = {
      version: 'v1',
      generation: 1,
      projectId,
      bindingToken: randomUUID(),
    };
    const otherBinding: HostProjectBinding = {
      ...binding,
      projectId: otherProjectId,
    };
    const snapshotInput = () => ({
      action: 'snapshot' as const,
      hostSubject,
      operationId: randomUUID(),
      expectedGeneration: 0,
    });
    await Promise.all([
      service.control(projectId, snapshotInput()),
      service.control(otherProjectId, snapshotInput()),
    ]);

    const otherUnit = await service.begin(user.id, otherBinding, randomUUID());
    let releaseWrite!: () => void;
    let writerEntered!: () => void;
    const holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const enteredWrite = new Promise<void>((resolve) => {
      writerEntered = resolve;
    });
    const lateWrite = service.write(user.id, binding, async () => {
      writerEntered();
      await holdWrite;
      return 'write finished';
    });
    await enteredWrite;

    const quiesceId = randomUUID();
    const quiesce = service.control(projectId, {
      action: 'quiesce',
      hostSubject,
      operationId: quiesceId,
      expectedGeneration: 1,
    });
    try {
      await waitForGateLock(dataSource, applicationName);
    } finally {
      releaseWrite();
    }
    assert.equal(await lateWrite, 'write finished');
    const stopped = await quiesce;
    assert.equal(stopped.generation, 2);
    assert.equal(stopped.draining, true);
    assert.equal(otherUnit.controller.signal.aborted, false);
    assert.ok(await workRecords.findOne({ where: { id: otherUnit.id } }));

    let lateBindingWriteRan = false;
    await assert.rejects(
      service.write(user.id, binding, async () => {
        lateBindingWriteRan = true;
      }),
      /项目作用域已失效/u,
    );
    assert.equal(lateBindingWriteRan, false);
    await otherUnit.finish();

    const activeProjectId = randomUUID();
    const activeBinding: HostProjectBinding = {
      ...binding,
      projectId: activeProjectId,
    };
    await service.control(activeProjectId, snapshotInput());
    const activeRunId = randomUUID();
    await runs.save(
      runs.create({
        userId: user.id,
        id: activeRunId,
        hostProjectId: activeProjectId,
        hostGeneration: 1,
        remoteStatus: 'outstanding',
        status: 'running',
        source: 'manual',
        difyWorkflowId: 'remote-workflow',
        difyTaskId: 'remote-task',
        totalTokens: 0,
        totalSteps: 0,
        estimatedCost: 0,
        actualCost: 0,
        elapsedTime: 0,
      }),
    );
    const activeUnit = await service.begin(user.id, activeBinding, activeRunId);
    let remoteStopCalls = 0;
    let remoteStopCalled!: () => void;
    const remoteStopObserved = new Promise<void>((resolve) => {
      remoteStopCalled = resolve;
    });
    activeUnit.remoteStop = async () => {
      remoteStopCalls++;
      remoteStopCalled();
      return false;
    };

    const activeOperationId = randomUUID();
    const activeAbort = new Promise<void>((resolve) =>
      activeUnit.controller.signal.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );
    const activeQuiesce = service.control(activeProjectId, {
      action: 'quiesce',
      hostSubject,
      operationId: activeOperationId,
      expectedGeneration: 1,
    });
    await Promise.race([
      activeAbort,
      activeQuiesce.then(() => {
        throw new Error('quiesce returned before the local work unit settled');
      }),
    ]);
    await remoteStopObserved;

    const restartedDuringQuiesce = new ProjectControlService(gates, users);
    const inFlight = await restartedDuringQuiesce.control(activeProjectId, {
      action: 'snapshot',
      hostSubject,
      operationId: randomUUID(),
      expectedGeneration: 0,
    });
    assert.equal(inFlight.operationId, activeOperationId);
    assert.equal(inFlight.localSettled, false);
    assert.equal(inFlight.quiesceSettled, false);

    await activeUnit.finish();
    const receipt = await activeQuiesce;
    assert.equal(receipt.localSettled, true);
    assert.equal(receipt.quiesceSettled, true);
    assert.equal(receipt.remoteStopped, 0);
    assert.equal(receipt.remoteOutstanding, 1);

    const stored = await controls.findOne({
      where: {
        hostSubject,
        projectId: activeProjectId,
        operationId: activeOperationId,
        action: 'quiesce',
      },
    });
    assert.deepEqual(stored?.receipt, receipt, 'JSONB receipt survives roundtrip');

    const restarted = new ProjectControlService(gates, users);
    const replayed = await restarted.control(activeProjectId, {
      action: 'quiesce',
      hostSubject,
      operationId: activeOperationId,
      expectedGeneration: 1,
    });
    assert.deepEqual(replayed, receipt);
    assert.equal(remoteStopCalls, 1, 'a persisted unknown stop is not replayed');

    await assert.rejects(restarted.control(activeProjectId, {
      action: 'complete-relink', hostSubject, operationId: activeOperationId, expectedGeneration: 2,
    }), /远端任务尚未确认结束/);
    assert.equal((await restarted.control(activeProjectId, {
      action: 'snapshot', hostSubject, operationId: activeOperationId, expectedGeneration: 2,
    })).draining, true);
    assert.equal(remoteStopCalls, 1, '拒绝完成不会重放停止操作');
    await runs.update({ id: activeRunId, userId: user.id }, { remoteStatus: 'stopped' });
    const completed = await restarted.control(activeProjectId, {
      action: 'complete-relink',
      hostSubject,
      operationId: activeOperationId,
      expectedGeneration: 2,
    });
    assert.equal(completed.draining, false);
    assert.equal(completed.generation, 2);

    await workRecords.save(
      workRecords.create({
        id: randomUUID(),
        hostSubject,
        projectId: activeProjectId,
        generation: 1,
        runId: randomUUID(),
      }),
    );
    const restartedWithOrphan = new ProjectControlService(gates, users);
    const afterRestart = await restartedWithOrphan.control(activeProjectId, {
      action: 'snapshot',
      hostSubject,
      operationId: randomUUID(),
      expectedGeneration: 0,
    });
    assert.equal(afterRestart.localSettled, false);

    console.log('host-project-control.integration: PASS');
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
