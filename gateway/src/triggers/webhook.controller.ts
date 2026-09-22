import { BadRequestException, Body, Controller, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { WebhookRateLimitService } from './webhook-rate-limit.service';
import { Public } from '../common/decorators/public.decorator';

/** Public token URL. The high-entropy token is hashed at rest and can rotate. */
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly triggers: WorkflowTriggerService,
    private readonly workflows: WorkflowsService,
    private readonly rateLimit: WebhookRateLimitService,
  ) {}

  /**
   * 密钥可以放在 `X-Webhook-Secret` 头里，也可以（旧方式，已不推荐）放在路径里。
   * 路径里的密钥会被反向代理、网关和浏览器历史原样记进日志，所以新调用方一律
   * 走头；旧的 `/webhooks/:secret` 仍可用，避免打断已经发出去的地址。
   */
  @Public()
  @Post(['', ':secret'])
  async invoke(
    @Param('secret') pathSecret: string | undefined,
    @Headers('x-webhook-secret') headerSecret: string | undefined,
    @Body() body: Record<string, any>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ) {
    let triggerId: string | undefined;
    let succeeded = false;
    try {
      const secret = (headerSecret || pathSecret || '').trim();
      if (!secret) {
        throw new BadRequestException({
          message: '缺少 webhook 密钥：请用 X-Webhook-Secret 请求头传递',
          code: 'webhook_secret_missing',
        });
      }
      if (!headerSecret && pathSecret) {
        res.setHeader('X-Webhook-Secret-Source', 'path-deprecated');
      }
      const runnable = await this.triggers.resolveWebhook(secret);
      triggerId = runnable.trigger.id;
      // 无需认证的公网入口：按触发器限流兜底，防泄漏地址被无限刷调用消耗计费。
      this.rateLimit.assertAllowed(triggerId);
      const bodyInputs = body?.inputs && typeof body.inputs === 'object' ? body.inputs : {};
      const inputs = { ...(runnable.trigger.staticInputs || {}), ...bodyInputs };
      const stream = this.workflows.runWorkflow(
        runnable.workflow.publishedFlowgramJson as any,
        runnable.user,
        inputs,
        runnable.workflow.id,
        {
          source: 'webhook',
          triggerId,
          idempotencyKey,
          workflowVersion: runnable.workflow.publishedVersion || undefined,
        },
      );

      const first = await stream.next();
      this.openSse(res);
      if (!first.done) this.writeSse(res, first.value);
      for await (const event of stream) {
        if (event.event === 'workflow_finished' && event.data?.status === 'succeeded') succeeded = true;
        this.writeSse(res, event);
      }
    } catch (error) {
      if (!res.headersSent) {
        const status = typeof error.getStatus === 'function' ? error.getStatus() : error.status || 500;
        res.status(status).json({
          error: error.response?.message || error.message,
          code: error.response?.code || error.code || 'webhook_execution_failed',
        });
        return;
      }
      this.writeSse(res, {
        event: 'error',
        data: { status: error.status || 500, code: error.code || 'webhook_execution_failed', message: error.message },
      });
    } finally {
      if (triggerId) await this.triggers.recordResult(triggerId, succeeded);
      if (!res.writableEnded) res.end();
    }
  }

  private openSse(res: Response) {
    res.status(200);
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
}
