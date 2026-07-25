import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { DifyIntegration } from '../database/entities/dify-integration.entity';

export interface DifyConsoleAuthorization {
  consoleBase: string;
  token: string;
}

export interface DifyWorkflowBindingInput {
  workflowId: string;
  workflowVersion: number;
  workflowName: string;
}

export interface DifyBootstrapInput {
  consoleToken?: string;
  consoleRefreshToken?: string;
  email?: string;
  password?: string;
  consoleBase?: string;
  /** Optional legacy app. Managed workflow versions never reuse it. */
  appId?: string;
}

type DifyPreflightState = 'passed' | 'failed' | 'not_configured' | 'not_checked';

interface DifyPreflightCheck {
  state: DifyPreflightState;
  message: string;
  version?: string;
}

/**
 * A deliberately non-billing readiness report. It never decrypts a stored
 * Console credential, creates a Dify resource, or invokes a workflow/model.
 */
export interface DifyPreflightResult {
  checkedAt: string;
  safe: true;
  consoleBase: string;
  checks: {
    apiHealth: DifyPreflightCheck;
    consoleEndpoint: DifyPreflightCheck;
    credentialEncryption: DifyPreflightCheck;
    storedAuthorization: DifyPreflightCheck;
    provisioning: DifyPreflightCheck;
    modelExecution: DifyPreflightCheck;
  };
  nextStep: string;
}

export interface DifyAuthorizationValidationResult {
  authorized: true;
  persisted: false;
  consoleBase: string;
  checkedAt: string;
  message: string;
}

/**
 * Stores one encrypted Dify Console authorization and provisions a dedicated
 * Dify application plus Service API key for every published workflow version.
 * The generated app-* key is never returned by an HTTP API or written to env.
 */
@Injectable()
export class DifyIntegrationService implements OnModuleInit {
  private readonly logger = new Logger(DifyIntegrationService.name);

  constructor(
    @InjectRepository(DifyIntegration)
    private readonly integrationRepo: Repository<DifyIntegration>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const consoleToken = this.config.get<string>('DIFY_CONSOLE_TOKEN', '').trim();
    if (!consoleToken || !this.isEncryptionReady()) return;

    try {
      const connection = await this.integrationRepo.findOne({ where: { name: 'default' } });
      if (connection?.status === 'active' && connection.encryptedConsoleToken) return;
      await this.bootstrap({
        consoleToken,
        consoleBase: this.config.get<string>(
          'DIFY_CONSOLE_BASE',
          'http://localhost:5001/console/api',
        ),
        appId: this.config.get<string>('DIFY_APP_ID', ''),
      });
      this.logger.log('Dify control-plane authorization was stored for managed workflow provisioning');
    } catch (error) {
      this.logger.warn(`Dify automatic authorization was skipped: ${this.safeError(error)}`);
    }
  }

  isEncryptionReady(): boolean {
    const secret = this.encryptionSecret();
    return secret.length >= 32
      && !secret.startsWith('replace-with-')
      && !secret.startsWith('change-me');
  }

  /** Compatibility path for a manually supplied DIFY_API_KEY. */
  async resolveServiceApiKey(fallback = ''): Promise<string> {
    const connection = await this.activeConnection();
    if (connection?.encryptedApiKey) return this.decrypt(connection.encryptedApiKey);
    return fallback;
  }

  /** A published workflow may execute only with its own Dify application key. */
  async resolveWorkflowServiceApiKey(
    workflowId: string,
    workflowVersion: number,
  ): Promise<string> {
    const integration = await this.integrationRepo.findOne({
      where: { workflowId, workflowVersion, status: 'active' },
    });
    if (!integration?.encryptedApiKey) return '';
    return this.decrypt(integration.encryptedApiKey);
  }

  /**
   * Legacy deployments may deliberately point every call at one manually
   * maintained Dify app. Preserve that path only until managed Console
   * authorization exists; once the platform owns provisioning, an unmapped
   * published version must never be sent to an unrelated global app.
   */
  async resolveWorkflowOrLegacyApiKey(
    workflowId: string,
    workflowVersion: number,
    legacyFallback: string,
  ): Promise<string> {
    const managed = await this.resolveWorkflowServiceApiKey(workflowId, workflowVersion);
    if (managed) return managed;
    const connection = await this.activeConnection();
    return connection?.encryptedConsoleToken ? '' : this.resolveServiceApiKey(legacyFallback);
  }

  async hasWorkflowIntegration(workflowId: string, workflowVersion: number): Promise<boolean> {
    return Boolean(await this.resolveWorkflowServiceApiKey(workflowId, workflowVersion));
  }

  async resolveConsoleAuthorization(
    fallbackToken = '',
    fallbackBase = '',
  ): Promise<DifyConsoleAuthorization | null> {
    const connection = await this.activeConnection();
    if (connection?.encryptedConsoleToken) {
      return {
        consoleBase: connection.consoleBase,
        token: this.decrypt(connection.encryptedConsoleToken),
      };
    }
    if (fallbackToken.trim()) {
      return {
        consoleBase: this.normalizeConsoleBase(fallbackBase),
        token: fallbackToken.trim(),
      };
    }
    return null;
  }

  async getStatus() {
    const connection = await this.integrationRepo.findOne({ where: { name: 'default' } });
    const active = await this.integrationRepo.find({ where: { status: 'active' } });
    const managedWorkflowApps = active
      .filter((item) => Boolean(item.workflowId && item.workflowVersion && item.appId && item.encryptedApiKey))
      .map((item) => ({
        workflowId: item.workflowId,
        workflowVersion: item.workflowVersion,
        appId: item.appId,
        keyFingerprint: item.keyFingerprint,
        lastRotatedAt: item.lastRotatedAt,
      }));

    return {
      encryptionReady: this.isEncryptionReady(),
      connectionAuthorized: Boolean(connection?.encryptedConsoleToken && connection.status === 'active'),
      status: connection?.status || 'not_authorized',
      consoleBase: connection?.consoleBase || null,
      legacyAppId: connection?.appId || null,
      legacyKeyFingerprint: connection?.keyFingerprint || null,
      lastConsoleAuthorizedAt: connection?.lastConsoleAuthorizedAt || null,
      managedWorkflowAppCount: managedWorkflowApps.length,
      managedWorkflowApps,
    };
  }

  /**
   * Verifies only local Dify reachability and local encryption readiness.
   * In particular, this endpoint intentionally does not decrypt or send a
   * stored Console credential, so it cannot validate a real administrator
   * account or cause any model/provider charge by accident.
   */
  async preflight(): Promise<DifyPreflightResult> {
    const connection = await this.integrationRepo.findOne({ where: { name: 'default' } });
    const consoleBase = this.normalizeConsoleBase(
      connection?.consoleBase
        || this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
    );
    const [apiHealth, consoleEndpoint] = await Promise.all([
      this.probeApiHealth(consoleBase),
      this.probeConsoleEndpoint(consoleBase),
    ]);
    const encryptionReady = this.isEncryptionReady();

    return {
      checkedAt: new Date().toISOString(),
      safe: true,
      consoleBase,
      checks: {
        apiHealth,
        consoleEndpoint,
        credentialEncryption: encryptionReady
          ? { state: 'passed', message: '本地凭据加密已配置。' }
          : {
            state: 'failed',
            message: '保存授权前需设置至少 32 位且非示例值的 DIFY_KEY_ENCRYPTION_SECRET。',
          },
        storedAuthorization: connection?.encryptedConsoleToken
          ? {
            state: 'not_checked',
            message: '已存在保存的授权；安全预检不会解密或发送该凭据。',
          }
          : {
            state: 'not_configured',
            message: '尚未保存 Dify Console 授权。',
          },
        provisioning: {
          state: 'not_checked',
          message: '未创建 Dify 应用、Service API Key，也未导入 DSL。',
        },
        modelExecution: {
          state: 'not_checked',
          message: '未执行工作流或模型，不会产生模型供应商费用。',
        },
      },
      nextStep: encryptionReady && apiHealth.state === 'passed' && consoleEndpoint.state === 'passed'
        ? '可先验证管理员授权（不保存）；确认无误后，再显式保存授权以启用按版本创建资源。'
        : '请先处理未通过的预检项，再输入或保存任何 Dify 管理员凭据。',
    };
  }

  /**
   * Validates a Console token or one-time email/password without storing any
   * credential and without creating a Dify application, Service API key, DSL
   * import, workflow execution, or model-provider charge.
   */
  async validateAuthorization(input: DifyBootstrapInput): Promise<DifyAuthorizationValidationResult> {
    const authorization = await this.authorizeInput(input);
    if (!authorization) {
      throw new BadRequestException('请提供 Dify Console Token，或一次性管理员邮箱和密码');
    }
    await this.probeConsoleAuthorization(authorization.consoleBase, authorization.token);
    return {
      authorized: true,
      persisted: false,
      consoleBase: authorization.consoleBase,
      checkedAt: new Date().toISOString(),
      message: 'Dify Console 授权已验证；未保存凭据，也未创建任何 Dify 资源。',
    };
  }

  /**
   * Performs the one-time admin authorization. Without appId it does not make
   * an execution app: publication creates isolated apps automatically.
   */
  async bootstrap(input: DifyBootstrapInput) {
    if (!this.isEncryptionReady()) {
      throw new BadRequestException(
        'DIFY_KEY_ENCRYPTION_SECRET must be at least 32 characters before Dify credentials can be stored',
      );
    }
    const consoleBase = this.normalizeConsoleBase(
      input.consoleBase || this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
    );
    let token = (input.consoleToken || '').trim();
    let refreshToken = (input.consoleRefreshToken || '').trim();
    if (!token && input.email?.trim() && input.password) {
      const login = await this.loginConsole(consoleBase, input.email.trim(), input.password);
      token = login.accessToken;
      refreshToken = login.refreshToken;
    }
    if (!token) {
      throw new BadRequestException('请提供 Dify Console Token，或一次性管理员邮箱和密码');
    }

    // A token pasted by an administrator must prove it can read the Console
    // before it becomes an encrypted, persistent control-plane credential.
    // This read-only request does not create an app/key, import DSL, or run a
    // model, so it cannot trigger model-provider billing.
    await this.probeConsoleAuthorization(consoleBase, token);

    const existing = await this.integrationRepo.findOne({ where: { name: 'default' } });
    const appId = (input.appId || existing?.appId || '').trim() || null;
    const apiKey = appId ? await this.createServiceApiKey(consoleBase, token, appId) : null;
    const now = new Date();
    await this.integrationRepo.save(this.integrationRepo.create({
      ...(existing || {}),
      name: 'default',
      workflowId: null,
      workflowVersion: null,
      appId,
      consoleBase,
      encryptedApiKey: apiKey ? this.encrypt(apiKey) : null,
      encryptedConsoleToken: this.encrypt(token),
      encryptedConsoleRefreshToken: refreshToken
        ? this.encrypt(refreshToken)
        : existing?.encryptedConsoleRefreshToken || null,
      keyFingerprint: apiKey ? this.fingerprint(apiKey) : null,
      status: 'active',
      lastRotatedAt: apiKey ? now : existing?.lastRotatedAt || null,
      lastConsoleAuthorizedAt: now,
    }));
    return this.getStatus();
  }

  /** Creates exactly one Dify app and encrypted Service API key for a release. */
  async ensureWorkflowIntegration(
    input: DifyWorkflowBindingInput,
    authorization: DifyConsoleAuthorization,
  ): Promise<DifyIntegration> {
    if (!this.isEncryptionReady()) {
      throw new BadRequestException('DIFY_KEY_ENCRYPTION_SECRET must be configured before publishing to Dify');
    }
    if (!Number.isInteger(input.workflowVersion) || input.workflowVersion < 1) {
      throw new BadRequestException('Published workflow version is invalid');
    }
    const name = this.workflowBindingName(input.workflowId, input.workflowVersion);
    const existing = await this.integrationRepo.findOne({ where: { name } });
    if (existing?.appId && existing.encryptedApiKey) return existing;

    const appId = await this.createWorkflowApp(
      authorization.consoleBase,
      authorization.token,
      input.workflowName,
      input.workflowVersion,
    );
    const apiKey = await this.createServiceApiKey(authorization.consoleBase, authorization.token, appId);
    if (!this.isValidServiceApiKey(apiKey)) {
      throw new ServiceUnavailableException('Dify returned an invalid Service API key format');
    }
    const now = new Date();
    const entity: DifyIntegration = this.integrationRepo.create({
      ...(existing || {}),
      name,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      appId,
      consoleBase: authorization.consoleBase,
      encryptedApiKey: this.encrypt(apiKey),
      encryptedConsoleToken: null,
      encryptedConsoleRefreshToken: null,
      keyFingerprint: this.fingerprint(apiKey),
      status: 'provisioning',
      lastRotatedAt: now,
      lastConsoleAuthorizedAt: now,
    } as any) as unknown as DifyIntegration;
    try {
      return await this.integrationRepo.save(entity);
    } catch (error) {
      // A second gateway may have provisioned the same immutable release just
      // before this instance committed. Reuse the winner instead of issuing a
      // second execution mapping.
      const concurrent = await this.integrationRepo.findOne({ where: { name } });
      if (concurrent?.status === 'active' && concurrent.appId && concurrent.encryptedApiKey) {
        return concurrent;
      }
      throw error;
    }
  }

  /** A binding becomes executable only after its DSL import was accepted. */
  async activateWorkflowIntegration(workflowId: string, workflowVersion: number) {
    await this.integrationRepo.update(
      { workflowId, workflowVersion },
      { status: 'active', lastConsoleAuthorizedAt: new Date() },
    );
  }

  async rotateServiceApiKey(input: DifyBootstrapInput & {
    workflowId?: string;
    workflowVersion?: number;
  } = {}) {
    const isWorkflowScope = Boolean(input.workflowId && input.workflowVersion);
    const current = isWorkflowScope
      ? await this.integrationRepo.findOne({
          where: {
            workflowId: input.workflowId!,
            workflowVersion: Number(input.workflowVersion),
          },
        })
      : await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (!current?.appId) {
      throw new BadRequestException('No managed Dify application exists for this target');
    }
    const authorization = (input.consoleToken || input.email || input.password)
      ? await this.authorizeInput(input)
      : await this.resolveConsoleAuthorization('', input.consoleBase || current.consoleBase);
    if (!authorization) {
      throw new BadRequestException('A current Dify Console authorization is required to rotate the Service API key');
    }
    const apiKey = await this.createServiceApiKey(authorization.consoleBase, authorization.token, current.appId);
    if (!this.isValidServiceApiKey(apiKey)) {
      throw new ServiceUnavailableException('Dify returned an invalid Service API key format');
    }
    const now = new Date();
    await this.integrationRepo.update(current.id, {
      encryptedApiKey: this.encrypt(apiKey),
      keyFingerprint: this.fingerprint(apiKey),
      status: 'active',
      lastRotatedAt: now,
    });
    return this.getStatus();
  }

  async markConsoleAuthorizationExpired() {
    const current = await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (!current) return;
    await this.integrationRepo.update(current.id, { status: 'reauthorization_required' });
  }

  /** Refreshes the shared Console session without retaining an admin password. */
  async refreshConsoleAuthorization(): Promise<DifyConsoleAuthorization | null> {
    const current = await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (!current?.encryptedConsoleRefreshToken) return null;
    let refreshToken: string;
    try {
      refreshToken = this.decrypt(current.encryptedConsoleRefreshToken);
    } catch {
      return null;
    }
    let response: Response;
    try {
      response = await fetch(`${current.consoleBase}/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    const result = await response.json().catch(() => ({})) as {
      data?: { access_token?: string; refresh_token?: string };
    };
    if (!response.ok || !result.data?.access_token) return null;
    await this.integrationRepo.update(current.id, {
      encryptedConsoleToken: this.encrypt(result.data.access_token),
      encryptedConsoleRefreshToken: this.encrypt(result.data.refresh_token || refreshToken),
      status: 'active',
      lastConsoleAuthorizedAt: new Date(),
    });
    return { consoleBase: current.consoleBase, token: result.data.access_token };
  }

  private async activeConnection(): Promise<DifyIntegration | null> {
    const integration = await this.integrationRepo.findOne({
      where: { name: 'default', status: 'active' },
    });
    return integration || null;
  }

  private async authorizeInput(input: DifyBootstrapInput): Promise<DifyConsoleAuthorization | null> {
    const consoleBase = this.normalizeConsoleBase(
      input.consoleBase || this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
    );
    if (input.consoleToken?.trim()) return { consoleBase, token: input.consoleToken.trim() };
    if (input.email?.trim() && input.password) {
      const login = await this.loginConsole(consoleBase, input.email.trim(), input.password);
      return { consoleBase, token: login.accessToken };
    }
    return null;
  }

  private async createWorkflowApp(
    consoleBase: string,
    token: string,
    workflowName: string,
    workflowVersion: number,
  ): Promise<string> {
    const safeName = workflowName.trim().replace(/\s+/g, ' ').slice(0, 90) || 'Untitled workflow';
    const response = await this.consoleFetch(`${consoleBase}/apps`, token, {
      name: `futureFlow · ${safeName} · v${workflowVersion}`.slice(0, 128),
      description: 'Managed by futureFlow. This immutable published version has an isolated Service API key.',
      mode: 'workflow',
      icon_type: 'emoji',
      icon: '⚡',
      icon_background: '#D5F5F6',
    });
    const result = await response.json() as { id?: string };
    if (!result.id) throw new ServiceUnavailableException('Dify did not return the new workflow application id');
    return result.id;
  }

  private async loginConsole(consoleBase: string, email: string, password: string) {
    let response: Response;
    try {
      response = await fetch(`${consoleBase}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember_me: true, language: 'zh-Hans' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    const result = await response.json().catch(() => ({})) as {
      data?: { access_token?: string; refresh_token?: string };
    };
    if (!response.ok || !result.data?.access_token) {
      throw new BadRequestException('Dify Console email/password authorization failed');
    }
    return { accessToken: result.data.access_token, refreshToken: result.data.refresh_token || '' };
  }

  private async createServiceApiKey(consoleBase: string, token: string, appId: string): Promise<string> {
    const response = await this.consoleFetch(
      `${consoleBase}/apps/${encodeURIComponent(appId)}/api-keys`,
      token,
    );
    const result = await response.json() as { token?: string; data?: { token?: string } };
    return result.token || result.data?.token || '';
  }

  private async probeApiHealth(consoleBase: string): Promise<DifyPreflightCheck> {
    const healthUrl = new URL('/health', consoleBase).toString();
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        return { state: 'failed', message: `Dify API 健康检查返回 HTTP ${response.status}。` };
      }
      const result = await response.json().catch(() => ({})) as { status?: string; version?: string };
      return {
        state: result.status === 'ok' || !result.status ? 'passed' : 'failed',
        message: result.status === 'ok' ? 'Dify API 健康检查通过。' : 'Dify API 健康检查未返回正常状态。',
        version: typeof result.version === 'string' ? result.version : undefined,
      };
    } catch (error) {
      return { state: 'failed', message: `Dify API 健康检查失败：${this.safeError(error)}` };
    }
  }

  private async probeConsoleEndpoint(consoleBase: string): Promise<DifyPreflightCheck> {
    try {
      const response = await fetch(`${consoleBase}/apps`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      // GET /apps normally returns 401 without a token. A non-error response
      // proves the expected Console endpoint is reachable without a write.
      if (response.status >= 500 || response.status === 404) {
        return { state: 'failed', message: `Dify Console 接口返回 HTTP ${response.status}，请检查 Console 地址或服务状态。` };
      }
      return {
        state: 'passed',
        message: response.status === 401 || response.status === 403
          ? 'Dify Console 接口可达，且已正确要求管理员授权。'
          : `Dify Console 接口可达（HTTP ${response.status}）。`,
      };
    } catch (error) {
      return { state: 'failed', message: `Dify Console 接口不可达：${this.safeError(error)}` };
    }
  }

  private async probeConsoleAuthorization(consoleBase: string, token: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${consoleBase}/apps`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException('Dify Console 授权无效、已过期，或缺少编辑权限');
      }
      throw new ServiceUnavailableException(`Dify Console 授权验证失败（HTTP ${response.status}）`);
    }
  }

  private async consoleFetch(url: string, token: string, body?: Record<string, unknown>) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException('Dify Console authorization is invalid, expired, or lacks editor access');
      }
      throw new ServiceUnavailableException(`Dify Console request failed (${response.status})`);
    }
    return response;
  }

  private workflowBindingName(workflowId: string, workflowVersion: number) {
    return `workflow:${workflowId}:v${workflowVersion}`;
  }

  private isValidServiceApiKey(apiKey: string): boolean {
    return /^app-[A-Za-z0-9]{16,}$/.test(apiKey);
  }

  private normalizeConsoleBase(value: string): string {
    const normalized = value.trim().replace(/\/+$/, '');
    try {
      const parsed = new URL(normalized);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      return normalized;
    } catch {
      throw new BadRequestException('DIFY_CONSOLE_BASE must be an http(s) URL');
    }
  }

  private encryptionSecret(): string {
    return this.config.get<string>('DIFY_KEY_ENCRYPTION_SECRET', '').trim();
  }

  private encryptionKey(): Buffer {
    const secret = this.encryptionSecret();
    if (secret.length < 32) {
      throw new BadRequestException('DIFY_KEY_ENCRYPTION_SECRET must be at least 32 characters');
    }
    return createHash('sha256').update(secret).digest();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
  }

  private decrypt(payload: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw] = payload.split(':');
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw) {
      throw new ServiceUnavailableException('Stored Dify credential is malformed; authorize Dify again');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivRaw, 'base64'));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Stored Dify credential cannot be decrypted; authorize Dify again');
    }
  }

  private fingerprint(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
