import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WorkflowCrudService } from './workflow-crud.service';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateWorkflowVersionDto,
  UpdateVersionCommentDto,
  ImportWorkflowDto,
} from './dto/workflow-crud.dto';
import { formatVersionLabel } from '../database/entities/workflow-version.entity';

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

  /** 另存为版本：把当前草稿固化成可回溯记录，请求体只携带说明。 */
  @Post(':id/versions')
  async createVersion(
    @Param('id') id: string,
    @Body() dto: CreateWorkflowVersionDto,
    @Request() req,
  ) {
    return this.crudService.createManualVersion(id, req.user.id, dto);
  }

  @Patch(':id/versions/:version')
  async updateVersionComment(
    @Param('id') id: string,
    @Param('version') version = '',
    @Body() dto: UpdateVersionCommentDto,
    @Request() req,
  ) {
    const normalizedVersion = Number.parseInt(version, 10);
    return this.crudService.updateVersionComment(id, req.user.id, normalizedVersion, dto);
  }

  /** 子工作流节点配置数据：目标工作流已发布快照的入参出参契约。 */
  @Get(':id/subflow-meta')
  async subflowMeta(@Param('id') id: string, @Request() req) {
    return this.crudService.getSubflowMeta(id, req.user.id);
  }

  @Post()
  async create(@Body() dto: CreateWorkflowDto, @Request() req) {
    return this.crudService.create(req.user.id, dto);
  }

  /** 导入接口独立于 POST /workflows：flowgram 传 JSON 对象，名称可省略。 */
  @Post('import')
  async importWorkflow(@Body() dto: ImportWorkflowDto, @Request() req) {
    return this.crudService.importWorkflow(req.user.id, dto);
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
      message: `已发布版本 v${formatVersionLabel(workflow.publishedVersion as number)}`,
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
