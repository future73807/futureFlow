import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Dify 配置状态
 */
export type DifyConfigStatus =
  | 'configured' // 已正确配置，走 Dify 执行路径
  | 'not_configured' // 未配置（占位值或空），执行将报错
  | 'invalid_format' // 格式错误（非 app- 前缀）
  | 'missing_base'; // 缺少 API Base

export interface DifyConfigValidation {
  status: DifyConfigStatus;
  apiKey: string;
  apiBase: string;
  maskedKey: string; // 脱敏显示
  message: string;
  suggestion: string;
}

/**
 * Dify 配置校验服务
 *
 * 职责：
 * 1. 读取 .env 中的 DIFY_API_KEY 和 DIFY_API_BASE
 * 2. 验证 DIFY_API_KEY 必须为 "app-" 前缀的密钥格式
 * 3. 提供配置状态查询接口（供健康检查和前端展示）
 * 4. 启动时自动校验并输出诊断日志
 */
@Injectable()
export class DifyConfigService implements OnModuleInit {
  private readonly logger = new Logger(DifyConfigService.name);
  private readonly apiKey: string;
  private readonly apiBase: string;
  private validation: DifyConfigValidation;

  // app- 前缀 + 至少 16 位字母数字的密钥格式
  private static readonly API_KEY_PATTERN = /^app-[a-zA-Z0-9]{16,}$/;
  // 已知的占位值
  private static readonly PLACEHOLDER_VALUES = [
    'app-xxxxxxxxxxxxxxxx',
    'app-xxxxxxxx',
    '',
  ];

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('DIFY_API_KEY', '').trim();
    this.apiBase = this.config
      .get<string>('DIFY_API_BASE', 'http://localhost:5001/v1')
      .trim();
    this.validation = this.validate();
  }

  onModuleInit() {
    const v = this.validation;
    switch (v.status) {
      case 'configured':
        this.logger.log(
          `Dify Service API is configured: base=${v.apiBase}`,
        );
        this.logger.log(
          `   工作流将走 Dify 执行路径(Service API SSE 流式)`,
        );
        break;
      case 'not_configured':
        this.logger.warn(
          `⚠️  Dify 未配置(${v.message})`,
        );
        this.logger.warn(v.suggestion);
        break;
      case 'invalid_format':
        this.logger.error(
          `❌ DIFY_API_KEY 格式错误: ${v.message}`,
        );
        this.logger.error(v.suggestion);
        break;
      case 'missing_base':
        this.logger.error(
          `❌ DIFY_API_BASE 未配置`,
        );
        break;
    }
  }

  /**
   * 校验 DIFY_API_KEY 配置
   */
  private validate(): DifyConfigValidation {
    const maskedKey = this.maskKey(this.apiKey);

    // 1. 检查 API Base
    if (!this.apiBase) {
      return {
        status: 'missing_base',
        apiKey: this.apiKey,
        apiBase: '',
        maskedKey,
        message: 'DIFY_API_BASE 未配置',
        suggestion:
          '请在 .env 中设置 DIFY_API_BASE，例如: http://localhost:5001/v1',
      };
    }

    // 2. 检查 API Key 是否为空或占位值
    if (
      !this.apiKey ||
      DifyConfigService.PLACEHOLDER_VALUES.includes(this.apiKey)
    ) {
      return {
        status: 'not_configured',
        apiKey: this.apiKey,
        apiBase: this.apiBase,
        maskedKey,
        message: 'DIFY_API_KEY 为空或占位值',
        suggestion:
          '请在 Dify 控制台(http://localhost:8080)创建工作流应用，' +
          '然后在「访问 API」页面复制 app- 前缀的 API Key，' +
          '填入 .env 的 DIFY_API_KEY 变量中。',
      };
    }

    // 3. 校验 API Key 格式：必须为 app- 前缀
    if (!this.apiKey.startsWith('app-')) {
      return {
        status: 'invalid_format',
        apiKey: this.apiKey,
        apiBase: this.apiBase,
        maskedKey,
        message: `DIFY_API_KEY 必须为 "app-" 前缀的密钥，当前值以 "${this.apiKey.slice(0, 4)}" 开头`,
        suggestion:
          'Dify Service API Key 格式为 "app-xxxxxxxxxxxxxxxx"。' +
          '请在 Dify 控制台 > 应用 > 访问 API 页面获取正确的密钥。',
      };
    }

    // 4. 校验 app- 后面的密钥长度
    if (!DifyConfigService.API_KEY_PATTERN.test(this.apiKey)) {
      return {
        status: 'invalid_format',
        apiKey: this.apiKey,
        apiBase: this.apiBase,
        maskedKey,
        message: `DIFY_API_KEY 格式不符合要求: app- 后需至少 16 位字母数字`,
        suggestion:
          'Dify Service API Key 格式为 "app-" + 至少 16 位字母数字字符。' +
          '请检查是否完整复制了密钥。',
      };
    }

    // 5. 配置正确
    return {
      status: 'configured',
      apiKey: this.apiKey,
      apiBase: this.apiBase,
      maskedKey,
      message: 'Dify 配置正确',
      suggestion: '',
    };
  }

  /**
   * Dify 是否已正确配置（可供 WorkflowsService 判断执行路径）
   */
  isConfigured(): boolean {
    return this.validation.status === 'configured';
  }

  isValidApiKey(apiKey: string): boolean {
    return Boolean(apiKey) && DifyConfigService.API_KEY_PATTERN.test(apiKey);
  }

  /**
   * 获取配置校验结果（供健康检查接口返回）
   */
  getValidation(): DifyConfigValidation {
    return this.validation;
  }

  /**
   * 获取 API Key
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * 获取 API Base
   */
  getApiBase(): string {
    return this.apiBase;
  }

  /**
   * 对 API Key 脱敏：app-xxxxxxxx...xxxx
   */
  private maskKey(key: string): string {
    if (!key) return '(空)';
    if (key.length <= 12) return `${key.slice(0, 4)}****`;
    return `${key.slice(0, 8)}...${key.slice(-4)}`;
  }
}
