import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';

/**
 * Dify Console API 服务
 * 负责通过 Console API 导入/更新工作流 DSL
 *
 * 注意:Console API 需要用户登录态(Console Bearer Token),
 * 与 Service API(app- 前缀密钥)不同。
 */
@Injectable()
export class DifyConsoleService implements OnModuleInit {
  private readonly logger = new Logger(DifyConsoleService.name);
  private readonly consoleBase: string;
  private readonly consoleToken: string;
  private readonly appId: string;
  private readonly enabled: boolean;

  constructor(
    private config: ConfigService,
    private converter: DifyConverterService,
  ) {
    this.consoleBase = this.config.get<string>(
      'DIFY_CONSOLE_BASE',
      'http://localhost/console/api',
    );
    this.consoleToken = this.config.get<string>('DIFY_CONSOLE_TOKEN', '');
    this.appId = this.config.get<string>('DIFY_APP_ID', '');
    // 仅当 console token 和 app id 都配置了才启用
    this.enabled = !!(this.consoleToken && this.appId);
  }

  onModuleInit() {
    if (this.enabled) {
      this.logger.log(
        `Dify Console API 已启用: ${this.consoleBase}, appId=${this.appId}`,
      );
    } else {
      this.logger.warn(
        'Dify Console API 未配置(缺少 DIFY_CONSOLE_TOKEN 或 DIFY_APP_ID),将跳过 DSL 自动导入。请确保 Dify 中已存在对应工作流应用。',
      );
    }
  }

  /**
   * 将 FlowGram JSON 转换为 Dify DSL 并导入到 Dify
   * 如果配置了 appId,则更新现有应用;否则创建新应用
   *
   * @returns { appId, success } 导入结果
   */
  async importWorkflow(flowgram: FlowGramJSON): Promise<{
    appId: string;
    success: boolean;
    message: string;
  }> {
    if (!this.enabled) {
      return {
        appId: this.appId,
        success: false,
        message: 'Console API 未配置,跳过 DSL 导入。使用预配置的工作流应用。',
      };
    }

    const dslYaml = this.converter.toDifyDSLYaml(flowgram);

    try {
      const url = `${this.consoleBase}/apps/imports`;
      const body: any = {
        mode: 'yaml-content',
        yaml_content: dslYaml,
      };

      // 如果有 appId,则更新现有应用
      if (this.appId) {
        body.app_id = this.appId;
      }

      this.logger.log(
        `导入 Dify DSL: ${url}, mode=yaml-content, appId=${this.appId || '(新建)'}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.consoleToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (response.status === 200 || response.status === 202) {
        const importedAppId = result.app_id || this.appId;
        this.logger.log(
          `DSL 导入成功: appId=${importedAppId}, status=${result.status}`,
        );
        return {
          appId: importedAppId,
          success: true,
          message: `DSL 导入成功 (${result.status})`,
        };
      } else {
        this.logger.error(`DSL 导入失败: ${JSON.stringify(result)}`);
        return {
          appId: this.appId,
          success: false,
          message: `DSL 导入失败: ${result.error || response.statusText}`,
        };
      }
    } catch (error) {
      this.logger.error(`DSL 导入异常: ${error.message}`);
      return {
        appId: this.appId,
        success: false,
        message: `DSL 导入异常: ${error.message}`,
      };
    }
  }

  /** 检查 Console API 是否启用 */
  isEnabled(): boolean {
    return this.enabled;
  }
}
