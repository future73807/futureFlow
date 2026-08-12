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

/**
 * Distinguishes an expired/unauthorized Console session from validation and
 * availability failures.  Managed publication may refresh one session and
 * retry the complete provisioning operation exactly once.
 */
export class DifyConsoleAuthorizationError extends ServiceUnavailableException {
  constructor() {
    super('Dify Console 授权无效、已过期，或缺少编辑权限');
  }
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

interface DifyServiceApiKey {
  id: string;
  token: string;
}

export interface DifyManagedModelProviderStatus {
  provider: string | null;
  model: string | null;
  status: 'active' | 'configured' | 'not_configured' | 'unsupported' | 'disabled';
  configuredNow: boolean;
  message: string;
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
    const autoBootstrapEnabled = this.config.get<string>('DIFY_AUTO_BOOTSTRAP', 'true')
      .trim()
      .toLowerCase() === 'true';
    if (!autoBootstrapEnabled) return;

    if (!this.isEncryptionReady()) {
      throw new Error(
        'Dify 自动授权失败：DIFY_KEY_ENCRYPTION_SECRET 必须至少包含 32 个字符且不能使用示例值',
      );
    }

    const consoleToken = this.config.get<string>('DIFY_CONSOLE_TOKEN', '').trim();
    const adminEmail = this.config.get<string>('DIFY_ADMIN_EMAIL', '').trim()
      || 'admin@futureflow.local';
    const adminPassword = this.config.get<string>('DIFY_ADMIN_PASSWORD', '');
    if (!consoleToken && !adminPassword) {
      throw new Error(
        'Dify 自动授权失败：必须提供 DIFY_CONSOLE_TOKEN 或 DIFY_ADMIN_PASSWORD',
      );
    }

    const consoleBase = this.normalizeConsoleBase(
      this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
    );
    const attempts = this.configInteger('DIFY_AUTO_BOOTSTRAP_ATTEMPTS', 30, 1, 120);
    const retryDelayMs = this.configInteger('DIFY_AUTO_BOOTSTRAP_RETRY_MS', 2_000, 0, 30_000);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.ensureAutomaticConsoleAuthorization({
          consoleBase,
          consoleToken,
          adminEmail,
          adminPassword,
        });
        this.logger.log(
          'Dify control-plane authorization is ready for managed workflow provisioning',
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !this.isRetryableAutomaticBootstrapError(error)) break;
        this.logger.warn(
          `Dify 自动授权暂未就绪（${attempt}/${attempts}）：${this.safeError(error)}`,
        );
        await this.sleep(retryDelayMs);
      }
    }

    throw new Error(
      `Dify 自动授权失败，网关拒绝进入就绪状态：${this.safeError(lastError)}`,
    );
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
        '保存 Dify 凭据前，DIFY_KEY_ENCRYPTION_SECRET 必须至少包含 32 个字符',
      );
    }
    const consoleBase = this.normalizeConsoleBase(
      input.consoleBase || this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
    );
    const existing = await this.integrationRepo.findOne({ where: { name: 'default' } });
    // A single encrypted Console authorization must never be repointed while
    // managed workflow apps still belong to another Dify control plane. Doing
    // so would make a later 404 on the new server look like a successful
    // deletion of an app that still exists on the old server.
    await this.assertConsoleBaseSwitchAllowed(consoleBase, existing);
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
    const modelProvider = await this.ensureManagedModelProvider({ consoleBase, token });

    const existingConsoleBase = existing?.consoleBase
      ? this.normalizeConsoleBase(existing.consoleBase)
      : null;
    const sameConsoleBase = existingConsoleBase === consoleBase;
    const explicitAppId = (input.appId || '').trim();
    const appId = (
      explicitAppId || (sameConsoleBase ? existing?.appId || '' : '')
    ).trim() || null;
    let apiKey: string | null = null;
    let apiKeyCreated = false;
    const sameLegacyApp = Boolean(
      appId
      && sameConsoleBase
      && existing?.appId?.trim() === appId
      && existing.encryptedApiKey,
    );
    if (sameLegacyApp) {
      try {
        const storedApiKey = this.decrypt(existing!.encryptedApiKey!);
        if (this.isValidServiceApiKey(storedApiKey)) apiKey = storedApiKey;
      } catch {
        // A malformed legacy credential cannot be reused. Creating a fresh key
        // is safer than persisting an unreadable execution credential again.
      }
    }
    if (appId && !apiKey) {
      apiKey = await this.createServiceApiKey(consoleBase, token, appId);
      if (!this.isValidServiceApiKey(apiKey)) {
        throw new ServiceUnavailableException('Dify 返回的 Service API Key 格式无效');
      }
      apiKeyCreated = true;
    }
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
        : null,
      keyFingerprint: apiKey ? this.fingerprint(apiKey) : null,
      status: 'active',
      lastRotatedAt: apiKeyCreated
        ? now
        : (sameConsoleBase ? existing?.lastRotatedAt || null : null),
      lastConsoleAuthorizedAt: now,
    }));
    return {
      ...(await this.getStatus()),
      modelProvider,
    };
  }

  /** Creates exactly one Dify app and encrypted Service API key for a release. */
  async ensureWorkflowIntegration(
    input: DifyWorkflowBindingInput,
    authorization: DifyConsoleAuthorization,
  ): Promise<DifyIntegration> {
    if (!this.isEncryptionReady()) {
      throw new BadRequestException(
        '发布到 Dify 前必须配置至少 32 位的 DIFY_KEY_ENCRYPTION_SECRET',
      );
    }
    if (!Number.isInteger(input.workflowVersion) || input.workflowVersion < 1) {
      throw new BadRequestException('已发布的工作流版本号无效');
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
    let entity: DifyIntegration;
    try {
      const apiKey = await this.createServiceApiKey(
        authorization.consoleBase,
        authorization.token,
        appId,
      );
      if (!this.isValidServiceApiKey(apiKey)) {
        throw new ServiceUnavailableException('Dify 返回的 Service API Key 格式无效');
      }
      const now = new Date();
      entity = this.integrationRepo.create({
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
    } catch (error) {
      await this.compensateCreatedWorkflowApp(authorization, appId, error);
      throw error;
    }

    try {
      return await this.integrationRepo.save(entity);
    } catch (error) {
      // A second gateway may have provisioned the same immutable release just
      // before this instance committed. Reuse the winner instead of issuing a
      // second execution mapping, but only after deleting this instance's
      // losing Dify app.
      let concurrent: DifyIntegration | null = null;
      try {
        concurrent = await this.integrationRepo.findOne({ where: { name } });
      } catch (lookupError) {
        this.logger.warn(
          `并发工作流绑定查询失败: ${this.safeError(lookupError)}`,
        );
      }
      // The winner may still be importing its DSL (`provisioning`). It already
      // owns the unique release binding and a usable app/key, so the loser can
      // safely reuse it after compensating its own app instead of surfacing a
      // false publish failure while the winner is still finishing.
      if (concurrent?.appId && concurrent.encryptedApiKey) {
        await this.compensateCreatedWorkflowApp(authorization, appId, error);
        return concurrent;
      }
      await this.compensateCreatedWorkflowApp(authorization, appId, error);
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

  /**
   * Removes every managed Dify application for one futureFlow workflow.
   * Remote deletion happens before binding rows are removed, so a transient
   * Dify failure remains retryable. Already removed applications return 404
   * and are intentionally treated as a successful idempotent retry.
   */
  async deleteWorkflowIntegrations(workflowId: string): Promise<void> {
    const normalizedWorkflowId = workflowId.trim();
    if (!normalizedWorkflowId) {
      throw new BadRequestException('待清理的工作流 ID 不能为空');
    }

    const bindings = await this.integrationRepo.find({
      where: { workflowId: normalizedWorkflowId },
    });
    if (bindings.length === 0) return;

    const appBindings = bindings.filter((binding) => Boolean(binding.appId?.trim()));
    const appIds = Array.from(new Set(appBindings.map((binding) => binding.appId!.trim())));

    if (appIds.length > 0) {
      const bindingConsoleBases = Array.from(new Set(appBindings.map((binding) => {
        try {
          return this.normalizeConsoleBase(String(binding.consoleBase || ''));
        } catch {
          throw new ServiceUnavailableException(
            '历史 Dify 工作流绑定的 Console 地址无效，工作流尚未删除，请修复配置后重试',
          );
        }
      })));
      if (bindingConsoleBases.length !== 1) {
        throw new ServiceUnavailableException(
          '该工作流包含多个 Dify Console 地址的历史应用，工作流尚未删除；需先完成旧实例资源迁移或人工清理',
        );
      }
      const bindingConsoleBase = bindingConsoleBases[0];
      let authorization = await this.resolveConsoleAuthorization(
        this.config.get<string>('DIFY_CONSOLE_TOKEN', ''),
        this.config.get<string>('DIFY_CONSOLE_BASE', bindingConsoleBase),
      );
      if (!authorization) {
        throw new ServiceUnavailableException(
          '删除工作流前需要有效的 Dify Console 授权，请重新授权后重试',
        );
      }
      this.assertCleanupAuthorizationBase(bindingConsoleBase, authorization.consoleBase);

      for (const appId of appIds) {
        let response = await this.deleteConsoleApp(authorization, appId);
        if (response.status === 401 || response.status === 403) {
          const refreshed = await this.refreshConsoleAuthorization();
          if (refreshed) {
            this.assertCleanupAuthorizationBase(bindingConsoleBase, refreshed.consoleBase);
            authorization = refreshed;
            response = await this.deleteConsoleApp(authorization, appId);
          }
        }

        if (response.status === 401 || response.status === 403) {
          await this.markConsoleAuthorizationExpired();
          throw new ServiceUnavailableException(
            'Dify Console 授权已失效或权限不足，请重新授权后再次删除工作流',
          );
        }
        if (![200, 204, 404].includes(response.status)) {
          throw new ServiceUnavailableException(
            `Dify 应用清理失败（HTTP ${response.status}），工作流尚未删除，请稍后重试`,
          );
        }
      }
    }

    await this.integrationRepo.delete({ workflowId: normalizedWorkflowId });
  }

  async rotateServiceApiKey(input: DifyBootstrapInput & {
    workflowId?: string;
    workflowVersion?: number;
  } = {}) {
    const hasWorkflowSelector = input.workflowId !== undefined || input.workflowVersion !== undefined;
    if (hasWorkflowSelector && (
      !input.workflowId?.trim()
      || !Number.isInteger(input.workflowVersion)
      || Number(input.workflowVersion) < 1
    )) {
      throw new BadRequestException('轮换工作流密钥时必须提供有效的工作流 ID 和正整数版本号');
    }
    const isWorkflowScope = hasWorkflowSelector;
    const targetWhere = isWorkflowScope
      ? {
          workflowId: input.workflowId!,
          workflowVersion: Number(input.workflowVersion),
        }
      : { name: 'default' };
    const initial = await this.integrationRepo.findOne({ where: targetWhere });
    if (!initial?.appId) {
      throw new BadRequestException('当前目标不存在由平台管理的 Dify 应用');
    }
    const hasExplicitAuthorization = Boolean(
      input.consoleToken?.trim() || input.email?.trim() || input.password,
    );
    let authorization: DifyConsoleAuthorization | null;
    if (hasExplicitAuthorization) {
      // Email/password authorization performs a remote login, so reject a
      // cross-control-plane request before authorizeInput can send anything.
      const requestedBase = this.normalizeConsoleBase(
        input.consoleBase
          || this.config.get<string>('DIFY_CONSOLE_BASE', 'http://localhost:5001/console/api'),
      );
      this.assertRotationAuthorizationBase(initial.consoleBase, requestedBase);
      authorization = await this.authorizeInput({ ...input, consoleBase: requestedBase });
    } else {
      authorization = await this.resolveConsoleAuthorization(
        '',
        input.consoleBase || initial.consoleBase,
      );
    }
    if (!authorization) {
      throw new BadRequestException(
        '轮换 Service API Key 前需要有效的 Dify Console 管理员授权',
      );
    }
    this.assertRotationAuthorizationBase(initial.consoleBase, authorization.consoleBase);

    let revokeFailure: ServiceUnavailableException | undefined;
    await this.integrationRepo.manager.transaction(async (manager) => {
      const integrationRepo = manager.getRepository(DifyIntegration);
      // This PostgreSQL row lock serializes rotations for the same binding
      // across every Gateway process. Never catch lock failures or fall back
      // to an unlocked read in production.
      const current = await integrationRepo.findOne({
        where: targetWhere,
        lock: { mode: 'pessimistic_write' },
      });
      if (!current?.appId) {
        throw new BadRequestException('当前目标不存在由平台管理的 Dify 应用');
      }
      this.assertRotationAuthorizationBase(current.consoleBase, authorization.consoleBase);

      // Resolve the managed old key only after taking the lock. A waiter must
      // observe the key committed by the preceding rotation, then revoke that
      // exact ID rather than deleting an unrelated manually-created key.
      const oldApiKey = current.encryptedApiKey
        ? this.decrypt(current.encryptedApiKey)
        : '';
      const remoteKeys = await this.listServiceApiKeys(
        authorization.consoleBase,
        authorization.token,
        current.appId,
      );
      const oldRemoteKey = oldApiKey
        ? remoteKeys.find((item) => item.token === oldApiKey)
        : undefined;

      let newApiKey = await this.createServiceApiKeyRecord(
        authorization.consoleBase,
        authorization.token,
        current.appId,
      );
      if (!newApiKey.id && newApiKey.token) {
        const keysAfterCreate = await this.listServiceApiKeys(
          authorization.consoleBase,
          authorization.token,
          current.appId,
        );
        const exactMatches = keysAfterCreate.filter((item) => item.token === newApiKey.token);
        if (exactMatches.length === 1) {
          newApiKey = exactMatches[0];
        }
      }
      if (!newApiKey.id) {
        throw new ServiceUnavailableException(
          'Dify 未返回新 Service API Key 的 ID，无法安全完成轮换；可能已创建未跟踪的新 key',
        );
      }
      if (!this.isValidServiceApiKey(newApiKey.token)) {
        const invalidKeyError = new ServiceUnavailableException(
          'Dify 返回的新 Service API Key 格式无效',
        );
        await this.compensateCreatedServiceApiKey(
          authorization,
          current.appId,
          newApiKey.id,
          invalidKeyError,
        );
        throw invalidKeyError;
      }

      const now = new Date();
      try {
        const updateResult = await integrationRepo.update(current.id, {
          encryptedApiKey: this.encrypt(newApiKey.token),
          keyFingerprint: this.fingerprint(newApiKey.token),
          status: 'active',
          lastRotatedAt: now,
        });
        if (updateResult?.affected === 0) {
          throw new ServiceUnavailableException('Service API Key 数据库记录不存在或未更新');
        }
      } catch (error) {
        await this.compensateCreatedServiceApiKey(
          authorization,
          current.appId,
          newApiKey.id,
          error,
        );
        throw error;
      }

      if (oldRemoteKey) {
        let revokeResponse: Response;
        try {
          revokeResponse = await this.deleteServiceApiKey(
            authorization,
            current.appId,
            oldRemoteKey.id,
          );
        } catch (error) {
          // Commit the already-active new key before reporting the partial
          // remote cleanup failure, matching the pre-lock availability
          // contract and avoiding an untracked new credential.
          revokeFailure = new ServiceUnavailableException(
            `新 key 已生效但旧 key 未撤销：${this.safeError(error)}；旧 Key ID ${oldRemoteKey.id}`,
          );
          return;
        }
        if (![200, 204, 404].includes(revokeResponse.status)) {
          revokeFailure = new ServiceUnavailableException(
            `新 key 已生效但旧 key 未撤销（HTTP ${revokeResponse.status}）；旧 Key ID ${oldRemoteKey.id}`,
          );
        }
      }
    });
    if (revokeFailure) throw revokeFailure;
    return this.getStatus();
  }

  async markConsoleAuthorizationExpired() {
    const current = await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (!current) return;
    await this.integrationRepo.update(current.id, { status: 'reauthorization_required' });
  }

  /**
   * Renews the shared Console session.  Prefer Dify's refresh token; when it
   * has expired, the local one-click deployment may log in again with the
   * administrator password already kept in the deployment environment.  The
   * password itself is never written to the database.
   */
  async refreshConsoleAuthorization(
    failedAuthorization?: DifyConsoleAuthorization,
  ): Promise<DifyConsoleAuthorization | null> {
    const current = await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (!current) return null;

    // Another Gateway process (or compensation cleanup) may already have
    // renewed the session while this request was handling its 401.  Reuse that
    // token instead of rotating the refresh token a second time.
    if (current.encryptedConsoleToken && failedAuthorization) {
      try {
        const storedToken = this.decrypt(current.encryptedConsoleToken);
        const sameBase = this.normalizeConsoleBase(current.consoleBase)
          === this.normalizeConsoleBase(failedAuthorization.consoleBase);
        if (sameBase && storedToken !== failedAuthorization.token) {
          if (current.status !== 'active') {
            await this.integrationRepo.update(current.id, {
              status: 'active',
              lastConsoleAuthorizedAt: new Date(),
            });
          }
          return { consoleBase: current.consoleBase, token: storedToken };
        }
      } catch {
        // Fall through to refresh-token or administrator-login recovery.
      }
    }

    let refreshToken = '';
    try {
      refreshToken = current.encryptedConsoleRefreshToken
        ? this.decrypt(current.encryptedConsoleRefreshToken)
        : '';
    } catch {
      refreshToken = '';
    }

    if (refreshToken) {
      try {
        const response = await fetch(`${current.consoleBase}/refresh-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json().catch(() => ({})) as {
          data?: { access_token?: string; refresh_token?: string };
        };
        if (response.ok && result.data?.access_token) {
          await this.persistConsoleSession(
            current,
            result.data.access_token,
            result.data.refresh_token || refreshToken,
          );
          return { consoleBase: current.consoleBase, token: result.data.access_token };
        }
      } catch {
        // A fresh administrator login below is the final automatic fallback.
      }
    }

    const adminPassword = this.config.get<string>('DIFY_ADMIN_PASSWORD', '');
    if (!adminPassword) return null;
    const adminEmail = this.config.get<string>('DIFY_ADMIN_EMAIL', '').trim()
      || 'admin@futureflow.local';
    try {
      const login = await this.loginConsole(current.consoleBase, adminEmail, adminPassword);
      await this.persistConsoleSession(current, login.accessToken, login.refreshToken);
      return { consoleBase: current.consoleBase, token: login.accessToken };
    } catch (error) {
      this.logger.warn(`Dify Console 自动重新登录失败：${this.safeError(error)}`);
      return null;
    }
  }

  private async activeConnection(): Promise<DifyIntegration | null> {
    const integration = await this.integrationRepo.findOne({
      where: { name: 'default', status: 'active' },
    });
    return integration || null;
  }

  private async ensureAutomaticConsoleAuthorization(input: {
    consoleBase: string;
    consoleToken: string;
    adminEmail: string;
    adminPassword: string;
  }): Promise<void> {
    const current = await this.integrationRepo.findOne({ where: { name: 'default' } });
    if (current?.encryptedConsoleToken) {
      let authorization: DifyConsoleAuthorization | null = null;
      let storedAuthorizationError: unknown = new DifyConsoleAuthorizationError();
      try {
        authorization = {
          consoleBase: this.normalizeConsoleBase(current.consoleBase),
          token: this.decrypt(current.encryptedConsoleToken),
        };
      } catch (error) {
        // A rotated encryption secret or damaged ciphertext must not make an
        // explicitly configured replacement Console token unusable forever.
        storedAuthorizationError = error;
      }

      if (authorization) {
        try {
          await this.probeConsoleAuthorization(authorization.consoleBase, authorization.token);
          await this.ensureManagedModelProvider(authorization);
          if (current.status !== 'active') {
            await this.integrationRepo.update(current.id, {
              status: 'active',
              lastConsoleAuthorizedAt: new Date(),
            });
          }
          return;
        } catch (error) {
          if (!(error instanceof DifyConsoleAuthorizationError)) throw error;
          storedAuthorizationError = error;
        }
      }

      const renewed = await this.refreshConsoleAuthorization(authorization || undefined);
      if (renewed) {
        try {
          await this.probeConsoleAuthorization(renewed.consoleBase, renewed.token);
          await this.ensureManagedModelProvider(renewed);
          return;
        } catch (error) {
          if (!(error instanceof DifyConsoleAuthorizationError)) throw error;
          storedAuthorizationError = error;
        }
      }

      if (input.consoleToken) {
        await this.replaceAutomaticConsoleAuthorization(
          current,
          input.consoleBase,
          input.consoleToken,
        );
        return;
      }

      throw storedAuthorizationError;
    }

    await this.bootstrap(input.consoleToken
      ? {
          consoleToken: input.consoleToken,
          consoleBase: input.consoleBase,
        }
      : {
          email: input.adminEmail,
          password: input.adminPassword,
          consoleBase: input.consoleBase,
        });
  }

  private async replaceAutomaticConsoleAuthorization(
    current: DifyIntegration,
    consoleBase: string,
    consoleToken: string,
  ): Promise<void> {
    let currentConsoleBase: string;
    try {
      currentConsoleBase = this.normalizeConsoleBase(current.consoleBase);
    } catch {
      throw new BadRequestException(
        '当前保存的 Dify Console 地址无效，不能自动覆盖授权',
      );
    }
    const replacementConsoleBase = this.normalizeConsoleBase(consoleBase);
    if (currentConsoleBase !== replacementConsoleBase) {
      throw new BadRequestException(
        '显式 Dify Console Token 的地址与当前保存授权不一致，不能跨控制面自动覆盖',
      );
    }

    const replacement = {
      consoleBase: replacementConsoleBase,
      token: consoleToken,
    };
    await this.probeConsoleAuthorization(replacement.consoleBase, replacement.token);
    await this.ensureManagedModelProvider(replacement);
    await this.persistConsoleSession(current, replacement.token, '');
  }

  private async persistConsoleSession(
    current: DifyIntegration,
    accessToken: string,
    refreshToken: string,
  ): Promise<void> {
    await this.integrationRepo.update(current.id, {
      encryptedConsoleToken: this.encrypt(accessToken),
      encryptedConsoleRefreshToken: refreshToken ? this.encrypt(refreshToken) : null,
      status: 'active',
      lastConsoleAuthorizedAt: new Date(),
    });
  }

  private configInteger(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const parsed = Number.parseInt(this.config.get<string>(name, String(fallback)), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
  }

  private isRetryableAutomaticBootstrapError(error: unknown): boolean {
    const message = this.safeError(error);
    return /不可达|HTTP 5\d\d|timeout|timed out|ECONN|fetch failed|aborted/i.test(message);
  }

  private sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async assertConsoleBaseSwitchAllowed(
    consoleBase: string,
    existing: DifyIntegration | null,
  ): Promise<void> {
    if (existing?.consoleBase) {
      let existingConsoleBase: string;
      try {
        existingConsoleBase = this.normalizeConsoleBase(existing.consoleBase);
      } catch {
        throw new BadRequestException(
          '当前保存的 Dify Console 地址无效，请修复默认授权后再尝试切换',
        );
      }
      // Historical test data may contain localhost/127.0.0.1 aliases. They do
      // not block refreshing the current default authorization; the stricter
      // per-workflow check still prevents deleting an app through a different
      // binding base.
      if (existingConsoleBase === consoleBase) return;
      if (existing.appId?.trim() || existing.encryptedApiKey) {
        throw new BadRequestException(
          '旧 Dify Console 仍保存 legacy 应用或密钥，不能切换授权地址；请先在旧实例完成资源清理',
        );
      }
    }

    const integrations = await this.integrationRepo.find({ where: {} });
    const managedBindings = integrations.filter((integration) => (
      Boolean(integration.workflowId) && Boolean(integration.appId?.trim())
    ));
    if (managedBindings.length === 0) return;

    const conflictingBinding = managedBindings.find((integration) => {
      try {
        return this.normalizeConsoleBase(String(integration.consoleBase || '')) !== consoleBase;
      } catch {
        return true;
      }
    });
    if (conflictingBinding) {
      throw new BadRequestException(
        '仍有工作流应用绑定到其他 Dify Console，不能切换授权地址；请先使用原地址删除这些工作流应用',
      );
    }
  }

  private assertCleanupAuthorizationBase(bindingConsoleBase: string, authorizationBase: string): void {
    let normalizedAuthorizationBase: string;
    try {
      normalizedAuthorizationBase = this.normalizeConsoleBase(String(authorizationBase || ''));
    } catch {
      throw new ServiceUnavailableException(
        '当前 Dify Console 授权地址无效，工作流尚未删除，请重新授权后重试',
      );
    }
    if (normalizedAuthorizationBase !== bindingConsoleBase) {
      throw new ServiceUnavailableException(
        '当前 Dify Console 授权地址与历史工作流绑定不一致，工作流尚未删除；请恢复原地址授权后重试',
      );
    }
  }

  private assertRotationAuthorizationBase(bindingBase: string, authorizationBase: string): void {
    let normalizedBindingBase: string;
    let normalizedAuthorizationBase: string;
    try {
      normalizedBindingBase = this.normalizeConsoleBase(String(bindingBase || ''));
      normalizedAuthorizationBase = this.normalizeConsoleBase(String(authorizationBase || ''));
    } catch {
      throw new BadRequestException(
        'Dify Console 授权地址或目标应用绑定地址无效，不能轮换 Service API Key',
      );
    }
    if (normalizedBindingBase !== normalizedAuthorizationBase) {
      throw new BadRequestException(
        '当前 Dify Console 授权地址与目标应用绑定不一致，不能跨 Console 轮换 Service API Key',
      );
    }
  }

  private async ensureManagedModelProvider(
    authorization: DifyConsoleAuthorization,
  ): Promise<DifyManagedModelProviderStatus> {
    const syncEnabled = this.config.get<string>('DIFY_SYNC_LLM_PROVIDER', 'true')
      .trim()
      .toLowerCase() !== 'false';
    const model = this.config.get<string>('LLM_DEFAULT_MODEL', 'deepseek-chat').trim();
    if (!syncEnabled) {
      return {
        provider: null,
        model: model || null,
        status: 'disabled',
        configuredNow: false,
        message: '已关闭从服务端环境同步 Dify 模型 Provider。',
      };
    }

    const apiHost = this.config.get<string>('LLM_API_HOST', '').trim().replace(/\/+$/, '');
    const provider = this.inferManagedModelProvider(model, apiHost);
    if (!provider) {
      return {
        provider: null,
        model: model || null,
        status: 'unsupported',
        configuredNow: false,
        message: `模型 ${model || '未设置'} 暂不支持自动同步 Provider，请在 Dify 中手动配置。`,
      };
    }

    const providerListResponse = await this.consoleGet(
      `${authorization.consoleBase}/workspaces/current/model-providers?model_type=llm`,
      authorization.token,
    );
    const providerList = await providerListResponse.json().catch(() => ({})) as {
      data?: Array<{
        provider?: string;
        custom_configuration?: { status?: string };
      }>;
    };
    if (!Array.isArray(providerList.data)) {
      throw new ServiceUnavailableException('Dify 返回的模型 Provider 列表格式无效');
    }
    const installedProvider = providerList.data.find((item) => item.provider === provider);
    if (!installedProvider) {
      throw new ServiceUnavailableException(`当前 Dify 未安装模型 Provider：${provider}`);
    }

    const forceSync = this.config.get<string>('DIFY_FORCE_LLM_PROVIDER_SYNC', 'false')
      .trim()
      .toLowerCase() === 'true';
    if (installedProvider.custom_configuration?.status === 'active' && !forceSync) {
      return {
        provider,
        model,
        status: 'active',
        configuredNow: false,
        message: `Dify 模型 Provider ${provider} 已配置。`,
      };
    }

    const apiKey = this.config.get<string>('LLM_API_KEY', '').trim();
    if (
      !apiKey
      || /change-me|replace-with|your[-_ ]?(key|secret)|x{6,}/i.test(apiKey)
    ) {
      return {
        provider,
        model,
        status: 'not_configured',
        configuredNow: false,
        message: `服务端没有可用的 LLM_API_KEY，未改动 Dify 模型 Provider ${provider}。`,
      };
    }

    const endpoint = this.normalizeModelProviderEndpoint(
      apiHost || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com'),
    );
    const credentials = provider === 'deepseek'
      ? { api_key: apiKey, endpoint_url: endpoint }
      : { openai_api_key: apiKey, openai_api_base: endpoint };
    const configuredTimeout = Number.parseInt(
      this.config.get<string>('LLM_REQUEST_TIMEOUT_MS', '120000'),
      10,
    );
    await this.consoleFetch(
      `${authorization.consoleBase}/workspaces/current/model-providers/${encodeURIComponent(provider)}`,
      authorization.token,
      { credentials },
      Number.isInteger(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 15_000), 120_000) : 120_000,
    );
    this.logger.log(`Dify 模型 Provider 已从服务端环境完成配置: ${provider}/${model}`);
    return {
      provider,
      model,
      status: 'configured',
      configuredNow: true,
      message: `已配置并验证 Dify 模型 Provider ${provider}；验证请求可能产生极少量模型用量。`,
    };
  }

  private inferManagedModelProvider(model: string, apiHost: string): 'deepseek' | 'openai' | null {
    const normalizedModel = model.toLowerCase();
    const normalizedHost = apiHost.toLowerCase();
    if (normalizedModel.startsWith('deepseek') || normalizedHost.includes('deepseek')) {
      return 'deepseek';
    }
    if (
      /^(gpt-|chatgpt-|o[134](?:-|$))/i.test(normalizedModel)
      || normalizedHost.includes('openai.com')
    ) {
      return 'openai';
    }
    return null;
  }

  private normalizeModelProviderEndpoint(value: string): string {
    try {
      const endpoint = new URL(value.trim());
      if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('protocol');
      return endpoint.toString().replace(/\/+$/, '');
    } catch {
      throw new BadRequestException('LLM_API_HOST 必须是有效的 HTTP(S) URL');
    }
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
    if (!result.id) {
      throw new ServiceUnavailableException('Dify 未返回新建工作流应用的 ID');
    }
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
    if (response.status >= 500) {
      throw new ServiceUnavailableException(
        `Dify Console 登录暂不可用（HTTP ${response.status}）`,
      );
    }
    if (!response.ok || !result.data?.access_token) {
      throw new BadRequestException('Dify Console 邮箱或密码授权失败');
    }
    return { accessToken: result.data.access_token, refreshToken: result.data.refresh_token || '' };
  }

  private async createServiceApiKeyRecord(
    consoleBase: string,
    token: string,
    appId: string,
  ): Promise<DifyServiceApiKey> {
    const response = await this.consoleFetch(
      `${consoleBase}/apps/${encodeURIComponent(appId)}/api-keys`,
      token,
    );
    const result = await response.json() as {
      id?: string;
      token?: string;
      data?: { id?: string; token?: string };
    };
    return {
      id: String(result.id || result.data?.id || '').trim(),
      token: String(result.token || result.data?.token || '').trim(),
    };
  }

  private async createServiceApiKey(
    consoleBase: string,
    token: string,
    appId: string,
  ): Promise<string> {
    return (await this.createServiceApiKeyRecord(consoleBase, token, appId)).token;
  }

  private async listServiceApiKeys(
    consoleBase: string,
    token: string,
    appId: string,
  ): Promise<DifyServiceApiKey[]> {
    let response: Response;
    try {
      response = await fetch(
        `${consoleBase}/apps/${encodeURIComponent(appId)}/api-keys`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException('Dify Console 授权无效、已过期，或缺少编辑权限');
      }
      throw new ServiceUnavailableException(`Dify Console 请求失败（HTTP ${response.status}）`);
    }
    const result = await response.json().catch(() => ({})) as { data?: unknown };
    if (!Array.isArray(result.data)) {
      throw new ServiceUnavailableException('Dify 返回的 Service API Key 列表格式无效');
    }
    const keys = result.data.map((item) => {
      const candidate = item as { id?: unknown; token?: unknown };
      return {
        id: typeof candidate?.id === 'string' ? candidate.id.trim() : '',
        token: typeof candidate?.token === 'string' ? candidate.token.trim() : '',
      };
    });
    if (keys.some((item) => !item.id || !item.token)) {
      throw new ServiceUnavailableException('Dify 返回的 Service API Key 列表格式无效');
    }
    return keys;
  }

  private async deleteServiceApiKey(
    authorization: DifyConsoleAuthorization,
    appId: string,
    keyId: string,
  ): Promise<Response> {
    try {
      return await fetch(
        `${authorization.consoleBase}/apps/${encodeURIComponent(appId)}/api-keys/${encodeURIComponent(keyId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authorization.token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        `Dify Service API Key 删除请求失败：${this.safeError(error)}`,
      );
    }
  }

  private async compensateCreatedServiceApiKey(
    authorization: DifyConsoleAuthorization,
    appId: string,
    keyId: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      const response = await this.deleteServiceApiKey(authorization, appId, keyId);
      if (![200, 204, 404].includes(response.status)) {
        throw new ServiceUnavailableException(`补偿删除返回 HTTP ${response.status}`);
      }
      this.logger.warn(`已补偿删除未写入数据库的 Dify Service API Key ${keyId}`);
    } catch (cleanupError) {
      throw new ServiceUnavailableException(
        [
          `Service API Key 轮换未写入数据库：${this.safeError(originalError)}`,
          `新 key 清理失败：${this.safeError(cleanupError)}`,
          `可能遗留需人工清理的 Dify Key ${keyId}`,
        ].join('；'),
      );
    }
  }

  /**
   * Best-effort compensation for an app created by the current authorization.
   * An expired session may be renewed, but cleanup is still restricted to the
   * exact control plane on which this provisioning attempt created the app.
   */
  private async compensateCreatedWorkflowApp(
    authorization: DifyConsoleAuthorization,
    appId: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      let response = await this.deleteConsoleApp(authorization, appId);
      if (response.status === 401 || response.status === 403) {
        const renewed = await this.refreshConsoleAuthorization(authorization);
        if (renewed) {
          this.assertCleanupAuthorizationBase(
            this.normalizeConsoleBase(authorization.consoleBase),
            renewed.consoleBase,
          );
          response = await this.deleteConsoleApp(renewed, appId);
        }
      }
      if (![200, 204, 404].includes(response.status)) {
        throw new ServiceUnavailableException(`补偿删除返回 HTTP ${response.status}`);
      }
      this.logger.warn(`已补偿删除未完成绑定的 Dify 应用 ${appId}`);
    } catch (cleanupError) {
      const message = [
        `Dify 工作流应用创建未完成：${this.safeError(originalError)}`,
        `资源清理失败：${this.safeError(cleanupError)}`,
        `可能遗留需人工清理的 Dify 应用 ${appId}`,
      ].join('；');
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }
  }

  private async deleteConsoleApp(
    authorization: DifyConsoleAuthorization,
    appId: string,
  ): Promise<Response> {
    try {
      return await fetch(
        `${authorization.consoleBase}/apps/${encodeURIComponent(appId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authorization.token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      this.logger.warn(`Dify 应用清理请求失败: ${this.safeError(error)}`);
      throw new ServiceUnavailableException(
        'Dify Console 暂时不可达，工作流尚未删除，请稍后重试',
      );
    }
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
        throw new DifyConsoleAuthorizationError();
      }
      throw new ServiceUnavailableException(`Dify Console 授权验证失败（HTTP ${response.status}）`);
    }
  }

  private async consoleGet(url: string, token: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new DifyConsoleAuthorizationError();
      }
      throw new ServiceUnavailableException(`Dify Console 请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  private async consoleFetch(
    url: string,
    token: string,
    body?: Record<string, unknown>,
    timeoutMs = 15_000,
  ) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`Dify Console 不可达：${this.safeError(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new DifyConsoleAuthorizationError();
      }
      throw new ServiceUnavailableException(`Dify Console 请求失败（HTTP ${response.status}）`);
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
      throw new BadRequestException('DIFY_CONSOLE_BASE 必须是有效的 HTTP(S) URL');
    }
  }

  private encryptionSecret(): string {
    return this.config.get<string>('DIFY_KEY_ENCRYPTION_SECRET', '').trim();
  }

  private encryptionKey(): Buffer {
    const secret = this.encryptionSecret();
    if (secret.length < 32) {
      throw new BadRequestException('DIFY_KEY_ENCRYPTION_SECRET 必须至少包含 32 个字符');
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
      throw new ServiceUnavailableException('已保存的 Dify 凭据格式损坏，请重新授权 Dify');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivRaw, 'base64'));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('无法解密已保存的 Dify 凭据，请重新授权 Dify');
    }
  }

  private fingerprint(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : '未知错误';
  }
}
