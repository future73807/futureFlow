import 'reflect-metadata';

import assert from 'node:assert/strict';

import {
  buildMessage,
  buildRunEventMessage,
  FF_EMBED_PROTOCOL_VERSION,
  isAllowedOrigin,
  negotiateVersion,
  parseHostMessage,
  themeTokenToCssVar,
} from '../../frontend/src/embed/protocol';

/**
 * `ff-embed/v1` **协议本体**的离线回归。
 *
 * 这里直接 import 前端那份协议模块（`frontend/src/embed/protocol.ts`）——两侧共用一个实现
 * 就没有「文档对、代码错」的空间；测试要守住的三条是安全边界（《flow 集成方案》§3.3）：
 *   ① 入站消息先过 origin 白名单，再谈内容；
 *   ② 形状不对一律丢弃（不 `as` 硬吞），包括主题令牌只收 `--ff-*`（防任意 CSS 变量注入）；
 *   ③ 版本不匹配**不抛错**，返回值里带可读原因，交给调用方降级并在界面明示。
 */

const ALLOWED = ['http://127.0.0.1:3001'];

function hostMessage(overrides: Record<string, unknown>): unknown {
  return { version: FF_EMBED_PROTOCOL_VERSION, ...overrides };
}

function testVersionNegotiation() {
  assert.deepEqual(negotiateVersion(FF_EMBED_PROTOCOL_VERSION), { ok: true });

  const mismatch = negotiateVersion('v2');
  assert.equal(mismatch.ok, false);
  assert.match(
    (mismatch as { reason: string }).reason,
    /宿主 v2.*flow v1|协议版本不匹配/,
    '版本不匹配要给出两侧版本，便于定位该升级谁',
  );

  const missing = negotiateVersion(undefined);
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /没有声明/);
}

function testInboundValidation() {
  const context = { origin: ALLOWED[0], allowedOrigins: ALLOWED };

  // ① origin 白名单优先于一切：内容再对也不认
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/identity', hostToken: 't' }), {
      origin: 'https://evil.example.com',
      allowedOrigins: ALLOWED,
    }),
    null,
    '非白名单 origin 的消息必须丢弃（哪怕形状完全正确）',
  );
  assert.equal(isAllowedOrigin('', ALLOWED), false);
  assert.equal(isAllowedOrigin(ALLOWED[0], []), false);

  // ② 形状校验
  assert.equal(parseHostMessage('不是对象', context), null);
  assert.equal(parseHostMessage(['ff-embed/identity'], context), null);
  assert.equal(parseHostMessage(hostMessage({ type: 'ff-embed/unknown' }), context), null);
  assert.equal(parseHostMessage(hostMessage({}), context), null, '缺 type 丢弃');
  assert.equal(parseHostMessage(hostMessage({ type: 'ff-embed/identity' }), context), null, '缺令牌丢弃');
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/identity', hostToken: '   ' }), context),
    null,
    '空白令牌丢弃',
  );
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/identity', hostToken: 'x'.repeat(9000) }), context),
    null,
    '超长令牌丢弃',
  );

  const identity = parseHostMessage(
    hostMessage({ type: 'ff-embed/identity', hostToken: 'host-token' }),
    context,
  );
  assert.equal(identity?.type, 'ff-embed/identity');
  assert.equal(identity?.hostToken, 'host-token');

  // ③ 主题令牌只收 --ff-*，且值必须是短字符串（防 CSS 变量注入）
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/theme', tokens: { color: 'red' } }), context),
    null,
    '非 --ff-* 的令牌一律拒绝',
  );
  assert.equal(
    parseHostMessage(
      hostMessage({ type: 'ff-embed/theme', tokens: { '--ff-primary': 'x'.repeat(500) } }),
      context,
    ),
    null,
    '超长令牌值拒绝',
  );
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/theme', mode: 'rainbow' }), context),
    null,
  );
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/theme', tokens: { '--ff-primary': '#123456' }, mode: 'dark', brand: true }), context)
      ?.type,
    'ff-embed/theme',
  );

  // ④ 未知方向的消息（flow → 宿主 的那些）不能被当成入站消息
  assert.equal(
    parseHostMessage(hostMessage({ type: 'ff-embed/hello' }), context),
    null,
    '出站消息类型不得被当成宿主入站消息',
  );

  assert.equal(themeTokenToCssVar('--ff-primary'), '--ff-primary');
  assert.equal(themeTokenToCssVar(' color'), null);
  assert.equal(themeTokenToCssVar('--g-workflow-bg'), null, 'FlowGram 的变量不归宿主接管');
}

function testOutboundMessages() {
  const hello = buildMessage('ff-embed/hello', { capabilities: {} });
  assert.equal(hello.type, 'ff-embed/hello');
  assert.equal(hello.version, FF_EMBED_PROTOCOL_VERSION, '出站消息必须带协议版本');

  assert.throws(
    () => buildMessage('ff-embed/identity' as never, { hostToken: 'x' }),
    /只用于 flow → 宿主/,
    '出站构造器不许伪造宿主方向的类型',
  );

  const runEvent = buildRunEventMessage({
    runId: 'run-1',
    seq: 7,
    type: 'node_finished',
    payload: { node_id: 'n1' },
  });
  assert.equal(runEvent.type, 'ff-embed/run-event');
  assert.equal(runEvent.seq, 7);
  assert.equal(runEvent.runId, 'run-1');
  assert.equal(runEvent.eventType, 'node_finished');
  assert.match(String(runEvent.at), /^\d{4}-\d{2}-\d{2}T/, '事件要带时间戳（宿主按它排序）');
}

function main() {
  testVersionNegotiation();
  testInboundValidation();
  testOutboundMessages();
  console.log(
    'ff-embed/v1 协议 smoke 通过: 版本协商（不匹配给可读原因）、'
    + '入站 origin 白名单 + schema 校验（含主题令牌只收 --ff-*）、'
    + '出站消息带版本、运行事件带 seq 与时间戳',
  );
}

main();
