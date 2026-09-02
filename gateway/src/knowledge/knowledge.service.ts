import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DifyConsoleAuthorization, DifyIntegrationService } from '../dify/dify-integration.service';

export interface KnowledgeDatasetSummary {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  wordCount: number;
}

export interface KnowledgeDocumentSummary {
  id: string;
  name: string;
  indexingStatus: string;
  enabled: boolean;
  wordCount: number;
  error: string | null;
}

interface ConsoleJsonInit {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * 知识库管理服务。
 * dataset 层走受控 Dify Console 会话；文档层走 Dify Service API
 * （dataset 专属 `dataset-` API Key，由本服务按需创建）。
 * futureFlow 不落库存储知识内容，只做转发与状态呈现。
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly dify: DifyIntegrationService,
    private readonly config: ConfigService,
  ) {}

  async isEnabled(): Promise<boolean> {
    return this.dify.resolveConsoleAuthorization() !== null;
  }

  async listDatasets(): Promise<KnowledgeDatasetSummary[]> {
    const data = await this.consoleJson<any>('/datasets?page=1&limit=100');
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((row: any) => ({
      id: String(row.id || ''),
      name: String(row.name || ''),
      description: String(row.description || ''),
      documentCount: Number(row.document_count || 0),
      wordCount: Number(row.word_count || 0),
    }));
  }

  async createDataset(name: string, description: string): Promise<KnowledgeDatasetSummary> {
    const row = await this.consoleJson<any>('/datasets', {
      method: 'POST',
      body: {
        name,
        description,
        // economy（关键词索引）不依赖 embedding 供应商，保证默认一键部署可用。
        indexing_technique: 'economy',
        permission: 'only_me',
      },
    });
    if (!row?.id) {
      throw new ServiceUnavailableException('Dify 未返回新建知识库的 ID');
    }
    return {
      id: String(row.id),
      name: String(row.name || name),
      description: String(row.description || description || ''),
      documentCount: Number(row.document_count || 0),
      wordCount: Number(row.word_count || 0),
    };
  }

  async deleteDataset(datasetId: string): Promise<void> {
    await this.consoleJson(`/datasets/${encodeURIComponent(datasetId)}`, { method: 'DELETE' });
  }

  async listDocuments(datasetId: string): Promise<KnowledgeDocumentSummary[]> {
    const data = await this.datasetApiJson<any>(
      `/datasets/${encodeURIComponent(datasetId)}/documents?page=1&limit=100`,
    );
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((row: any) => ({
      id: String(row.id || ''),
      name: String(row.name || ''),
      indexingStatus: String(row.indexing_status || ''),
      enabled: row.enabled !== false,
      wordCount: Number(row.word_count || 0),
      error: row.error ? String(row.error) : null,
    }));
  }

  async createDocumentByText(datasetId: string, name: string, text: string): Promise<KnowledgeDocumentSummary> {
    const row = await this.datasetApiJson<any>(
      `/datasets/${encodeURIComponent(datasetId)}/document/create-by-text`,
      {
        method: 'POST',
        body: {
          name,
          text,
          indexing_technique: 'economy',
          process_rule: { mode: 'automatic' },
        },
        timeoutMs: 30_000,
      },
    );
    const doc = row?.document || row || {};
    return {
      id: String(doc.id || ''),
      name: String(doc.name || name),
      indexingStatus: String(doc.indexing_status || 'waiting'),
      enabled: doc.enabled !== false,
      wordCount: Number(doc.word_count || 0),
      error: doc.error ? String(doc.error) : null,
    };
  }

  async deleteDocument(datasetId: string, documentId: string): Promise<void> {
    await this.datasetApiJson(
      `/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * 获取可用的 Dify Dataset API Key（`dataset-` 前缀）。
   * Console 0.15.3 没有给已有 dataset 添加文档的接口，文档操作必须走
   * Service API；Key 复用第一个已启用的，没有则自动创建一个。
   */
  private async datasetApiKey(): Promise<string> {
    const auth = await this.authorization();
    const listResponse = await this.consoleFetchRaw(`${auth.consoleBase}/datasets/api-keys`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (listResponse.ok) {
      const list = await listResponse.json().catch(() => ({})) as any;
      const items = Array.isArray(list?.data) ? list.data : [];
      const existing = items.find((item: any) => item?.token && item?.disabled !== true);
      if (existing?.token) return String(existing.token);
    }
    const createdResponse = await this.consoleFetchRaw(`${auth.consoleBase}/datasets/api-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!createdResponse.ok) {
      throw new ServiceUnavailableException(
        `创建 Dify 知识库 API Key 失败（HTTP ${createdResponse.status}）`,
      );
    }
    const created = await createdResponse.json().catch(() => ({})) as any;
    if (!created?.token) {
      throw new ServiceUnavailableException('Dify 未返回知识库 API Key');
    }
    return String(created.token);
  }

  private serviceApiBase(): string {
    return String(this.config.get<string>('DIFY_API_BASE') || 'http://localhost:5001/v1').replace(/\/+$/, '');
  }

  private async datasetApiJson<T = unknown>(path: string, init: ConsoleJsonInit = {}): Promise<T> {
    const token = await this.datasetApiKey();
    let response: Response;
    try {
      response = await fetch(`${this.serviceApiBase()}${path}`, {
        method: init.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs || 15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Service API 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BadRequestException(
        `Dify 知识库请求失败（HTTP ${response.status}）：${detail.slice(0, 200)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async consoleFetchRaw(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
  }

  private async authorization(): Promise<DifyConsoleAuthorization> {
    const auth = await this.dify.resolveConsoleAuthorization();
    if (!auth) {
      throw new ServiceUnavailableException(
        'Dify 授权未配置，请先在管理后台完成 Dify 授权或使用一键启动自动初始化',
      );
    }
    return auth;
  }

  private async consoleJson<T = unknown>(path: string, init: ConsoleJsonInit = {}, retry = true): Promise<T> {
    const auth = await this.authorization();
    const method = init.method || 'GET';
    let response: Response;
    try {
      response = await fetch(`${auth.consoleBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs || 15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }

    if ((response.status === 401 || response.status === 403) && retry) {
      const refreshed = await this.dify.refreshConsoleAuthorization(auth);
      if (refreshed) {
        return this.consoleJson<T>(path, init, false);
      }
      throw new ServiceUnavailableException('Dify Console 授权已过期，请重新保存 Dify 授权');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BadRequestException(
        `Dify 知识库请求失败（HTTP ${response.status}）：${detail.slice(0, 200)}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : '未知错误';
  }
}
