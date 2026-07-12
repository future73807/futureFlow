import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { WorkflowsService } from './workflows.service';
import { RunWorkflowDto } from './dto/run-workflow.dto';
import { FlowGramJSON } from '../converter/types';
import { DifyConfigService } from '../dify/dify-config.service';
import { DifyClientService } from '../dify/dify-client.service';
import { Request as ExpressRequest } from 'express';

/**
 * 工作流控制器
 *
 * 路由:
 *   POST /workflows/run       — 执行工作流(SSE 流式)
 *   GET  /workflows/health    — 网关健康检查
 *   GET  /workflows/dify-status — Dify 配置状态与连通性
 */
@Controller('workflows')
export class WorkflowsController {
  private readonly logger = new Logger(WorkflowsController.name);

  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly difyConfig: DifyConfigService,
    private readonly difyClient: DifyClientService,
  ) {}

  /**
   * POST /workflows/run
   *
   * 请求体: { flowgram: FlowGramJSON }
   * 鉴权: Authorization: Bearer {JWT 或 API Key}
   *
   * 响应: text/event-stream (SSE)
   * 每条消息格式: data: {event, data}\n\n
   *
   * 执行引擎:
   *   - Dify 已配置 → 走 Dify Service API
   *   - Dify 未配置 → 降级到直接 LLM 模式(返回 engine_degraded 事件后继续执行)
   */
  @Post('run')
  @HttpCode(200)
  async runWorkflow(
    @Body() dto: RunWorkflowDto,
    @Res() res: Response,
  ) {
    const req = res.req as ExpressRequest & { user: any };
    const user = req.user;

    if (!user) {
      res.status(401).json({ error: '未认证' });
      return;
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.logger.log(
      `开始执行工作流: userId=${user.id}, username=${user.username}`,
    );

    try {
      const stream = this.workflowsService.runWorkflow(
        dto.flowgram as FlowGramJSON,
        user,
      );

      for await (const event of stream) {
        const data = JSON.stringify(event);
        res.write(`data: ${data}\n\n`);

        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }

        // 工作流结束或出错时关闭连接
        if (
          event.event === 'workflow_finished' ||
          event.event === 'error'
        ) {
          break;
        }
      }
    } catch (error) {
      this.logger.error(`工作流执行错误: ${error.message}`);
      const errorEvent = {
        event: 'error',
        data: {
          status: error.status || 500,
          code: error.code || 'internal_error',
          message: error.message,
        },
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    } finally {
      res.end();
    }
  }

  /**
   * GET /workflows/health
   * 网关健康检查
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      difyConfigured: this.difyConfig.isConfigured(),
    };
  }

  /**
   * GET /workflows/dify-status
   * Dify 配置状态与连通性探测
   *
   * 返回:
   *   - config: 配置校验结果(状态、脱敏 Key、提示信息)
   *   - connectivity: Dify 服务连通性(可达性、延迟)
   */
  @Get('dify-status')
  async difyStatus() {
    const config = this.difyConfig.getValidation();
    const connectivity = await this.difyClient.ping();

    return {
      config: {
        status: config.status,
        apiBase: config.apiBase,
        maskedKey: config.maskedKey,
        message: config.message,
        suggestion: config.suggestion,
      },
      connectivity: {
        reachable: connectivity.reachable,
        latency: connectivity.latency,
        error: connectivity.error,
      },
      executionMode: this.difyConfig.isConfigured() ? 'dify' : 'direct-llm',
    };
  }
}
