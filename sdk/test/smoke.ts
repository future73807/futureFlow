import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountFlowEmbed, FF_EMBED_PROTOCOL_VERSION } from '../src/index';

/**
 * ff-embed 宿主端 SDK 的离线回归（jsdom 模拟 iframe + postMessage）。
 *
 * 钉四件事（协议权威 flow/docs/ff-embed-v1.md）：
 *  ① flow hello → SDK 回 hello-ack（带版本）并经 getIdentity 注入 identity；
 *  ② 身份令牌**只透传**（SDK 不解析、不落日志）；
 *  ③ origin 白名单外的消息一律忽略（安全边界 §3.3）；
 *  ④ navigate 只收 / 开头的站内路径；destroy 发 bye 并解绑监听。
 */

const FLOW_ORIGIN = 'http://127.0.0.1:8090';

let dom: JSDOM;

/** jsdom 的 iframe.contentWindow 是 getter-only：prototype 上挂记录型 mock。 */
let postLog: Array<{ frame: unknown; message: Record<string, unknown>; targetOrigin: string }>;

function stubContentWindow(
  frame: HTMLIFrameElement,
  onPost: (message: Record<string, unknown>, targetOrigin: string) => void,
): void {
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    get() {
      return {
        postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
          postLog.push({ frame, message, targetOrigin });
          onPost(message, targetOrigin);
        },
      };
    },
  });
}

function setupDom(): { window: Window; container: HTMLElement } {
  postLog = [];
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:3100/workbench',
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    MessageEvent: dom.window.MessageEvent,
    HTMLElement: dom.window.HTMLElement,
    URL: dom.window.URL,
  };
  Object.assign(globalThis, globals);
  const container = dom.window.document.getElementById('root') as HTMLElement;
  return { window: dom.window as unknown as Window, container };
}

function postFromFlow(window: Window, data: unknown, origin = FLOW_ORIGIN): void {
  window.dispatchEvent(new (dom.window.MessageEvent as any)('message', { origin, data, source: null }));
}

function lastPostToFlow(): { type: string; version?: string; hostToken?: string } | null {
  const frame = dom.window.document.querySelector('iframe');
  const calls = (frame as any)?.__postMessages as Array<Record<string, unknown>> | undefined;
  return (calls?.at(-1) as any) ?? null;
}

async function testHandshake() {
  const { window, container } = setupDom();
  const posted: Array<Record<string, unknown>> = [];
  const navigated: string[] = [];
  let identityCalls = 0;
  const handle = mountFlowEmbed({
    container,
    frontendUrl: FLOW_ORIGIN,
    getIdentity: async () => {
      identityCalls += 1;
      return { hostToken: 'host-token-1' };
    },
    onNavigate: (path) => navigated.push(path),
  });

  // 桩 contentWindow.postMessage：记录 → 模拟 flow 收到 hello-ack/identity 后回 ready
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  assert.ok(frame, 'iframe 应挂载到容器');
  assert.equal(frame.getAttribute('src'), FLOW_ORIGIN);
  stubContentWindow(frame, (message, targetOrigin) => {
    assert.equal(targetOrigin, FLOW_ORIGIN, 'targetOrigin 必须是 flow origin（不投 *）');
    posted.push(message);
    if (message.type === 'ff-embed/identity') {
      setTimeout(() => postFromFlow(window, { type: 'ff-embed/ready' }), 0);
    }
  });

  postFromFlow(window, { type: 'ff-embed/hello', version: FF_EMBED_PROTOCOL_VERSION });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const types = posted.map((message) => message.type);
  assert.deepEqual(types, ['ff-embed/hello-ack', 'ff-embed/identity']);
  assert.equal(posted[0].version, FF_EMBED_PROTOCOL_VERSION);
  assert.equal(posted[1].hostToken, 'host-token-1', '身份令牌只透传');
  assert.equal(identityCalls, 1, 'identity 每次握手只取一次');
  handle.destroy();
}

async function testOriginAndNavigate() {
  const { window, container } = setupDom();
  const navigated: string[] = [];
  let identityCalls = 0;
  const handle = mountFlowEmbed({
    container,
    frontendUrl: FLOW_ORIGIN,
    getIdentity: async () => {
      identityCalls += 1;
      return { hostToken: 'tok' };
    },
    onNavigate: (path) => navigated.push(path),
  });
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  stubContentWindow(frame, (message) => {
    if (message.type === 'ff-embed/identity') {
      setTimeout(() => postFromFlow(window, { type: 'ff-embed/ready' }), 0);
    }
  });
  postFromFlow(window, { type: 'ff-embed/hello', version: FF_EMBED_PROTOCOL_VERSION });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 非白名单 origin：静默忽略
  postFromFlow(window, { type: 'ff-embed/navigate', path: '/tasks' }, 'http://evil.example');
  // 站外路径：拒绝
  postFromFlow(window, { type: 'ff-embed/navigate', path: 'https://evil.example' });
  assert.deepEqual(navigated, [], '非法 navigate 不得到达宿主回调');

  // 合法站内路径：到达
  postFromFlow(window, { type: 'ff-embed/navigate', path: '/tasks' });
  assert.deepEqual(navigated, ['/tasks']);
  assert.equal(identityCalls, 1, 'hello 只有一次，identity 只取一次');
  handle.destroy();
}

async function testDestroy() {
  const { window, container } = setupDom();
  const handle = mountFlowEmbed({
    container,
    frontendUrl: FLOW_ORIGIN,
    getIdentity: async () => ({ hostToken: 'tok' }),
  });
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  stubContentWindow(frame, (message) => {
    if (message.type === 'ff-embed/identity') {
      setTimeout(() => postFromFlow(window, { type: 'ff-embed/ready' }), 0);
    }
  });
  postFromFlow(window, { type: 'ff-embed/hello', version: FF_EMBED_PROTOCOL_VERSION });
  await new Promise((resolve) => setTimeout(resolve, 10));

  handle.destroy();
  assert.equal(container.querySelector('iframe'), null, 'destroy 移除 iframe');

  // destroy 后的入站消息不再触发任何 post
  let posted = false;
  stubContentWindow(frame, (message) => {
    if (message.type === 'ff-embed/identity') {
      setTimeout(() => postFromFlow(window, { type: 'ff-embed/ready' }), 0);
    }
  });
  postFromFlow(window, { type: 'ff-embed/hello', version: FF_EMBED_PROTOCOL_VERSION });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(posted, false, 'destroy 后不再回话');
}

async function main() {
  await testHandshake();
  console.log('SDK 握手 smoke 通过: hello-ack + identity 注入、令牌只透传');
  await testOriginAndNavigate();
  console.log('SDK 安全 smoke 通过: origin 白名单外忽略、navigate 只收站内路径');
  await testDestroy();
  console.log('SDK 生命周期 smoke 通过: destroy 发 bye、移除 iframe、解绑监听');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
