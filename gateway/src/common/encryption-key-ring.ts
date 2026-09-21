import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 对称加密的共享件：密钥环 + AES-256-GCM 载荷编解码。
 *
 * 之所以抽出来：平台里有三类租户级密文（媒体凭据、MCP Bearer 令牌、草稿沙箱
 * 凭据）此前各自复制了一份「取一个密钥 → 加解密」的实现，且都按
 * `MEDIA_CREDENTIAL_ENCRYPTION_SECRET || DIFY_KEY_ENCRYPTION_SECRET` 的顺序
 * 回落。后果是：只要没显式配置前一个变量（`env:init` 原本就不生成它），三类
 * 密文与 Dify 凭据就共用同一把主密钥——一把泄露等于全解，也失去了分层的意义。
 *
 * 这里改成**密钥环**：加密恒用第一把（primary），解密按顺序逐个尝试，于是
 * 「新增独立密钥」不会让存量密文变成不可读，部署方可以随时收紧而不必先做数据迁移。
 */

/** 低于该长度或形如示例值的密钥一律视为未配置。 */
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_PATTERN = /change-me|replace-with|your[-_ ]?(key|secret)|x{6,}/i;

const PAYLOAD_VERSION = 'v1';
/** 编码沿用既有约定（base64url），保证与历史密文格式一致。 */
const PAYLOAD_ENCODING = 'base64url' as const;

export function isUsableEncryptionSecret(secret?: string | null): boolean {
  const value = (secret ?? '').trim();
  return value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER_PATTERN.test(value);
}

/** 由口令派生 32 字节密钥（与历史实现一致，勿改——改了存量密文就解不开）。 */
export function deriveAesKey(secret: string): Buffer {
  return createHash('sha256').update(secret.trim(), 'utf8').digest();
}

export interface EncryptionKeyRingOptions {
  /** 加密使用、解密优先尝试的密钥变量名。 */
  primary: string;
  /**
   * 只读回退的密钥变量名，按顺序尝试。
   *
   * 存在的唯一理由：让存量密文在 primary 被新配置后仍可解密。不要为了「统一」
   * 而删掉——那会让所有已加密数据在升级瞬间变成不可读。
   */
  legacy: string[];
  /** 报错文案主体，最终形如「<purpose>加密未配置」。 */
  purpose: string;
}

/**
 * 读出密钥环（至少一把）。顺序即优先级，重复值会去重。
 *
 * 不可用的值（过短/示例值）直接跳过：宁可回退到 legacy，也不要因为部署方填了
 * 半个值就让整个功能不可用。
 */
export function resolveEncryptionKeyRing(
  config: ConfigService,
  options: EncryptionKeyRingOptions,
): Buffer[] {
  const secrets = [options.primary, ...options.legacy]
    .map((name) => (config.get<string>(name) ?? '').trim())
    .filter(isUsableEncryptionSecret);
  const unique = [...new Set(secrets)];
  if (!unique.length) {
    throw new ServiceUnavailableException(`${options.purpose}加密未配置`);
  }
  return unique.map(deriveAesKey);
}

export interface AesGcmPayloadParts {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** 解析 `v1:iv:tag:ciphertext` 形状；形状不符返回 null（由调用方决定报错文案）。 */
export function parseAesGcmPayload(payload: string): AesGcmPayloadParts | null {
  const [version, iv, authTag, ciphertext, extra] = String(payload ?? '').split(':');
  if (version !== PAYLOAD_VERSION || !iv || !authTag || !ciphertext || extra) return null;
  return { iv, authTag, ciphertext };
}

export function encryptAesGcm(key: Buffer, plaintext: string, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PAYLOAD_VERSION,
    iv.toString(PAYLOAD_ENCODING),
    cipher.getAuthTag().toString(PAYLOAD_ENCODING),
    ciphertext.toString(PAYLOAD_ENCODING),
  ].join(':');
}

/**
 * 按密钥环顺序尝试解密，全部失败则抛出最后一个错误。
 *
 * AAD 始终参与认证：环里换了一把密钥并不会削弱「密文不能跨记录搬移」这条性质，
 * 因为 AAD 校验失败与密钥不匹配都会让 GCM 认证失败。
 */
export function decryptWithKeyRing(
  ring: Buffer[],
  parts: AesGcmPayloadParts,
  aad: Buffer,
): string {
  let failure: unknown = new Error('empty key ring');
  for (const key of ring) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts.iv, PAYLOAD_ENCODING));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(parts.authTag, PAYLOAD_ENCODING));
      return Buffer.concat([
        decipher.update(Buffer.from(parts.ciphertext, PAYLOAD_ENCODING)),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
