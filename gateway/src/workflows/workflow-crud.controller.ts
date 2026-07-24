import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkflowCrudService } from './workflow-crud.service';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow-crud.dto';

@Controller('workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowCrudController {
  constructor(private readonly crudService: WorkflowCrudService) {}

  @Get()
  async list(@Request() req) {
    return this.crudService.listByUser(req.user.id);
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Request() req) {
    return this.crudService.getById(id, req.user.id);
  }

  @Get(':id/runs')
  async listRuns(
    @Param('id') id: string,
    @Request() req,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '30',
  ) {
    const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const normalizedPageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 30));
    return this.crudService.listRuns(id, req.user.id, normalizedPage, normalizedPageSize);
  }

  @Get(':id/versions')
  async listVersions(@Param('id') id: string, @Request() req) {
    return this.crudService.listVersions(id, req.user.id);
  }

  @Post()
  async create(@Body() dto: CreateWorkflowDto, @Request() req) {
    return this.crudService.create(req.user.id, dto);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
    @Request() req,
  ) {
    return this.crudService.update(id, req.user.id, dto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Request() req) {
    await this.crudService.delete(id, req.user.id);
    return { success: true };
  }

  @Post(':id/duplicate')
  async duplicate(@Param('id') id: string, @Request() req) {
    return this.crudService.duplicate(id, req.user.id);
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string, @Request() req) {
    const published = await this.crudService.publish(id, req.user.id);
    const { difySync, ...workflow } = published;
    return {
      workflow,
      endpoint: `/workflows/${workflow.id}/execute`,
      dify: difySync,
      message: `已发布版本 v${workflow.publishedVersion}`,
    };
  }

  @Post(':id/dify/sync')
  async syncDify(@Param('id') id: string, @Request() req) {
    return this.crudService.syncPublishedDify(id, req.user.id);
  }

  @Post(':id/unpublish')
  async unpublish(@Param('id') id: string, @Request() req) {
    const workflow = await this.crudService.unpublish(id, req.user.id);
    return { workflow, success: true };
  }

  /** Restoring is intentionally a draft-only operation; publish remains explicit. */
  @Post(':id/versions/:version/restore')
  async restoreVersion(
    @Param('id') id: string,
    @Param('version') version = '',
    @Request() req,
  ) {
    const normalizedVersion = Number.parseInt(version, 10);
    return this.crudService.restoreVersion(id, req.user.id, normalizedVersion);
  }
}
