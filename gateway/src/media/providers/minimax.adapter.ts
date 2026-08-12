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

function h3Resolution(value: string | undefined): '768P' | '2K' {
  const normalized = String(value || '').trim().toLowerCase();
  // Preserve compatibility with the original generic UI values while emitting
  // only the current H3 contract values.
  if (['2k', '1080p'].includes(normalized)) return '2K';
  return '768P';
}

function h3Duration(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || value < 4 || value > 15) {
    // H3 accepts whole seconds from 4 through 15. Failing before the outbound
    // call prevents an invalid paid task request from being sent.
    throw new ProviderContractError('provider_rejected');
  }
  return value;
}

function h3Ratio(value: string | undefined): string {
  const normalized = String(value || '').trim();
  return ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(normalized)
    ? normalized
    : '16:9';
}

@Injectable()
export class MiniMaxMediaAdapter implements MediaProviderAdapter {
  readonly provider = 'minimax' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async createImage(apiKey: string, input: ImageGenerationInput): Promise<ProviderMediaSource> {
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://api.minimaxi.com/v1/image_generation',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: input.model,
        prompt: input.prompt,
        response_format: 'url',
        n: 1,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      },
    }));
    const data = record(response.data);
    const urls = Array.isArray(data.image_urls) ? data.image_urls : [data.image_urls];
    const base64 = Array.isArray(data.image_base64) ? data.image_base64 : [data.image_base64];
    return firstSource([
      ...base64.map((item) => ({ data: item, mimeType: 'image/png' })),
      ...urls.map((item) => ({ url: item })),
    ]);
  }

  async createVideo(apiKey: string, input: VideoGenerationInput): Promise<ProviderVideoResult> {
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://api.minimaxi.com/v2/video_generation',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: input.model,
        content: [{ type: 'text', text: input.prompt }],
        resolution: h3Resolution(input.resolution || input.size),
        duration: h3Duration(input.durationSeconds),
        ratio: h3Ratio(input.aspectRatio),
      },
    }));
    return { taskId: requiredTaskId(response.task_id), status: 'queued' };
  }

  async getVideoStatus(apiKey: string, taskId: string): Promise<ProviderVideoResult> {
    const safeId = requiredTaskId(taskId);
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'GET',
      url: `https://api.minimaxi.com/v2/query/video_generation/${encodeURIComponent(safeId)}`,
      headers: { authorization: `Bearer ${apiKey}` },
    }));
    const task = record(response.task);
    const content = record(task.content || response.content);
    const status = normalizedStatus(task.status || response.status);
    return {
      taskId: safeId,
      status,
      ...(status === 'succeeded'
        ? { source: firstSource([{ url: content.url || response.file_url }]) }
        : {}),
    };
  }
}
