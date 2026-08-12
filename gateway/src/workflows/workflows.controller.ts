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
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import type { Response, Request as ExpressRequest } from 'express';
import { WorkflowsService } from './workflows.service';
import { RunPublishedWorkflowDto } from './dto/run-workflow.dto';
import { FlowGramJSON } from '../converter/types';
import { DifyConfigService } from '../dify/dify-config.service';
import { WorkflowCrudService } from './workflow-crud.service';

/**
 * 工作流控制器
 *
 * 路由:
 *   POST /workflows/run       — 已停用的旧草稿直跑入口
 *   GET  /workflows/health    — 网关健康检查
 * 管理员 Dify 诊断统一由受保护的 /admin/dify/status 提供。
 */
@Controller('workflows')
export class WorkflowsController {
  private readonly logger = new Logger(WorkflowsController.name);

  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly difyConfig: DifyConfigService,
    private readonly workflowCrudService: WorkflowCrudService,
  ) {}

  /**
   * POST /workflows/run
   *
   * 草稿由浏览器 runtime-js 试运行；生产执行必须绑定不可变的已发布版本。
   * 旧入口把任意客户端 FlowGram 与一个固定 legacy Dify 应用混用，执行语义
   * 与提交的图不一致，因此明确停用，避免校验/计费对象与实际工作流错位。
   */
  @Post('run')
  runWorkflow() {
    throw new BadRequestException(
      '草稿仅支持在画布中试运行；生产调用请先发布，再使用 /workflows/:id/execute',
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
    if (
      dto.publishedVersion !== undefined
      && dto.publishedVersion !== workflow.publishedVersion
    ) {
      throw new ConflictException(
        `已发布版本已从 v${dto.publishedVersion} 更新为 v${workflow.publishedVersion}，请刷新输入后重试`,
      );
    }
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
      abortSignal?: AbortSignal;
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

    const abortController = new AbortController();
    let clientDisconnected = false;
    const onClose = () => {
      clientDisconnected = true;
      abortController.abort();
    };
    res.once('close', onClose);

    try {
      const stream = this.workflowsService.runWorkflow(
        flowgram,
        user,
        inputs,
        workflowId,
        { ...executionContext, abortSignal: abortController.signal },
      );

      // Admission and validation execute before HTTP 200 + SSE headers.
      const first = await stream.next();
      if (clientDisconnected || res.destroyed) {
        await stream.return?.(undefined);
        return;
      }
      this.openSse(res);
      if (!first.done) this.writeSse(res, first.value);
      for await (const event of stream) {
        // Breaking the async iteration invokes the generator finalizer. That
        // finalizer records a cancelled run and releases its frozen balance.
        if (clientDisconnected || res.destroyed) break;
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
      res.removeListener('close', onClose);
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

}
