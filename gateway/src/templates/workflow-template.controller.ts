import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CreateFromTemplateDto } from './dto/create-from-template.dto';
import { WorkflowTemplateService } from './workflow-template.service';

@Controller('workflow-templates')
@UseGuards(JwtAuthGuard)
export class WorkflowTemplateController {
  constructor(private readonly templates: WorkflowTemplateService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Post(':id/create-workflow')
  createWorkflow(
    @Param('id') id: string,
    @Body() dto: CreateFromTemplateDto,
    @Request() req,
  ) {
    return this.templates.createWorkflow(req.user.id, id, dto.name);
  }
}
