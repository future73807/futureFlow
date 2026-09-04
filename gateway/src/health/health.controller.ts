import { Controller, Get, Query, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { DifyClientService } from '../dify/dify-client.service';

/** Liveness and readiness endpoint for reverse proxies and deployment checks. */
@Controller('healthz')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly difyClient: DifyClientService,
  ) {}

  @Get()
  async readiness(@Query('detailed') detailed = '') {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'unavailable',
      });
    }

    const result: Record<string, unknown> = {
      status: 'ok',
      database: 'ready',
      environment: this.config.get<string>('NODE_ENV', 'development'),
      timestamp: new Date().toISOString(),
    };

    // detailed 模式附带 Dify 引擎可达性（不触碰管理员凭据，仅 Service API 探测）。
    if (detailed === '1' || detailed === 'true') {
      const dify = await this.difyClient.ping();
      result.dify = {
        configured: dify.reachable,
        latencyMs: dify.latency ?? null,
        error: dify.error ?? null,
      };
    }

    return result;
  }
}
