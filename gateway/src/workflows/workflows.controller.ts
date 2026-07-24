import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  Headers,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { WorkflowsService } from './workflows.service';
import { RunPublishedWorkflowDto, RunWorkflowDto } from './dto/run-workflow.dto';
import { FlowGramJSON } from '../converter/types';
import { DifyConfigService } from '../dify/dify-config.service';
import { DifyClientService } from '../dify/dify-client.service';
import { Request as ExpressRequest } from 'express';
import { WorkflowCrudService } from './workflow-crud.service';

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
    private readonly workflowCrudService: WorkflowCrudService,
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const req = res.req as ExpressRequest & { user: any };
    return this.streamWorkflow(
      dto.flowgram as FlowGramJSON,
      dto.inputs || {},
      req.user,
      res,
      undefined,
      { source: 'manual', idempotencyKey },
    );
  }

  /**
   * 执行已发布的工作流快照。
   * 认证支持 JWT 和平台 API Key，客户端只能传入 Start 节点定义的 inputs。
   */
  @Post(':id/execute')
  @HttpCode(200)
  async executePublishedWorkflow(
    @Param('id') id: string,
    @Body() dto: RunPublishedWorkflowDto,
    @Res() res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const req = res.req as ExpressRequest & { user: any };
    if (!req.user) {
      res.status(401).json({ error: '未认证' });
      return;
    }

    const workflow = await this.workflowCrudService.getPublished(id, req.user.id);
    return this.streamWorkflow(
      workflow.publishedFlowgramJson as FlowGramJSON,
      dto.inputs || {},
      req.user,
      res,
      id,
      {
        source: 'api',
        idempotencyKey,
        workflowVersion: workflow.publishedVersion || undefined,
      },
    );
  }

  private async streamWorkflow(
    flowgram: FlowGramJSON,
    inputs: Record<string, string | number | boolean>,
    user: any,
    res: Response,
    workflowId?: string,
    executionContext: {
      source?: string;
      triggerId?: string;
      idempotencyKey?: string;
      workflowVersion?: number;
    } = {},
  ) {
    if (!user) {
      res.status(401).json({ error: '未认证' });
      return;
    }

    // 设置 SSE 响应头
    this.logger.log(
      `开始执行工作流: userId=${user.id}, username=${user.username}`,
    );

    try {
      const stream = this.workflowsService.runWorkflow(
        flowgram,
        user,
        inputs,
        workflowId,
        executionContext,
      );

      // Admission and validation execute before HTTP 200 + SSE headers.
      const first = await stream.next();
      this.openSse(res);
      if (!first.done) this.writeSse(res, first.value);
      for await (const event of stream) {
        this.writeSse(res, event);

        // 不在 workflow_finished/error 事件处提前 break。
        // WorkflowsService 会在最后一个事件之后完成扣费结算或失败退款，
        // 必须继续迭代到生成器自然结束。
      }
    } catch (error) {
      this.logger.error(`工作流执行错误: ${error.message}`);
      if (!res.headersSent) {
        const status = typeof error.getStatus === 'function' ? error.getStatus() : error.status || 500;
        res.status(status).json({
          error: error.response?.message || error.message,
          code: error.response?.code || error.code || 'workflow_execution_failed',
        });
        return;
      }
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
      if (!res.writableEnded) res.end();
    }
  }

  private openSse(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  private writeSse(res: Response, event: any) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();
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
      executionMode: (await this.difyClient.isConfigured()) ? 'dify' : 'direct-llm',
    };
  }
}
