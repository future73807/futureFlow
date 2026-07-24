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
      throw new BadRequestException('Provide a Dify Console access token or a one-time Dify email and password');
    }

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
      throw new ServiceUnavailableException(`Dify Console is unreachable: ${this.safeError(error)}`);
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
      throw new ServiceUnavailableException(`Dify Console is unreachable: ${this.safeError(error)}`);
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
