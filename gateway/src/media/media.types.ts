import type { MediaProvider } from '../database/entities/media-credential.entity';

export type ProviderMediaSource =
  | { type: 'base64'; data: string; mimeType?: string }
  | { type: 'url'; url: string; headers?: Readonly<Record<string, string>> };

export interface ImageGenerationInput {
  model: string;
  prompt: string;
  size?: string;
  aspectRatio?: string;
  quality?: string;
}

export interface VideoGenerationInput extends ImageGenerationInput {
  durationSeconds?: number;
  resolution?: string;
}

export interface ProviderVideoResult {
  taskId: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  source?: ProviderMediaSource;
}

export interface MediaProviderAdapter {
  readonly provider: MediaProvider;
  createImage(apiKey: string, input: ImageGenerationInput): Promise<ProviderMediaSource>;
  createVideo(apiKey: string, input: VideoGenerationInput): Promise<ProviderVideoResult>;
  getVideoStatus(apiKey: string, taskId: string): Promise<ProviderVideoResult>;
}

export interface ProviderJsonRequest {
  provider: MediaProvider;
  method: 'GET' | 'POST';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  formData?: FormData;
}

export interface ProviderHttpTransport {
  requestJson<T = unknown>(request: ProviderJsonRequest): Promise<T>;
}

export class ProviderContractError extends Error {
  constructor(
    readonly code:
      | 'provider_http_error'
      | 'provider_timeout'
      | 'provider_invalid_response'
      | 'provider_rejected'
      | 'unsupported_provider',
  ) {
    super(code);
    this.name = 'ProviderContractError';
  }
}
