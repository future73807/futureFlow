import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptWithKeyRing,
  encryptAesGcm,
  parseAesGcmPayload,
  resolveEncryptionKeyRing,
} from '../common/encryption-key-ring';

/**
 * MCP 服务器 Bearer 令牌的对称加密。
 *
 * 密钥派生与媒体凭据共用同一套密钥环工具（见 common/encryption-key-ring.ts）：
 * 主密钥是 MEDIA_CREDENTIAL_ENCRYPTION_SECRET，DIFY_KEY_ENCRYPTION_SECRET 只作
 * 只读回退（历史数据的默认密钥）；AAD 绑定 userId + serverId 防止密文在记录间挪用。
 */
@Injectable()
export class McpCrypto {
  constructor(private readonly config: ConfigService) {}

  encrypt(plaintext: string, context: { userId: string; serverId: string }): string {
    // 加密恒用密钥环第一把（primary），回退密钥只负责解开存量密文。
    return encryptAesGcm(this.keyRing()[0], plaintext, this.aad(context));
  }

  decrypt(payload: string, context: { userId: string; serverId: string }): string {
    const parts = parseAesGcmPayload(payload);
    if (!parts) {
      throw new ServiceUnavailableException('MCP 服务器令牌不可用');
    }
    try {
      return decryptWithKeyRing(this.keyRing(), parts, this.aad(context));
    } catch {
      throw new ServiceUnavailableException('无法解密 MCP 服务器令牌，请重新保存');
    }
  }

  private aad(context: { userId: string; serverId: string }): Buffer {
    return Buffer.from(`mcp-server:${context.userId}:${context.serverId}`, 'utf8');
  }

  private keyRing(): Buffer[] {
    return resolveEncryptionKeyRing(this.config, {
      primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET',
      legacy: ['DIFY_KEY_ENCRYPTION_SECRET'],
      purpose: 'MCP 令牌',
    });
  }
}
