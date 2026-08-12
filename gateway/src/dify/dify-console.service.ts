import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import {
  DifyConsoleAuthorization,
  DifyConsoleAuthorizationError,
  DifyIntegrationService,
  DifyWorkflowBindingInput,
} from './dify-integration.service';

export interface DifySyncResult {
  appId: string | null;
  status: 'synced' | 'not_configured' | 'failed';
  message: string;
}

interface DifyImportResult {
  id?: unknown;
  app_id?: unknown;
  status?: unknown;
  error?: unknown;
}

/**
 * Publishes an immutable FutureFlow release into its own Dify application.
 * It deliberately has no runtime import method: executing a release must not
 * mutate a shared Dify target or serialize unrelated workflows.
 */
@Injectable()
export class DifyConsoleService implements OnModuleInit {
  private readonly logger = new Logger(DifyConsoleService.name);
  private readonly consoleBase: string;
  private readonly consoleToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly converter: DifyConverterService,
    private readonly integration: DifyIntegrationService,
  ) {
    this.consoleBase = this.config.get<string>(
      'DIFY_CONSOLE_BASE',
      'http://localhost:5001/console/api',
    );
    this.consoleToken = this.config.get<string>('DIFY_CONSOLE_TOKEN', '');
  }

  async onModuleInit() {
    if (await this.isEnabled()) {
      this.logger.log('Dify managed workflow provisioning is enabled');
    } else {
      this.logger.warn('Dify managed workflow provisioning is disabled until an administrator authorizes the Console');
    }
  }

  async syncPublishedWorkflow(
    input: DifyWorkflowBindingInput & { flowgram: FlowGramJSON },
  ): Promise<DifySyncResult> {
    let authorization = await this.resolveAuthorization();
    if (!authorization) {
      return {
        appId: null,
        status: 'not_configured',
        message: 'Dify Console 尚未授权；版本快照已保存，但同步完成前不能在云端运行。',
      };
    }

    // Retry the complete immutable-release provisioning transaction once.  A
    // 401 can happen before an app exists, while creating its key, during DSL
    // import, or at publish time.  Retrying only the last HTTP call leaves
    // partially provisioned resources and can activate the wrong state.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.syncWithAuthorization(input, authorization);
      } catch (error) {
        if (error instanceof DifyConsoleAuthorizationError) {
          if (attempt === 0) {
            const renewed = await this.integration.refreshConsoleAuthorization(authorization);
            if (renewed) {
              authorization = renewed;
              continue;
            }
          }
          await this.integration.markConsoleAuthorizationExpired();
        }
        return this.failedSyncResult(error);
      }
    }

    return this.failedSyncResult(new Error('Dify Console 授权重试未完成'));
  }

  async isEnabled(): Promise<boolean> {
    return Boolean(await this.resolveAuthorization());
  }

  private resolveAuthorization(): Promise<DifyConsoleAuthorization | null> {
    return this.integration.resolveConsoleAuthorization(this.consoleToken, this.consoleBase);
  }

  private async syncWithAuthorization(
    input: DifyWorkflowBindingInput & { flowgram: FlowGramJSON },
    authorization: DifyConsoleAuthorization,
  ): Promise<DifySyncResult> {
    const binding = await this.integration.ensureWorkflowIntegration(input, authorization);
    const response = await this.importDsl(authorization, binding.appId!, input.flowgram);
    this.throwIfAuthorizationRejected(response);
    let result = (await response.json().catch(() => ({}))) as DifyImportResult;
    if (!response.ok) {
      return {
        appId: binding.appId,
        status: 'failed',
        message: `Dify DSL 导入失败（HTTP ${response.status}），请检查节点配置和 Dify 服务状态。`,
      };
    }

    if (!this.importResultTargetsApp(result, binding.appId!)) {
      return {
        appId: binding.appId,
        status: 'failed',
        message: 'Dify DSL 导入返回了不一致的应用，已拒绝发布。',
      };
    }

    if (this.importStatus(result) === 'pending') {
      const importId = typeof result.id === 'string' ? result.id.trim() : '';
      if (!importId) {
        return {
          appId: binding.appId,
          status: 'failed',
          message: 'Dify DSL 导入仍待确认，但未返回可确认的导入 ID，应用保持未发布状态。',
        };
      }

      const confirmation = await this.confirmImport(authorization, importId);
      this.throwIfAuthorizationRejected(confirmation);
      result = (await confirmation.json().catch(() => ({}))) as DifyImportResult;
      if (!confirmation.ok) {
        return {
          appId: binding.appId,
          status: 'failed',
          message: `Dify DSL 导入确认失败（HTTP ${confirmation.status}），应用保持未发布状态。`,
        };
      }
      if (!this.importResultTargetsApp(result, binding.appId!)) {
        return {
          appId: binding.appId,
          status: 'failed',
          message: 'Dify DSL 导入确认返回了不一致的应用，已拒绝发布。',
        };
      }
    }

    const completedStatus = this.importStatus(result);
    if (!this.isCompletedImportStatus(completedStatus)) {
      return {
        appId: binding.appId,
        status: 'failed',
        message: `Dify DSL 导入尚未明确完成（状态：${completedStatus || 'unknown'}），应用保持未发布状态。`,
      };
    }

    const publishResponse = await this.publishWorkflow(authorization, binding.appId!);
    this.throwIfAuthorizationRejected(publishResponse);
    if (!publishResponse.ok) {
      const publishError = await publishResponse.text().catch(() => '未知错误');
      this.logger.warn(`Workflow publish returned ${publishResponse.status}: ${publishError}`);
      return {
        appId: binding.appId,
        status: 'failed',
        message: `Dify 工作流发布失败（HTTP ${publishResponse.status}），请检查 Dify 服务状态后重试。`,
      };
    }

    await this.integration.activateWorkflowIntegration(input.workflowId, input.workflowVersion);
    return {
      appId: binding.appId,
      status: 'synced',
      message: `Dify 应用 ${binding.appId} 已接收并发布工作流 v${input.workflowVersion}（状态：${completedStatus}）。`,
    };
  }

  private importStatus(result: DifyImportResult): string {
    return typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
  }

  private isCompletedImportStatus(status: string): boolean {
    return status === 'completed' || status === 'completed-with-warnings';
  }

  private importResultTargetsApp(result: DifyImportResult, expectedAppId: string): boolean {
    if (result.app_id === undefined || result.app_id === null || result.app_id === '') return true;
    return typeof result.app_id === 'string' && result.app_id.trim() === expectedAppId;
  }

  private throwIfAuthorizationRejected(response: Response): void {
    if (response.status === 401 || response.status === 403) {
      throw new DifyConsoleAuthorizationError();
    }
  }

  private failedSyncResult(error: unknown): DifySyncResult {
    const message = error instanceof Error ? error.message : '未知错误';
    this.logger.error(`Dify publish synchronization failed: ${message}`);
    const localizedDetail = /[\u3400-\u9fff]/u.test(message)
      ? message
      : '请检查 Dify Console 授权、网络连接和服务状态后重试';
    return {
      appId: null,
      status: 'failed',
      message: `Dify 发布同步失败：${localizedDetail}。`,
    };
  }

  private importDsl(
    authorization: DifyConsoleAuthorization,
    appId: string,
    flowgram: FlowGramJSON,
  ): Promise<Response> {
    return fetch(`${authorization.consoleBase}/apps/imports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authorization.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'yaml-content',
        yaml_content: this.converter.toDifyDSLYaml(flowgram),
        app_id: appId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private confirmImport(
    authorization: DifyConsoleAuthorization,
    importId: string,
  ): Promise<Response> {
    return fetch(
      `${authorization.consoleBase}/apps/imports/${encodeURIComponent(importId)}/confirm`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${authorization.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  }

  private publishWorkflow(
    authorization: DifyConsoleAuthorization,
    appId: string,
  ): Promise<Response> {
    return fetch(`${authorization.consoleBase}/apps/${appId}/workflows/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authorization.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
  }
}
