import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import {
  DifyConsoleAuthorization,
  DifyIntegrationService,
  DifyWorkflowBindingInput,
} from './dify-integration.service';

export interface DifySyncResult {
  appId: string | null;
  status: 'synced' | 'not_configured' | 'failed';
  message: string;
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
        message: 'Dify Console is not authorized; the release remains available through the configured direct LLM engine.',
      };
    }

    try {
      let binding = await this.integration.ensureWorkflowIntegration(input, authorization);
      let response = await this.importDsl(authorization, binding.appId!, input.flowgram);
      if (response.status === 401 || response.status === 403) {
        const refreshed = await this.integration.refreshConsoleAuthorization();
        if (refreshed) {
          authorization = refreshed;
          // Binding creation can have failed because the old token expired.
          binding = await this.integration.ensureWorkflowIntegration(input, authorization);
          response = await this.importDsl(authorization, binding.appId!, input.flowgram);
        }
      }
      const result = (await response.json().catch(() => ({}))) as {
        app_id?: string;
        status?: string;
        error?: string;
      };
      if (response.status === 200 || response.status === 202) {
        // Publish the workflow after import
        const publishResponse = await this.publishWorkflow(authorization, binding.appId!);
        if (publishResponse.status !== 200 && publishResponse.status !== 201) {
          const publishError = await publishResponse.text().catch(() => 'unknown error');
          this.logger.warn(`Workflow publish returned ${publishResponse.status}: ${publishError}`);
        }
        await this.integration.activateWorkflowIntegration(input.workflowId, input.workflowVersion);
        return {
          appId: binding.appId,
          status: 'synced',
          message: `Dify application ${binding.appId} accepted release v${input.workflowVersion} (${result.status || response.status}).`,
        };
      }
      if (response.status === 401 || response.status === 403) {
        await this.integration.markConsoleAuthorizationExpired();
      }
      return {
        appId: binding.appId,
        status: 'failed',
        message: `Dify DSL import failed (${response.status}): ${result.error || response.statusText}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Dify publish synchronization failed: ${message}`);
      return { appId: null, status: 'failed', message: `Dify publish synchronization failed: ${message}` };
    }
  }

  async isEnabled(): Promise<boolean> {
    return Boolean(await this.resolveAuthorization());
  }

  private resolveAuthorization(): Promise<DifyConsoleAuthorization | null> {
    return this.integration.resolveConsoleAuthorization(this.consoleToken, this.consoleBase);
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
