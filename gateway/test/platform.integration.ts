import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataType, newDb } from 'pg-mem';
import request from 'supertest';

import { AdminModule } from '../src/admin/admin.module';
import { AuthModule } from '../src/auth/auth.module';
import { BillingModule } from '../src/billing/billing.module';
import { ConverterModule } from '../src/converter/converter.module';
import { BalanceLog } from '../src/database/entities/balance-log.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { User } from '../src/database/entities/user.entity';
import { WorkflowRun } from '../src/database/entities/workflow-run.entity';
import { Workflow } from '../src/database/entities/workflow.entity';
import { WorkflowVersion } from '../src/database/entities/workflow-version.entity';
import { WorkflowTemplate } from '../src/database/entities/workflow-template.entity';
import { WorkflowTrigger } from '../src/database/entities/workflow-trigger.entity';
import { DifyIntegration } from '../src/database/entities/dify-integration.entity';
import { DatabaseModule } from '../src/database/database.module';
import { DifyModule } from '../src/dify/dify.module';
import { DirectLlmService } from '../src/workflows/direct-llm.service';
import { WorkflowsModule } from '../src/workflows/workflows.module';
import { WorkflowTemplateModule } from '../src/templates/workflow-template.module';
import { WorkflowTriggerModule } from '../src/triggers/workflow-trigger.module';

const entities = [
  User,
  ApiKey,
  Workflow,
  WorkflowVersion,
  WorkflowRun,
  BalanceLog,
  WorkflowTemplate,
  WorkflowTrigger,
  DifyIntegration,
];

async function createTestApp() {
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
  database.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });

  const dataSource = database.adapters.createTypeormDataSource({
    type: 'postgres',
    entities,
    synchronize: true,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({
          GATEWAY_JWT_SECRET: 'integration-test-secret',
          DIFY_API_KEY: '',
          LLM_API_KEY: 'integration-test-key',
          LLM_DEFAULT_MODEL: 'deepseek-chat',
        })],
      }),
      TypeOrmModule.forRootAsync({
        useFactory: () => ({ type: 'postgres', entities, synchronize: true }),
        dataSourceFactory: async () => dataSource.initialize(),
      }),
      JwtModule.registerAsync({
        global: true,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          secret: config.get<string>('GATEWAY_JWT_SECRET'),
          signOptions: { expiresIn: '1h' },
        }),
      }),
      DatabaseModule,
      AuthModule,
      BillingModule,
      ConverterModule,
      DifyModule,
      WorkflowsModule,
      WorkflowTemplateModule,
      WorkflowTriggerModule,
      AdminModule,
    ],
  })
    .overrideProvider(DirectLlmService)
    .useValue({
      async *runDirect() {
        yield {
          event: 'workflow_started',
          task_id: 'integration-task',
          workflow_run_id: 'integration-run',
          data: { id: 'integration-run' },
        };
        yield {
          event: 'text_chunk',
          task_id: 'integration-task',
          data: { text: 'integration response' },
        };
        yield {
          event: 'workflow_finished',
          task_id: 'integration-task',
          workflow_run_id: 'integration-run',
          data: {
            status: 'succeeded',
            total_tokens: 120,
            total_steps: 3,
            elapsed_time: 0.1,
            outputs: { result: 'integration response' },
          },
        };
      },
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

async function main() {
  const app = await createTestApp();
  const server = app.getHttpServer();

  try {
    const loginResponse = await request(server)
      .post('/auth/login')
      .send({ account: 'demo', password: 'demo123456' })
      .expect(201);
    const adminToken = loginResponse.body.accessToken;
    assert.equal(loginResponse.body.user.role, 'admin');

    const profile = await request(server)
      .patch('/auth/profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'demo-updated', email: 'demo-updated@example.com' })
      .expect(200);
    assert.equal(profile.body.username, 'demo-updated');
    assert.equal(profile.body.email, 'demo-updated@example.com');

    const renamedLogin = await request(server)
      .post('/auth/login')
      .send({ account: 'demo-updated', password: 'demo123456' })
      .expect(201);
    assert.equal(renamedLogin.body.user.username, 'demo-updated');

    const templates = await request(server)
      .get('/workflow-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(templates.body.length >= 3, true);
    await request(server)
      .post(`/workflow-templates/${templates.body[0].id}/create-workflow`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '从模板创建的工作流' })
      .expect(201);

    const workflowJson = {
      nodes: [
        {
          id: 'start_0',
          type: 'start',
          data: {
            title: 'Start',
            outputs: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
        {
          id: 'llm_0',
          type: 'llm',
          data: {
            title: 'LLM',
            inputsValues: {
              modelName: { type: 'constant', content: 'deepseek-chat' },
              prompt: { type: 'template', content: '{{start_0.query}}' },
            },
          },
        },
        { id: 'end_0', type: 'end', data: { title: 'End' } },
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
        { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
      ],
    };

    const createdWorkflow = await request(server)
      .post('/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '集成测试工作流', flowgram: JSON.stringify(workflowJson) })
      .expect(201);
    const workflowId = createdWorkflow.body.id;

    await request(server)
      .get(`/workflows/${workflowId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(server)
      .put(`/workflows/${workflowId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '更新后的工作流', flowgram: JSON.stringify(workflowJson) })
      .expect(200)
      .expect((response) => assert.equal(response.body.version, 2));

    await request(server)
      .post('/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '坏数据', flowgram: '{}' })
      .expect(400);

    const keyResponse = await request(server)
      .post('/user/api-keys')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'integration' })
      .expect(201);
    const apiKey = keyResponse.body.plaintext;
    assert.match(apiKey, /^ff-[a-f0-9]{32}$/);

    await request(server)
      .post(`/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ inputs: { query: '发布前不应执行' } })
      .expect(400);

    const publishResponse = await request(server)
      .post(`/workflows/${workflowId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    assert.equal(publishResponse.body.workflow.publishedVersion, 2);
    assert.equal(publishResponse.body.endpoint, `/workflows/${workflowId}/execute`);

    const versions = await request(server)
      .get(`/workflows/${workflowId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(versions.body.length, 1);
    assert.equal(versions.body[0].version, 2);

    await request(server)
      .put(`/workflows/${workflowId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '错误草稿名称' })
      .expect(200)
      .expect((response) => assert.equal(response.body.version, 3));
    const restored = await request(server)
      .post(`/workflows/${workflowId}/versions/2/restore`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    assert.equal(restored.body.name, '更新后的工作流');
    assert.equal(restored.body.version, 4);
    assert.equal(restored.body.publishedVersion, 2, '恢复草稿不能自动改变线上版本');

    await request(server)
      .post(`/workflows/${workflowId}/triggers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'invalid input trigger',
        type: 'webhook',
        staticInputs: { unknownInput: 'must fail before scheduling' },
      })
      .expect(400);

    const scheduleTrigger = await request(server)
      .post(`/workflows/${workflowId}/triggers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'hourly integration schedule',
        type: 'schedule',
        intervalMinutes: 60,
        staticInputs: { query: 'schedule input' },
      })
      .expect(201);
    assert.equal(scheduleTrigger.body.trigger.type, 'schedule');

    const webhookTrigger = await request(server)
      .post(`/workflows/${workflowId}/triggers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'integration webhook', type: 'webhook' })
      .expect(201);
    assert.match(webhookTrigger.body.secret, /^ffwh_/);
    const webhookResponse = await request(server)
      .post(`/webhooks/${webhookTrigger.body.secret}`)
      .send({ inputs: { query: 'webhook invocation' } })
      .expect(200);
    assert.match(webhookResponse.text, /workflow_finished/);

    const triggers = await request(server)
      .get(`/workflows/${workflowId}/triggers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(triggers.body.length, 2);

    const publishedRunResponse = await request(server)
      .post(`/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ inputs: { query: '已发布工作流调用' } })
      .expect(200);
    assert.match(publishedRunResponse.text, /workflow_finished/);

    await request(server)
      .post(`/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ inputs: { query: 123 } })
      .expect(400);

    const workflowRuns = await request(server)
      .get(`/workflows/${workflowId}/runs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(workflowRuns.body.total, 2);
    assert.equal(workflowRuns.body.items[0].status, 'succeeded');

    await request(server)
      .post(`/workflows/${workflowId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(server)
      .post(`/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ inputs: { query: '取消发布后不应执行' } })
      .expect(400);

    const runResponse = await request(server)
      .post('/workflows/run')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', 'integration-run-1')
      .send({ flowgram: workflowJson })
      .expect(200);
    assert.match(runResponse.text, /workflow_finished/);
    await request(server)
      .post('/workflows/run')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', 'integration-run-1')
      .send({ flowgram: workflowJson })
      .expect(409);

    const runs = await request(server)
      .get('/admin/runs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(runs.body.items[0].status, 'succeeded');
    assert.equal(runs.body.items[0].totalTokens, 120);

    const balanceLogs = await request(server)
      .get('/admin/balance-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    assert.equal(balanceLogs.body.items.length >= 3, true);

    const registered = await request(server)
      .post('/auth/register')
      .send({
        username: 'integration-user',
        email: 'integration@example.com',
        password: 'password123',
      })
      .expect(201);
    const userId = registered.body.user.id;

    await request(server)
      .patch(`/admin/users/${userId}/vip`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ vipLevel: 'pro' })
      .expect(200);
    await request(server)
      .patch(`/admin/users/${userId}/balance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: 5, remark: 'integration recharge' })
      .expect(200);
    await request(server)
      .patch(`/admin/users/${userId}/balance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delta: 0 })
      .expect(400);

    await request(server)
      .delete(`/admin/users/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .post('/auth/login')
      .send({ account: 'integration-user', password: 'password123' })
      .expect(401);

    await request(server)
      .delete(`/workflows/${workflowId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .get(`/workflows/${workflowId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    await request(server)
      .delete(`/user/api-keys/${keyResponse.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .post('/workflows/run')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ flowgram: workflowJson })
      .expect(401);

    console.log('platform integration tests passed');
  } finally {
    await app.close();
  }
}

void main();
