/**
 * Webhook 密钥传递方式的回归测试。
 *
 * 背景：/webhooks/:secret 把凭据放在 URL 路径里，反向代理、网关和浏览器历史都
 * 会把它原样记进日志。现在支持 `X-Webhook-Secret` 头，旧的路径传参保留兼容。
 * 这个测试锁住三件事：头优先、路径仍可用、两者都没有时必须 400 而不是 500。
 */
import 'reflect-metadata';
import { WebhookController } from '../src/triggers/webhook.controller';

type Call = { secret?: string; headers: Record<string, string>; status?: number; body?: any };

function fakeResponse(call: Call) {
  const res = {
    setHeader(name: string, value: string) {
      call.headers[name] = value;
    },
    status(code: number) {
      call.status = code;
      return res;
    },
    json(payload: any) {
      call.body = payload;
      return res;
    },
    write() {
      return true;
    },
    flushHeaders() {},
    end() {},
  };
  return res as any;
}

async function invoke(controller: any, pathSecret: string | undefined, headerSecret: string | undefined) {
  const call: Call = { secret: undefined, headers: {} };
  await controller.invoke(pathSecret, headerSecret, {}, undefined, fakeResponse(call));
  return call;
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  const seen: string[] = [];
  const controller = new WebhookController(
    {
      resolveWebhook: async (secret: string) => {
        seen.push(secret);
        return {
          trigger: { id: 'trigger-1', staticInputs: {} },
          workflow: { id: 'wf-1', publishedFlowgramJson: {}, publishedVersion: 1 },
          user: { id: 'user-1' },
        };
      },
      recordResult: async () => undefined,
    } as any,
    {
      runWorkflow: async function* run() {
        yield { event: 'workflow_finished', data: { status: 'succeeded' } };
      },
    } as any,
    { assertAllowed: () => undefined } as any,
  );

  // 1. 头里的密钥优先
  const viaHeader = await invoke(controller, undefined, 'header-secret');
  assert(seen[seen.length - 1] === 'header-secret', '应优先使用 X-Webhook-Secret 头里的密钥');
  assert(
    viaHeader.headers['X-Webhook-Secret-Source'] === undefined,
    '走头传递时不该标记 path-deprecated',
  );

  // 2. 旧的路径传参继续可用，但会被标记 deprecated
  const viaPath = await invoke(controller, 'path-secret', undefined);
  assert(seen[seen.length - 1] === 'path-secret', '路径里的密钥仍应可用（兼容旧调用方）');
  assert(
    viaPath.headers['X-Webhook-Secret-Source'] === 'path-deprecated',
    '路径传参应被标记为已废弃',
  );

  // 3. 头与路径同时存在时以头为准
  await invoke(controller, 'path-secret', 'header-secret');
  assert(seen[seen.length - 1] === 'header-secret', '两者同时存在时应以头为准');

  // 4. 都没有密钥时必须 400，而不是带着 undefined 去查库
  const missing = await invoke(controller, undefined, undefined);
  assert(missing.status === 400, `缺少密钥时应返回 400，实际 ${missing.status}`);
  assert(
    missing.body?.code === 'webhook_secret_missing',
    `缺少密钥时应返回 webhook_secret_missing，实际 ${missing.body?.code}`,
  );

  console.log('Webhook 密钥传递检查通过：头优先 / 路径兼容并标记废弃 / 缺失返回 400');
}

main().catch((error) => {
  console.error(`Webhook 密钥检查失败: ${error.message}`);
  process.exitCode = 1;
});
