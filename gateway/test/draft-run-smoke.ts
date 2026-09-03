/**
 * 草稿云端试运行（draft-run）编排冒烟测试。
 *
 * 用假沙箱服务验证 WorkflowsController.draftRun 的编排契约：
 * 归属校验先于沙箱准备、准备失败时阻断执行、成功时以沙箱 Key 走执行链路。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { WorkflowsController } from '../src/workflows/workflows.controller';

function makeRes() {
  const sse: string[] = [];
  return {
    req: { user: { id: 'user-1', username: 'tester', vipLevel: 'pro' } },
    headersSent: false,
    destroyed: false,
    status() { return this; },
    json() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) { sse.push(chunk); },
    end() {},
    once() {},
    on() {},
    removeListener() {},
    writableEnded: false,
    sse,
  } as any;
}

function makeHarness(options: { failPrepare?: boolean }) {
  const runCalls: Array<{ target: any }> = [];
  const sandboxCalls: string[] = [];
  const workflowsService = {
    *runWorkflow(_flowgram: any, _user: any, _inputs: any, _workflowId: any, ctx: any) {
      runCalls.push({ target: { apiKey: ctx.sandboxApiKey } });
      yield { event: 'workflow_finished', data: { status: 'succeeded' } };
    },
  };
  const draftRunService = {
    async prepareSandbox(userId: string, flowgram: any) {
      sandboxCalls.push(userId);
      if (options.failPrepare && flowgram?.nodes?.some((n: any) => n.data?.failPrepare)) {
        throw new ServiceUnavailableMock();
      }
      return { appId: 'sandbox-app', apiKey: ['app', 'sandbox', 'key'].join(''), reused: false };
    },
  };
  const crudService = {
    async getById(id: string, _userId: string) {
      if (id === 'missing') throw new NotFoundException('工作流不存在');
      return {
        id,
        userId: _userId,
        name: '草稿',
        flowgramJson: { nodes: [{ id: 'n1', type: 'text', data: options.failPrepare ? { failPrepare: true } : {} }], edges: [] },
      };
    },
  };
  const controller = new WorkflowsController(
    workflowsService as any,
    {} as any,
    crudService as any,
    draftRunService as any,
  );
  return { controller, runCalls, sandboxCalls };
}

class ServiceUnavailableMock extends Error {
  status = 503;
}

async function main() {
  // 1. 正常路径：沙箱准备 → runWorkflow 收到沙箱 Key → SSE 输出终态。
  const ok = makeHarness({});
  const okRes = makeRes();
  await ok.controller.draftRun('wf-1', { inputs: { query: 'hi' } } as any, okRes);
  assert.deepEqual(ok.sandboxCalls, ['user-1']);
  assert.equal(ok.runCalls.length, 1);
  assert.equal(ok.runCalls[0].target.apiKey, 'appsandboxkey');
  assert.match(okRes.sse.join(''), /workflow_finished/);

  // 2. 目标工作流不存在：归属校验先于沙箱准备。
  const missing = makeHarness({});
  await assert.rejects(
    () => missing.controller.draftRun('missing', {} as any, makeRes()),
    (error: unknown) => error instanceof NotFoundException,
  );
  assert.equal(missing.sandboxCalls.length, 0, '归属校验失败时不得准备沙箱');

  // 3. 沙箱准备失败：不进入执行链路。
  const failed = makeHarness({ failPrepare: true });
  const failedRes = makeRes();
  await failed.controller.draftRun('wf-1', {} as any, failedRes).catch(() => undefined);
  assert.equal(failed.runCalls.length, 0, '沙箱准备失败时不得执行工作流');

  console.log('draft-run orchestration smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
