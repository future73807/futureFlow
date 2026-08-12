import { Injectable } from '@nestjs/common';
import {
  ImageGenerationInput,
  MediaProviderAdapter,
  ProviderContractError,
  ProviderMediaSource,
  ProviderVideoResult,
  VideoGenerationInput,
} from '../media.types';
import { ProviderHttpClient } from '../provider-http.client';
import { firstSource, normalizedStatus, record, requiredTaskId } from './provider-utils';

@Injectable()
export class OpenAiMediaAdapter implements MediaProviderAdapter {
  readonly provider = 'openai' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async createImage(apiKey: string, input: ImageGenerationInput): Promise<ProviderMediaSource> {
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://api.openai.com/v1/images/generations',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: input.model,
        prompt: input.prompt,
        n: 1,
        ...(input.size ? { size: input.size } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
      },
    }));
    const images = Array.isArray(response.data) ? response.data.map(record) : [];
    return firstSource(images.map((item) => ({
      data: item.b64_json,
      url: item.url,
      mimeType: 'image/png',
    })));
  }

  async createVideo(apiKey: string, input: VideoGenerationInput): Promise<ProviderVideoResult> {
    const formData = new FormData();
    formData.set('model', input.model);
    formData.set('prompt', input.prompt);
    if (input.size) formData.set('size', input.size);
    if (input.durationSeconds) formData.set('seconds', String(input.durationSeconds));
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://api.openai.com/v1/videos',
      headers: { authorization: `Bearer ${apiKey}` },
      formData,
    }));
    const taskId = requiredTaskId(response.id);
    return { taskId, status: normalizedStatus(response.status || 'queued') };
  }

  async getVideoStatus(apiKey: string, taskId: string): Promise<ProviderVideoResult> {
    const safeId = requiredTaskId(taskId);
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'GET',
      url: `https://api.openai.com/v1/videos/${encodeURIComponent(safeId)}`,
      headers: { authorization: `Bearer ${apiKey}` },
    }));
    const status = normalizedStatus(response.status);
    const result: ProviderVideoResult = { taskId: safeId, status };
    if (status === 'succeeded') {
      result.source = {
        type: 'url',
        url: `https://api.openai.com/v1/videos/${encodeURIComponent(safeId)}/content`,
        headers: { authorization: `Bearer ${apiKey}` },
      };
    }
    if (status === 'succeeded' && !result.source) {
      throw new ProviderContractError('provider_invalid_response');
    }
    return result;
  }
}
