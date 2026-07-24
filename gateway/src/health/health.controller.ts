import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/** Liveness and readiness endpoint for reverse proxies and deployment checks. */
@Controller('healthz')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async readiness() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'unavailable',
      });
    }

    return {
      status: 'ok',
      database: 'ready',
      environment: this.config.get<string>('NODE_ENV', 'development'),
      timestamp: new Date().toISOString(),
    };
  }
}
