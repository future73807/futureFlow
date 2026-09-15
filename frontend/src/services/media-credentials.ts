import { apiJson } from '../utils/api';

export const MEDIA_CREDENTIAL_PROVIDERS = ['openai', 'google', 'doubao', 'minimax'] as const;
export type MediaProvider = (typeof MEDIA_CREDENTIAL_PROVIDERS)[number];

export interface MediaCredentialSummary {
  id: string;
  provider: MediaProvider;
  label: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMediaCredentialInput {
  provider: MediaProvider;
  label: string;
  /**
   * 只在新建凭据时临时提交给网关。调用方不得把它写入 FlowGram 表单字段。
   */
  apiKey: string;
}

// 与网关的 DTO、发布转换器保持一致；数据库生成的是 UUID v4，但这里也兼容
// 已存在的 RFC 4122 v1-v5 标识，避免读取历史工作流时误判。
const MEDIA_CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMediaCredentialId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_CREDENTIAL_ID.test(value.trim());
}

function isMediaProvider(value: unknown): value is MediaProvider {
  return typeof value === 'string' && (MEDIA_CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 仅保留画布选择器需要的公开字段。即使服务端意外附带敏感属性，前端内存中的
 * 可选凭据对象也不会保留 API Key 或密文。
 */
export function parseMediaCredentialSummaries(payload: unknown): MediaCredentialSummary[] {
  if (!Array.isArray(payload)) {
    throw new Error('媒体凭据列表响应格式无效');
  }

  return payload.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个媒体凭据格式无效`);
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const provider = row.provider;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint.trim() : '';
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : '';
    const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : '';

    if (!isMediaCredentialId(id) || !isMediaProvider(provider) || !label) {
      throw new Error(`第 ${index + 1} 个媒体凭据数据不完整`);
    }

    return { id, provider, label, fingerprint, createdAt, updatedAt };
  });
}

export async function listMediaCredentials(): Promise<MediaCredentialSummary[]> {
  const payload = await apiJson<unknown>('/media/credentials');
  return parseMediaCredentialSummaries(payload);
}

export async function createMediaCredential(
  input: CreateMediaCredentialInput,
): Promise<MediaCredentialSummary> {
  const payload = await apiJson<unknown>('/media/credentials', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseMediaCredentialSummaries([payload])[0];
}
