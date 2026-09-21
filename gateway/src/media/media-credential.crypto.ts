import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  decryptWithKeyRing,
  encryptAesGcm,
  parseAesGcmPayload,
  resolveEncryptionKeyRing,
} from '../common/encryption-key-ring';
import type { MediaProvider } from '../database/entities/media-credential.entity';

@Injectable()
export class MediaCredentialCrypto {
  constructor(private readonly config: ConfigService) {}

  encrypt(
    plaintext: string,
    context: { userId: string; provider: MediaProvider; credentialId: string },
  ): string {
    // 加密恒用密钥环第一把（primary），回退密钥只负责解开存量密文。
    return encryptAesGcm(this.keyRing()[0], plaintext, this.aad(context));
  }

  decrypt(
    payload: string,
    context: { userId: string; provider: MediaProvider; credentialId: string },
  ): string {
    const parts = parseAesGcmPayload(payload);
    if (!parts) throw new ServiceUnavailableException('媒体凭据不可用');
    try {
      return decryptWithKeyRing(this.keyRing(), parts, this.aad(context));
    } catch {
      throw new ServiceUnavailableException('媒体凭据不可用');
    }
  }

  fingerprint(apiKey: string): string {
    return `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  }

  /**
   * 密钥环：`MEDIA_CREDENTIAL_ENCRYPTION_SECRET` 为主，`DIFY_KEY_ENCRYPTION_SECRET`
   * 仅作**只读回退**——后者是历史默认（`env:init` 以前不生成前者），删掉它会让存量
   * 密文立刻不可解密。详见 common/encryption-key-ring.ts。
   */
  private keyRing(): Buffer[] {
    return resolveEncryptionKeyRing(this.config, {
      primary: 'MEDIA_CREDENTIAL_ENCRYPTION_SECRET',
      legacy: ['DIFY_KEY_ENCRYPTION_SECRET'],
      purpose: '媒体凭据',
    });
  }

  private aad(context: {
    userId: string;
    provider: MediaProvider;
    credentialId: string;
  }): Buffer {
    return Buffer.from(
      `futureflow-media-v1\0${context.userId}\0${context.provider}\0${context.credentialId}`,
      'utf8',
    );
  }
}
