import { Body, Controller, Delete, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { TRIGGER_ID_PIPE, WORKFLOW_ID_PIPE } from '../security/uuid-param.pipe';
import { CreateWorkflowTriggerDto, UpdateWorkflowTriggerDto } from './dto/workflow-trigger.dto';
import { WorkflowTriggerService } from './workflow-trigger.service';

@Controller('workflows/:workflowId/triggers')
@UseGuards(JwtAuthGuard)
export class WorkflowTriggerController {
  constructor(private readonly triggers: WorkflowTriggerService) {}

  @Get()
  list(@Param('workflowId', WORKFLOW_ID_PIPE) workflowId: string, @Request() req) {
    return this.triggers.list(req.user.id, workflowId);
  }

  @Post()
  create(
    @Param('workflowId', WORKFLOW_ID_PIPE) workflowId: string,
    @Body() dto: CreateWorkflowTriggerDto,
    @Request() req,
  ) {
    return this.triggers.create(req.user.id, workflowId, dto);
  }

  @Patch(':triggerId')
  update(
    @Param('triggerId', TRIGGER_ID_PIPE) triggerId: string,
    @Body() dto: UpdateWorkflowTriggerDto,
    @Request() req,
  ) {
    return this.triggers.update(req.user.id, triggerId, dto);
  }

  @Post(':triggerId/rotate-webhook')
  rotate(@Param('triggerId', TRIGGER_ID_PIPE) triggerId: string, @Request() req) {
    return this.triggers.rotateWebhook(req.user.id, triggerId);
  }

  @Delete(':triggerId')
  async remove(@Param('triggerId', TRIGGER_ID_PIPE) triggerId: string, @Request() req) {
    await this.triggers.remove(req.user.id, triggerId);
    return { success: true };
  }
}
