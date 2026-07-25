import { Body, Controller, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WorkflowsService } from '../workflows/workflows.service';
import { WorkflowTriggerService } from './workflow-trigger.service';

/** Public token URL. The high-entropy token is hashed at rest and can rotate. */
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly triggers: WorkflowTriggerService,
    private readonly workflows: WorkflowsService,
  ) {}

  @Post(':secret')
  async invoke(
    @Param('secret') secret: string,
    @Body() body: Record<string, any>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ) {
    let triggerId: string | undefined;
    let succeeded = false;
    try {
      const runnable = await this.triggers.resolveWebhook(secret);
      triggerId = runnable.trigger.id;
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
