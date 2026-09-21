import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import {
  decryptWithKeyRing,
  deriveAesKey,
  encryptAesGcm,
  isUsableEncryptionSecret,
  parseAesGcmPayload,
  resolveEncryptionKeyRing,
} from '../src/common/encryption-key-ring';
import { McpCrypto } from '../src/mcp/mcp-crypto.service';
import { MediaCredentialCrypto } from '../src/media/media-credential.crypto';
import { DraftRunService } from '../src/workflows/draft-run.service';

/**
 * 加密密钥环回归。
 *
 * 背景：媒体凭据、MCP 令牌、草稿沙箱凭据此前各自复制了一份
 * `MEDIA_CREDENTIAL_ENCRYPTION_SECRET || DIFY_KEY_ENCRYPTION_SECRET` 取密钥的
 * 实现，而 `env:init` 长期只生成后者——于是三类密文与 Dify 凭据共用一把主密钥，
 * 一把泄露等于全解。改成密钥环（primary 加密 + legacy 只读回退）后，部署方随时
 * 可以补上独立密钥，**不必先做数据迁移**。
 *
 * 这里守住两件容易被后续重构破坏的事：
 *   1. 兼容：用**旧实现**（单密钥）写出的密文必须仍能解开；
 *   2. 收口：新写入必须用 primary，legacy 只读——否则"分层"只是表面文章。
 */

const MEDIA_SECRET = 'a'.repeat(48);
const LEGACY_SECRET = 'b'.repeat(48);

function configOf(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string, fallback?: string) => (values[key] === undefined ? fallback : values[key]),
  } as unknown as ConfigService;
}

/**
 * 旧实现的加密函数（改造前三个文件里各自的那一段），用于制造真实的「存量密文」。
 * 故意不复用新代码：复用就证明不了兼容性。
 */
function legacyEncrypt(secret: string, plaintext: string, aad: Buffer): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

const mediaAad = (userId: string) => Buffer.from(
  `futureflow-media-v1\0${userId}\0openai\0cred-1`,
  'utf8',
);

function keyRingHelpers() {
  // ── 1. 可用性判定：过短与示例值都算未配置 ──────────────────────────
  {
    assert.equal(isUsableEncryptionSecret(''), false);
    assert.equal(isUsableEncryptionSecret('a'.repeat(31)), false, '31 位必须被拒绝');
    assert.equal(isUsableEncryptionSecret('a'.repeat(32)), true);
    assert.equal(
      isUsableEncryptionSecret('replace-with-a-random-secret-at-least-32-characters'),
      false,
      '示例值即使够长也必须被拒绝',
    );
  }

  // ── 2. 环的顺序与去重 ─────────────────────────────────────────────
  {
    const same = resolveEncryptionKeyRing(
      configOf({
        MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET,
        DIFY_KEY_ENCRYPTION_SECRET: MEDIA_SECRET,
      }),
      { primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET', legacy: ['DIFY_KEY_ENCRYPTION_SECRET'], purpose: '测试' },
    );
    assert.equal(same.length, 1, '同值应去重，避免重复尝试');

    const ring = resolveEncryptionKeyRing(
      configOf({
        MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET,
        DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET,
      }),
      { primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET', legacy: ['DIFY_KEY_ENCRYPTION_SECRET'], purpose: '测试' },
    );
    assert.equal(ring.length, 2);
    assert.equal(ring[0].equals(deriveAesKey(MEDIA_SECRET)), true, '第一把必须是 primary');
    assert.equal(ring[1].equals(deriveAesKey(LEGACY_SECRET)), true);
  }

  // ── 3. primary 不可用时回退，而不是整个功能挂掉 ────────────────────
  {
    const ring = resolveEncryptionKeyRing(
      configOf({
        MEDIA_CREDENTIAL_ENCRYPTION_SECRET: 'replace-with-something-at-least-32-characters',
        DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET,
      }),
      { primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET', legacy: ['DIFY_KEY_ENCRYPTION_SECRET'], purpose: '测试' },
    );
    assert.equal(ring.length, 1);
    assert.equal(ring[0].equals(deriveAesKey(LEGACY_SECRET)), true, '应跳过不可用的 primary');
  }

  // ── 4. 一把可用密钥都没有：报错文案由 purpose 决定 ─────────────────
  {
    assert.throws(
      () => resolveEncryptionKeyRing(configOf({}), {
        primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET',
        legacy: ['DIFY_KEY_ENCRYPTION_SECRET'],
        purpose: '媒体凭据',
      }),
      /媒体凭据加密未配置/,
    );
  }

  // ── 5. 载荷形状解析：多一段/少一段/版本不符都算坏数据 ───────────────
  {
    const good = encryptAesGcm(deriveAesKey(MEDIA_SECRET), 'x', Buffer.from('aad'));
    assert.ok(parseAesGcmPayload(good));
    assert.equal(parseAesGcmPayload(`${good}:extra`), null, '多一段必须拒绝');
    assert.equal(parseAesGcmPayload('v1:only-two'), null);
    assert.equal(parseAesGcmPayload(good.replace(/^v1/, 'v2')), null, '未知版本必须拒绝');
    assert.equal(parseAesGcmPayload(''), null);
  }

  // ── 6. AAD 仍然参与认证（换 AAD 解不开）───────────────────────────
  {
    const parts = parseAesGcmPayload(
      encryptAesGcm(deriveAesKey(MEDIA_SECRET), 'secret', Buffer.from('a')),
    );
    assert.ok(parts);
    assert.equal(decryptWithKeyRing([deriveAesKey(MEDIA_SECRET)], parts, Buffer.from('a')), 'secret');
    assert.throws(() => decryptWithKeyRing([deriveAesKey(MEDIA_SECRET)], parts, Buffer.from('b')));
  }
}

function mediaCredentialCompatibility() {
  const legacyOnly = new MediaCredentialCrypto(
    configOf({ DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET }),
  );
  const withBoth = new MediaCredentialCrypto(configOf({
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET,
    DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET,
  }));
  const mediaOnly = new MediaCredentialCrypto(
    configOf({ MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET }),
  );
  const context = { userId: 'user-a', provider: 'openai' as const, credentialId: 'cred-1' };

  // 存量密文：旧实现（单密钥 DIFY_KEY_ENCRYPTION_SECRET）写出
  const existing = legacyEncrypt(LEGACY_SECRET, 'sk-existing-key', mediaAad('user-a'));
  assert.equal(
    withBoth.decrypt(existing, context),
    'sk-existing-key',
    '补上独立密钥后，存量密文必须仍可读（否则升级即数据不可用）',
  );
  assert.equal(legacyOnly.decrypt(existing, context), 'sk-existing-key');

  // 新写入必须用 primary
  const fresh = withBoth.encrypt('sk-new-key', context);
  assert.equal(mediaOnly.decrypt(fresh, context), 'sk-new-key', '新密文应由 primary 解开');
  assert.throws(
    () => legacyOnly.decrypt(fresh, context),
    '只配 legacy 的实例不应能解开新密文（证明写入确实换了密钥）',
  );

  // AAD 依旧把密文钉在「用户 + 供应商 + 凭据」上
  assert.throws(() => withBoth.decrypt(existing, { ...context, userId: 'user-b' }));
  assert.throws(() => withBoth.decrypt(existing, { ...context, credentialId: 'cred-2' }));

  // 未配置任何密钥：沿用既有文案，前端据此提示
  assert.throws(
    () => new MediaCredentialCrypto(configOf({})).encrypt('x', context),
    /媒体凭据加密未配置/,
  );
}

function mcpTokenCompatibility() {
  const withBoth = new McpCrypto(configOf({
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET,
    DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET,
  }));
  const legacyOnly = new McpCrypto(configOf({ DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET }));
  const primaryOnly = new McpCrypto(configOf({ MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET }));
  const context = { userId: 'user-a', serverId: 'server-1' };
  const aad = Buffer.from(`mcp-server:${context.userId}:${context.serverId}`, 'utf8');

  const existing = legacyEncrypt(LEGACY_SECRET, 'bearer-token', aad);
  assert.equal(withBoth.decrypt(existing, context), 'bearer-token', 'MCP 存量令牌必须仍可读');

  const fresh = withBoth.encrypt('bearer-token', context);
  assert.equal(primaryOnly.decrypt(fresh, context), 'bearer-token');
  assert.throws(() => legacyOnly.decrypt(fresh, context));
  assert.throws(() => withBoth.decrypt(existing, { ...context, serverId: 'server-2' }));
  assert.throws(() => new McpCrypto(configOf({})).encrypt('x', context), /MCP 令牌加密未配置/);
}

function draftSandboxCompatibility() {
  const build = (values: Record<string, string | undefined>) => new DraftRunService(
    {} as never,
    {} as never,
    {} as never,
    configOf(values),
  );
  const crypt = (service: DraftRunService) => service as unknown as {
    encrypt(plaintext: string, userId: string): string;
    decrypt(payload: string, userId: string): string;
  };

  const withBoth = crypt(build({
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET,
    DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET,
  }));
  const legacyOnly = crypt(build({ DIFY_KEY_ENCRYPTION_SECRET: LEGACY_SECRET }));
  const primaryOnly = crypt(build({ MEDIA_CREDENTIAL_ENCRYPTION_SECRET: MEDIA_SECRET }));

  const existing = legacyEncrypt(LEGACY_SECRET, 'draft-app-key', Buffer.from('draft-sandbox:user-a'));
  assert.equal(withBoth.decrypt(existing, 'user-a'), 'draft-app-key', '草稿沙箱存量凭据必须仍可读');

  const fresh = withBoth.encrypt('draft-app-key', 'user-a');
  assert.equal(primaryOnly.decrypt(fresh, 'user-a'), 'draft-app-key');
  assert.throws(() => legacyOnly.decrypt(fresh, 'user-a'));
  assert.throws(() => withBoth.decrypt(existing, 'user-b'), 'AAD 绑定 userId 仍然生效');
  assert.throws(() => crypt(build({})).encrypt('x', 'user-a'), /草稿沙箱凭据加密未配置/);
}

function main() {
  keyRingHelpers();
  mediaCredentialCompatibility();
  mcpTokenCompatibility();
  draftSandboxCompatibility();
  console.log('加密密钥环测试通过: 可用性判定 / 环顺序与去重 / primary 回退 / 缺配置报错 / '
    + '载荷形状 / AAD 认证 / 媒体凭据 / MCP 令牌 / 草稿沙箱（存量可读 + 新写用 primary）');
}

main();
