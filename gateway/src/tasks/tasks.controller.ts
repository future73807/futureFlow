import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  CreateBatchTaskDto,
  ListAsyncRunsQueryDto,
  ListBatchTasksQueryDto,
} from './dto/tasks.dto';
import { TasksService } from './tasks.service';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const strictValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/**
 * 任务中心：
 *   GET  /tasks/batch            — 批量任务列表（概要，不含 inputs/results）
 *   POST /tasks/batch            — 创建批量任务并启动后台执行
 *   GET  /tasks/batch/:id        — 任务详情（含 inputs/results，供轮询进度）
 *   POST /tasks/batch/:id/cancel — 取消任务
 *   GET  /tasks/async            — 异步触发运行记录（webhook/schedule/api）
 */
@UseGuards(JwtAuthGuard)
@UsePipes(strictValidation)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  private currentUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('未认证');
    return String(userId);
  }

  private assertTaskId(taskId: string): void {
    if (!UUID.test(taskId)) {
      throw new BadRequestException('任务 ID 格式无效');
    }
  }

  @Get('batch')
  listBatchTasks(
    @Request() req: any,
    @Query() query: ListBatchTasksQueryDto,
  ) {
    return this.tasks.listBatchTasks(
      this.currentUserId(req),
      query.page,
      query.pageSize,
      query.status,
    );
  }

  @Post('batch')
  createBatchTask(@Request() req: any, @Body() dto: CreateBatchTaskDto) {
    return this.tasks.createBatchTask(this.currentUserId(req), dto);
  }

  @Get('batch/:id')
  getBatchTask(@Request() req: any, @Param('id') id: string) {
    this.assertTaskId(id);
    return this.tasks.getBatchTask(this.currentUserId(req), id);
  }

  @Post('batch/:id/cancel')
  @HttpCode(200)
  cancelBatchTask(@Request() req: any, @Param('id') id: string) {
    this.assertTaskId(id);
    return this.tasks.cancelBatchTask(this.currentUserId(req), id);
  }

  @Get('async')
  listAsyncRuns(
    @Request() req: any,
    @Query() query: ListAsyncRunsQueryDto,
  ) {
    return this.tasks.listAsyncRuns(
      this.currentUserId(req),
      query.page,
      query.pageSize,
      query.source,
    );
  }
}
