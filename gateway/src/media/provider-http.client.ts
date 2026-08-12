import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaProvider } from '../database/entities/media-credential.entity';
import {
  ProviderContractError,
  ProviderHttpTransport,
  ProviderJsonRequest,
} from './media.types';

export const PROVIDER_API_ORIGINS: Readonly<Record<MediaProvider, string>> = {
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  doubao: 'https://ark.cn-beijing.volces.com',
  minimax: 'https://api.minimaxi.com',
};

@Injectable()
export class ProviderHttpClient implements ProviderHttpTransport {
  constructor(private readonly config: ConfigService) {}

  async requestJson<T>(request: ProviderJsonRequest): Promise<T> {
    const url = this.assertAllowedUrl(request.provider, request.url);
    const timeoutMs = Number.parseInt(
      this.config.get<string>('MEDIA_PROVIDER_TIMEOUT_MS', '120000'),
      10,
    );
    const maxBytes = Number.parseInt(
      this.config.get<string>('MEDIA_PROVIDER_JSON_MAX_BYTES', '41943040'),
      10,
    );
    const headers = new Headers(request.headers);
    let body: BodyInit | undefined;
    if (request.formData) {
      body = request.formData;
      // fetch must add the multipart boundary itself.
      headers.delete('content-type');
    } else if (request.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ProviderContractError('provider_timeout');
      }
      throw new ProviderContractError('provider_http_error');
    }

    if (!response.ok) {
      // Deliberately do not read or surface provider bodies: they can echo keys,
      // signed URLs or user prompts.
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderContractError('provider_rejected');
    }

    const raw = await this.readLimited(response, maxBytes);
    try {
      return JSON.parse(raw.toString('utf8')) as T;
    } catch {
      throw new ProviderContractError('provider_invalid_response');
    }
  }

  private assertAllowedUrl(provider: MediaProvider, raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderContractError('provider_http_error');
    }
    if (
      url.origin !== PROVIDER_API_ORIGINS[provider]
      || url.username
      || url.password
      || url.hash
    ) {
      throw new ProviderContractError('provider_http_error');
    }
    return url;
  }

  private async readLimited(response: Response, maxBytes: number): Promise<Buffer> {
    const length = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (length > maxBytes) throw new ProviderContractError('provider_invalid_response');
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new ProviderContractError('provider_invalid_response');
        }
        chunks.push(Buffer.from(result.value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock();
    }
  }
}
