import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * MCP 服务器 Bearer 令牌的对称加密。
 * 密钥派生与媒体凭据一致（DIFY_KEY_ENCRYPTION_SECRET 优先），
 * AAD 绑定 userId + serverId 防止密文在记录间挪用。
 */
@Injectable()
export class McpCrypto {
  constructor(private readonly config: ConfigService) {}

  encrypt(plaintext: string, context: { userId: string; serverId: string }): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(this.aad(context));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  decrypt(payload: string, context: { userId: string; serverId: string }): string {
    const [version, ivRaw, tagRaw, ciphertextRaw, extra] = payload.split(':');
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw || extra) {
      throw new ServiceUnavailableException('MCP 服务器令牌不可用');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(),
        Buffer.from(ivRaw, 'base64url'),
      );
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('无法解密 MCP 服务器令牌，请重新保存');
    }
  }

  private aad(context: { userId: string; serverId: string }): Buffer {
    return Buffer.from(`mcp-server:${context.userId}:${context.serverId}`, 'utf8');
  }

  private key(): Buffer {
    const secret = this.config.get<string>('MEDIA_CREDENTIAL_ENCRYPTION_SECRET')
      || this.config.get<string>('DIFY_KEY_ENCRYPTION_SECRET')
      || '';
    if (
      secret.length < 32
      || /change-me|replace-with|your[-_ ]?(key|secret)|x{6,}/i.test(secret)
    ) {
      throw new ServiceUnavailableException('MCP 令牌加密未配置');
    }
    return createHash('sha256').update(secret).digest();
  }
}
