import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { DifyConsoleAuthorization, DifyConsoleAuthorizationError, DifyIntegrationService } from '../dify/dify-integration.service';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import { DraftSandbox } from '../database/entities/draft-sandbox.entity';

export interface DraftSandboxTarget {
  appId: string;
  apiKey: string;
  reused: boolean;
}

interface ConsoleInit {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * 草稿云端试运行沙箱：每个用户一个专属 Dify 工作流应用。
 * 草稿被转换为 Dify DSL 后导入并发布到沙箱应用，随后复用标准执行
 * 链路（SSE/计费/运行记录）真实执行。DSL 摘要一致时跳过导入与发布。
 */
@Injectable()
export class DraftRunService {
  /** 同一用户并发点击时串行化沙箱准备，避免重复导入互相覆盖。 */
  private readonly prepareLocks = new Map<string, Promise<DraftSandboxTarget>>();

  constructor(
    @InjectRepository(DraftSandbox)
    private readonly repo: Repository<DraftSandbox>,
    private readonly dify: DifyIntegrationService,
    private readonly converter: DifyConverterService,
    private readonly config: ConfigService,
  ) {}

  async prepareSandbox(
    userId: string,
    flowgram: FlowGramJSON,
  ): Promise<DraftSandboxTarget> {
    const pending = this.prepareLocks.get(userId);
    if (pending) {
      return pending.then(() => this.prepareSandboxUncached(userId, flowgram));
    }
    const task = this.prepareSandboxUncached(userId, flowgram).finally(() => {
      this.prepareLocks.delete(userId);
    });
    this.prepareLocks.set(userId, task);
    return task;
  }

  private async prepareSandboxUncached(
    userId: string,
    flowgram: FlowGramJSON,
  ): Promise<DraftSandboxTarget> {
    // 转换失败会在此抛出明确的中文错误，等价于发布前的无副作用门禁。
    const yaml = this.converter.toDifyDSLYaml(flowgram);
    const dslHash = createHash('sha256').update(yaml, 'utf8').digest('hex');

    const existing = await this.repo.findOne({
      where: { userId },
      // encryptedApiKey 标记为 select:false，这里必须显式取回才能解密复用。
      select: ['id', 'userId', 'appId', 'dslHash', 'encryptedApiKey'],
    });
    if (existing && existing.dslHash === dslHash) {
      return {
        appId: existing.appId,
        apiKey: this.decrypt(existing.encryptedApiKey, userId),
        reused: true,
      };
    }

    const auth = await this.requireAuthorization();
    const appId = existing?.appId
      || await this.withAuthorizationRetry(auth, () => this.createApp(auth));

    const importResponse = await this.consoleJson<any>(
      '/apps/imports',
      { method: 'POST', body: { mode: 'yaml-content', yaml_content: yaml, app_id: appId } },
      auth,
    );
    if (importResponse?.status === 'pending') {
      const importId = String(importResponse?.id || '');
      if (!importId) {
        throw new BadRequestException('Dify 草稿导入仍待确认，但未返回可确认的导入 ID，请稍后重试');
      }
      await this.consoleJson<any>(
        `/apps/imports/${encodeURIComponent(importId)}/confirm`,
        { method: 'POST' },
        auth,
      );
    }

    const publishResponse = await this.consoleJson<any>(
      `/apps/${encodeURIComponent(appId)}/workflows/publish`,
      { method: 'POST' },
      auth,
    );
    if (publishResponse && publishResponse.error) {
      throw new BadRequestException(
        `Dify 草稿发布失败：${String(publishResponse.error?.message || JSON.stringify(publishResponse.error)).slice(0, 200)}`,
      );
    }

    const apiKey = await this.ensureAppApiKey(appId, auth);

    if (existing) {
      existing.appId = appId;
      existing.dslHash = dslHash;
      existing.encryptedApiKey = this.encrypt(apiKey, userId);
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({
        userId,
        appId,
        dslHash,
        encryptedApiKey: this.encrypt(apiKey, userId),
      }));
    }
    return { appId, apiKey, reused: false };
  }

  /** 沙箱应用 Key：复用第一个已存在的，没有则创建一个。 */
  private async ensureAppApiKey(appId: string, auth: DifyConsoleAuthorization): Promise<string> {
    const list = await this.consoleJson<any>(
      `/apps/${encodeURIComponent(appId)}/api-keys`,
      {},
      auth,
    );
    const items = Array.isArray(list?.data) ? list.data : [];
    const existing = items.find((item: any) => item?.token);
    if (existing?.token) return String(existing.token);

    const created = await this.consoleJson<any>(
      `/apps/${encodeURIComponent(appId)}/api-keys`,
      { method: 'POST' },
      auth,
    );
    if (!created?.token) {
      throw new ServiceUnavailableException('Dify 未返回草稿沙箱应用的 API Key');
    }
    return String(created.token);
  }

  private async createApp(auth: DifyConsoleAuthorization): Promise<string> {
    const created = await this.consoleJson<any>('/apps', {
      method: 'POST',
      body: {
        name: 'futureFlow · 草稿试运行',
        description: 'Managed by futureFlow. Draft cloud test-run sandbox; DSL is replaced on every draft run.',
        mode: 'workflow',
        icon_type: 'emoji',
        icon: '🧪',
        icon_background: '#EFF6FF',
      },
    }, auth);
    if (!created?.id) {
      throw new ServiceUnavailableException('Dify 未返回草稿试运行应用的 ID');
    }
    return String(created.id);
  }

  private async requireAuthorization(): Promise<DifyConsoleAuthorization> {
    const auth = await this.dify.resolveConsoleAuthorization();
    if (!auth) {
      throw new ServiceUnavailableException(
        'Dify 授权未配置，草稿云端试运行需要本地 Dify 已完成一键初始化或管理后台授权',
      );
    }
    return auth;
  }

  /** Console 401/403 时自动刷新授权并重试一次（与知识库模块同一策略）。 */
  private async withAuthorizationRetry<T>(
    auth: DifyConsoleAuthorization,
    task: (current: DifyConsoleAuthorization) => Promise<T>,
  ): Promise<T> {
    try {
      return await task(auth);
    } catch (error) {
      if (error instanceof DifyConsoleAuthorizationError) {
        const renewed = await this.dify.refreshConsoleAuthorization(auth);
        if (renewed) return task(renewed);
        await this.dify.markConsoleAuthorizationExpired();
      }
      throw error;
    }
  }

  private async consoleJson<T = unknown>(
    path: string,
    init: ConsoleInit,
    auth: DifyConsoleAuthorization,
    retry = true,
  ): Promise<T> {
    const method = init.method || 'GET';
    let response: Response;
    try {
      response = await fetch(`${auth.consoleBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs || 30_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }

    if ((response.status === 401 || response.status === 403) && retry) {
      const renewed = await this.dify.refreshConsoleAuthorization(auth);
      if (renewed) {
        return this.consoleJson<T>(path, init, renewed, false);
      }
      await this.dify.markConsoleAuthorizationExpired();
      throw new ServiceUnavailableException('Dify Console 授权已过期，请重新保存 Dify 授权');
    }
    if (response.status === 204) return undefined as T;
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      if (payload?.error) {
        throw new BadRequestException(
          `Dify 草稿沙箱请求失败（HTTP ${response.status}）：${String(payload.error?.message || JSON.stringify(payload.error)).slice(0, 200)}`,
        );
      }
      const detail = JSON.stringify(payload).slice(0, 200);
      throw new BadRequestException(
        `Dify 草稿沙箱请求失败（HTTP ${response.status}）：${detail === '{}' ? await this.safeText(response) : detail}`,
      );
    }
    return payload as T;
  }

  private async safeText(response: Response): Promise<string> {
    return (await response.text().catch(() => '')).slice(0, 200) || '未知错误';
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : '未知错误';
  }

  private encrypt(plaintext: string, userId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`draft-sandbox:${userId}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  private decrypt(payload: string, userId: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw, extra] = payload.split(':');
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw || extra) {
      throw new ServiceUnavailableException('草稿沙箱凭据不可用，请重新执行云端试运行');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivRaw, 'base64url'));
      decipher.setAAD(Buffer.from(`draft-sandbox:${userId}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('无法解密草稿沙箱凭据，请重新执行云端试运行');
    }
  }

  private encryptionKey(): Buffer {
    const secret = this.config.get<string>('MEDIA_CREDENTIAL_ENCRYPTION_SECRET')
      || this.config.get<string>('DIFY_KEY_ENCRYPTION_SECRET')
      || '';
    if (secret.length < 32) {
      throw new ServiceUnavailableException('草稿沙箱凭据加密未配置');
    }
    return createHash('sha256').update(secret).digest();
  }
}
