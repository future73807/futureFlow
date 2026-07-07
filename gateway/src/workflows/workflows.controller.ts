import {
  Controller,
  Post,
  Body,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { WorkflowsService } from './workflows.service';
import { RunWorkflowDto } from './dto/run-workflow.dto';
import { FlowGramJSON } from '../converter/types';
import { Request as ExpressRequest } from 'express';

/**
 * 工作流控制器
 * 接收 FlowGram JSON,执行工作流,以 SSE 流式返回结果
 */
@Controller('workflows')
export class WorkflowsController {
  private readonly logger = new Logger(WorkflowsController.name);

  constructor(private readonly workflowsService: WorkflowsService) {}

  /**
   * POST /workflows/run
   *
   * 请求体: { flowgram: FlowGramJSON }
   * 鉴权: Authorization: Bearer {apiKey}
   *
   * 响应: text/event-stream (SSE)
   * 每条消息格式: data: {event, data}\n\n
   */
  @Post('run')
  @HttpCode(200)
  async runWorkflow(
    @Body() dto: RunWorkflowDto,
    @Res() res: Response,
    // req.user 由 AuthMiddleware 注入
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
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
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

        // 如果有 response 对象(Express 4),手动刷新
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
   * 健康检查
   */
  @Post('health')
  @HttpCode(200)
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
