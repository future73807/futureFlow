import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { MediaProvider } from '../database/entities/media-credential.entity';

@Injectable()
export class MediaCredentialCrypto {
  constructor(private readonly config: ConfigService) {}

  encrypt(
    plaintext: string,
    context: { userId: string; provider: MediaProvider; credentialId: string },
  ): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(this.aad(context));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, encrypted]
      .map((part) => typeof part === 'string' ? part : part.toString('base64url'))
      .join(':');
  }

  decrypt(
    payload: string,
    context: { userId: string; provider: MediaProvider; credentialId: string },
  ): string {
    const [version, ivRaw, tagRaw, ciphertextRaw, extra] = payload.split(':');
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw || extra) {
      throw new ServiceUnavailableException('媒体凭据不可用');
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
      throw new ServiceUnavailableException('媒体凭据不可用');
    }
  }

  fingerprint(apiKey: string): string {
    return `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  }

  private key(): Buffer {
    const secret = this.config.get<string>('MEDIA_CREDENTIAL_ENCRYPTION_SECRET')
      || this.config.get<string>('DIFY_KEY_ENCRYPTION_SECRET')
      || '';
    if (
      secret.length < 32
      || /change-me|replace-with|your[-_ ]?(key|secret)|x{6,}/i.test(secret)
    ) {
      throw new ServiceUnavailableException('媒体凭据加密未配置');
    }
    return createHash('sha256').update(secret, 'utf8').digest();
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
