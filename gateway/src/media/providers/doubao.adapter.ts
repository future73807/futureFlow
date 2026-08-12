import { Injectable } from '@nestjs/common';
import {
  ImageGenerationInput,
  MediaProviderAdapter,
  ProviderMediaSource,
  ProviderVideoResult,
  VideoGenerationInput,
} from '../media.types';
import { ProviderHttpClient } from '../provider-http.client';
import { firstSource, normalizedStatus, record, requiredTaskId } from './provider-utils';

@Injectable()
export class DoubaoMediaAdapter implements MediaProviderAdapter {
  readonly provider = 'doubao' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async createImage(apiKey: string, input: ImageGenerationInput): Promise<ProviderMediaSource> {
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: input.model,
        prompt: input.prompt,
        response_format: 'url',
        ...(input.size ? { size: input.size } : {}),
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
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: input.model,
        content: [{ type: 'text', text: input.prompt }],
        ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
        ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
      },
    }));
    return { taskId: requiredTaskId(response.id), status: 'queued' };
  }

  async getVideoStatus(apiKey: string, taskId: string): Promise<ProviderVideoResult> {
    const safeId = requiredTaskId(taskId);
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'GET',
      url: `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${encodeURIComponent(safeId)}`,
      headers: { authorization: `Bearer ${apiKey}` },
    }));
    const status = normalizedStatus(response.status);
    const content = record(response.content || record(response.output).content);
    return {
      taskId: safeId,
      status,
      ...(status === 'succeeded'
        ? { source: firstSource([{ url: content.video_url || response.video_url }]) }
        : {}),
    };
  }
}
