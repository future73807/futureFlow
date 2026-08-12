import { ProviderContractError, ProviderMediaSource } from '../media.types';

export function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function stringValue(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

export function requiredTaskId(value: unknown): string {
  const id = stringValue(value, 512);
  if (
    !id
    || !/^[A-Za-z0-9._:/-]+$/.test(id)
    || id.startsWith('/')
    || id.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new ProviderContractError('provider_invalid_response');
  }
  return id;
}

export function firstSource(
  candidates: Array<{ data?: unknown; url?: unknown; mimeType?: unknown }>,
): ProviderMediaSource {
  for (const candidate of candidates) {
    const data = stringValue(candidate.data, 60_000_000);
    if (data) {
      return {
        type: 'base64',
        data,
        mimeType: stringValue(candidate.mimeType, 100),
      };
    }
    const url = stringValue(candidate.url, 8192);
    if (url) return { type: 'url', url };
  }
  throw new ProviderContractError('provider_invalid_response');
}

export function normalizedStatus(value: unknown): 'queued' | 'processing' | 'succeeded' | 'failed' {
  const status = String(value || '').trim().toLowerCase().replace(/[ -]/g, '_');
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) return 'succeeded';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(status)) return 'failed';
  if (['queued', 'pending', 'created', 'submitted'].includes(status)) return 'queued';
  return 'processing';
}
