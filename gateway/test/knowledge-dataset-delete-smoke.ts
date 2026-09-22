/**
 * 知识库删除的幂等性冒烟测试。
 *
 * 背景：`deleteDataset` 先调 Dify 删除、再清本地所有权行。若 Dify 侧的知识库
 * 已经被外部删掉（或上一次删除在清本地行之前中断），DELETE 会返回 404 ——
 * 原实现会在这里抛错，导致**本地所有权行永远清不掉**，而且之后连重试删除都清不掉
 * （每次都在同一处抛错，永远走不到清理那一步）。
 *
 * 这里守住两件事：
 *   1. 404 必须按「已达成」处理并继续清本地行
 *   2. 非 404 的失败**不能**被吞掉 —— 否则真实的删除失败会被伪装成成功，
 *      用户以为删掉了、实际还在，比清不掉本地行更糟
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import { KnowledgeService } from '../src/knowledge/knowledge.service';

const DATASET_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OWNER_ID = 'user-1';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  service: KnowledgeService;
  deletedRows: Array<Record<string, unknown>>;
  consoleCalls: string[];
  restore: () => void;
}

/**
 * @param deleteStatus Dify DELETE /datasets/:id 返回的状态码
 * @param ownerUserId  本地所有权行记录的归属用户
 */
function makeHarness(options: {
  deleteStatus: number;
  ownerUserId?: string;
  ownerRowExists?: boolean;
}): Harness {
  const deletedRows: Array<Record<string, unknown>> = [];
  const consoleCalls: string[] = [];

  const ownerRepo = {
    findOne: async () => (
      options.ownerRowExists === false
        ? null
        : { id: 'row-1', datasetId: DATASET_ID, userId: options.ownerUserId ?? OWNER_ID }
    ),
    delete: async (criteria: Record<string, unknown>) => { deletedRows.push(criteria); },
  };
  const dify = {
    resolveConsoleAuthorization: async () => ({
      consoleBase: 'http://console.test/console/api',
      token: 'console-token',
    }),
    // 401/403 会先尝试刷新授权；这里固定返回 null 表示刷新不成功，
    // 让流程落到「授权已过期」那条分支（而不是抛 TypeError）。
    refreshConsoleAuthorization: async () => null,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    consoleCalls.push(`${method} ${url}`);
    if (method === 'DELETE' && /\/datasets\/[^/]+$/.test(url)) {
      return options.deleteStatus === 204
        ? new Response(null, { status: 204 })
        : jsonResponse(options.deleteStatus, { message: 'stub' });
    }
    throw new Error(`未预期的 Console 调用: ${method} ${url}`);
  }) as any;

  return {
    service: new KnowledgeService(dify as any, { get: () => undefined } as any, ownerRepo as any),
    deletedRows,
    consoleCalls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

async function main() {
  // 1. Dify 侧已不存在（404）：必须继续清本地所有权行，不能抛错。
  {
    const harness = makeHarness({ deleteStatus: 404 });
    try {
      await harness.service.deleteDataset(OWNER_ID, DATASET_ID);
      assert.deepEqual(
        harness.deletedRows, [{ datasetId: DATASET_ID }],
        '404 时必须继续清掉本地所有权行，否则它会永远留在库里且无法通过重试清理',
      );
    } finally {
      harness.restore();
    }
  }

  // 2. 正常删除（204）：同样要清本地行。
  {
    const harness = makeHarness({ deleteStatus: 204 });
    try {
      await harness.service.deleteDataset(OWNER_ID, DATASET_ID);
      assert.deepEqual(harness.deletedRows, [{ datasetId: DATASET_ID }], '正常删除要清本地行');
    } finally {
      harness.restore();
    }
  }

  // 3. 反向断言：非 404 的失败必须抛出，且不得清本地行。
  //    吞掉真实失败会让用户以为删掉了、实际还在 —— 比清不掉本地行更糟。
  //    401/403 走的是「授权过期→刷新」分支，刷新不成功时抛 ServiceUnavailable；
  //    其余状态抛 BadRequest。两类都必须抛，且都不能清本地行。
  for (const status of [400, 500, 503]) {
    const harness = makeHarness({ deleteStatus: status });
    try {
      await assert.rejects(
        () => harness.service.deleteDataset(OWNER_ID, DATASET_ID),
        (error: unknown) => error instanceof BadRequestException,
        `HTTP ${status} 必须抛 BadRequest，不能被当成「已删除」`,
      );
      assert.deepEqual(harness.deletedRows, [], `HTTP ${status} 时不得清本地行（Dify 侧其实还在）`);
    } finally {
      harness.restore();
    }
  }
  for (const status of [401, 403]) {
    const harness = makeHarness({ deleteStatus: status });
    try {
      await assert.rejects(
        () => harness.service.deleteDataset(OWNER_ID, DATASET_ID),
        (error: unknown) => error instanceof ServiceUnavailableException,
        `HTTP ${status}（授权过期）必须抛出，不能被当成「已删除」`,
      );
      assert.deepEqual(harness.deletedRows, [], `HTTP ${status} 时不得清本地行`);
    } finally {
      harness.restore();
    }
  }

  // 4. 非本人且非管理员：在调 Dify 之前就被挡住。
  {
    const harness = makeHarness({ deleteStatus: 204, ownerUserId: 'someone-else' });
    try {
      await assert.rejects(
        () => harness.service.deleteDataset(OWNER_ID, DATASET_ID, false),
        (error: unknown) => error instanceof ForbiddenException,
      );
      assert.deepEqual(
        harness.consoleCalls, [],
        '归属校验失败时不得调用 Dify',
      );
      assert.deepEqual(harness.deletedRows, [], '归属校验失败时不得清本地行');
    } finally {
      harness.restore();
    }
  }

  // 5. 管理员可以删别人的知识库（既有语义不能被这次改动破坏）。
  {
    const harness = makeHarness({ deleteStatus: 204, ownerUserId: 'someone-else' });
    try {
      await harness.service.deleteDataset(OWNER_ID, DATASET_ID, true);
      assert.deepEqual(harness.deletedRows, [{ datasetId: DATASET_ID }], '管理员应能删除');
    } finally {
      harness.restore();
    }
  }

  console.log('knowledge dataset delete smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
