import { Injectable } from '@nestjs/common';
import {
  ImageGenerationInput,
  MediaProviderAdapter,
  ProviderMediaSource,
  ProviderVideoResult,
  VideoGenerationInput,
} from '../media.types';
import { ProviderHttpClient } from '../provider-http.client';
import { firstSource, record, requiredTaskId, stringValue } from './provider-utils';

const GOOGLE_GENERATIVE_LANGUAGE_ORIGIN = 'https://generativelanguage.googleapis.com';

function optionalGoogleImageSize(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  // Interactions accepts image-size tokens, rather than the generic WxH values
  // used by the canvas. Only forward values documented for this API; omitting
  // the option lets the selected model choose its supported default.
  return ['0.5K', '1K', '2K', '4K'].includes(normalized) ? normalized : undefined;
}

function optionalGoogleAspectRatio(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  return normalized && normalized.toLowerCase() !== 'auto' ? normalized : undefined;
}

function googleDownloadHeaders(url: string, apiKey: string): Readonly<Record<string, string>> | undefined {
  try {
    // Gemini's generated-media URIs can require the API key. Never attach that
    // credential to a non-Google host returned in a response.
    return new URL(url).origin === GOOGLE_GENERATIVE_LANGUAGE_ORIGIN
      ? { 'x-goog-api-key': apiKey }
      : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class GoogleMediaAdapter implements MediaProviderAdapter {
  readonly provider = 'google' as const;

  constructor(private readonly http: ProviderHttpClient) {}

  async createImage(apiKey: string, input: ImageGenerationInput): Promise<ProviderMediaSource> {
    const imageSize = optionalGoogleImageSize(input.size);
    const aspectRatio = optionalGoogleAspectRatio(input.aspectRatio);
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: { 'x-goog-api-key': apiKey },
      body: {
        model: input.model,
        input: [{ type: 'text', text: input.prompt }],
        response_format: {
          type: 'image',
          mime_type: 'image/png',
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(imageSize ? { image_size: imageSize } : {}),
        },
      },
    }));
    const steps = Array.isArray(response.steps) ? response.steps.map(record) : [];
    const candidates: Array<{ data?: unknown; url?: unknown; mimeType?: unknown }> = [];
    for (const step of steps) {
      // REST Interaction responses use a model_output step directly. Retain
      // the nested alternatives for compatibility with earlier SDK-shaped data.
      const output = record(step.model_output || step.output);
      const content = [
        ...(Array.isArray(step.content) ? step.content.map(record) : []),
        ...(Array.isArray(output.content) ? output.content.map(record) : []),
      ];
      for (const item of content) {
        const image = record(item.image || item.inline_data || item.inlineData);
        candidates.push({
          data: image.data || item.data,
          url: image.uri || image.url || item.uri || item.url,
          mimeType: image.mime_type || image.mimeType || item.mime_type || item.mimeType,
        });
      }
    }
    const outputImage = record(response.output_image || response.outputImage);
    if (Object.keys(outputImage).length) {
      candidates.push({
        data: outputImage.data,
        url: outputImage.uri || outputImage.url,
        mimeType: outputImage.mime_type || outputImage.mimeType,
      });
    }
    // Compatibility with generateContent-shaped responses while the API evolves.
    const responseCandidates = Array.isArray(response.candidates) ? response.candidates.map(record) : [];
    for (const candidate of responseCandidates) {
      const parts = Array.isArray(record(candidate.content).parts)
        ? record(candidate.content).parts.map(record)
        : [];
      for (const part of parts) {
        const inline = record(part.inlineData || part.inline_data);
        candidates.push({ data: inline.data, mimeType: inline.mimeType || inline.mime_type });
      }
    }
    const source = firstSource(candidates);
    if (source.type !== 'url') return source;
    const headers = googleDownloadHeaders(source.url, apiKey);
    return headers ? { ...source, headers } : source;
  }

  async createVideo(apiKey: string, input: VideoGenerationInput): Promise<ProviderVideoResult> {
    const model = encodeURIComponent(input.model);
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`,
      headers: { 'x-goog-api-key': apiKey },
      body: {
        instances: [{ prompt: input.prompt }],
        parameters: {
          sampleCount: 1,
          ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
          ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        },
      },
    }));
    return { taskId: requiredTaskId(response.name), status: 'queued' };
  }

  async getVideoStatus(apiKey: string, taskId: string): Promise<ProviderVideoResult> {
    const safeId = requiredTaskId(taskId).replace(/^v1beta\//, '');
    const path = safeId.split('/').map(encodeURIComponent).join('/');
    const response = record(await this.http.requestJson({
      provider: this.provider,
      method: 'GET',
      url: `https://generativelanguage.googleapis.com/v1beta/${path}`,
      headers: { 'x-goog-api-key': apiKey },
    }));
    if (!response.done) return { taskId: safeId, status: 'processing' };
    if (response.error) return { taskId: safeId, status: 'failed' };
    const generated = record(record(response.response).generateVideoResponse);
    const samples = Array.isArray(generated.generatedSamples)
      ? generated.generatedSamples.map(record)
      : [];
    const url = samples.map((item) => stringValue(record(item.video).uri, 8192)).find(Boolean);
    const source = firstSource([{ url }]);
    if (source.type === 'url') {
      const headers = googleDownloadHeaders(source.url, apiKey);
      return {
        taskId: safeId,
        status: 'succeeded',
        source: headers ? { ...source, headers } : source,
      };
    }
    return {
      taskId: safeId,
      status: 'succeeded',
      source,
    };
  }
}
