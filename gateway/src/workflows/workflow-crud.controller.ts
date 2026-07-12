import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
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
}
