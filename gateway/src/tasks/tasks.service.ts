import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import {
  BatchTask,
  BatchTaskInputRow,
  BatchTaskRowResult,
} from '../database/entities/batch-task.entity';
import { User } from '../database/entities/user.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { DifySSEEvent } from '../dify/dify-client.service';
import { DraftRunService } from '../workflows/draft-run.service';
import { WorkflowCrudService } from '../workflows/workflow-crud.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ASYNC_RUN_SOURCES, CreateBatchTaskDto } from './dto/tasks.dto';

/** 与 DTO 上限保持一致；服务层防御内部调用绕过校验。 */
const MAX_INPUT_ROWS = 200;
const MAX_INPUT_KEYS = 50;
/** jsonb 中单行输出/错误的存储上限，防止超长文本拖垮列表与详情接口。 */
const MAX_ROW_TEXT_LENGTH = 2000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** 终态任务不允许再次取消，避免已完成任务被改写状态。 */
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** 内存中的取消标记；AbortController 用于中断当前行的 Dify 事件流。 */
interface BatchTaskCancellation {
  cancelled: boolean;
  controller?: AbortController;
}

interface BatchExecutionPlan {
  flowgram: FlowGramJSON;
  executionContext: {
    source: 'batch';
    workflowVersion?: number;
    sandboxApiKey?: string;
  };
  /** 本次是否刚把草稿重新导入并发布到沙箱（首次调用可能撞上 Dify 应用就绪延迟）。 */
  freshSandbox: boolean;
}

/**
 * 任务中心服务：批量任务（后台逐行执行 + 轮询进度）与异步触发运行记录。
 * 批量执行必须逐行串行，保证同一任务的计费/运行记录顺序可预期。
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  private readonly cancellations = new Map<string, BatchTaskCancellation>();

  constructor(
    @InjectRepository(BatchTask)
    private readonly batchTaskRepo: Repository<BatchTask>,
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly workflowsService: WorkflowsService,
    private readonly workflowCrud: WorkflowCrudService,
    private readonly converter: DifyConverterService,
    private readonly draftRun: DraftRunService,
  ) {}

  async listBatchTasks(
    userId: string,
    page?: number,
    pageSize?: number,
    status?: string,
  ) {
    const pagination = this.normalizePagination(page, pageSize);
    const where: FindOptionsWhere<BatchTask> = { userId };
    if (status) where.status = status;
    const [items, total] = await this.batchTaskRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    });
    return {
      items: items.map((task) => this.toSummary(task)),
      total,
      ...pagination,
    };
  }

  async createBatchTask(userId: string, dto: CreateBatchTaskDto) {
    const inputs = this.sanitizeInputs(dto.inputs);
    // getById 同时校验工作流归属；名称在此快照，工作流之后被删除也不影响任务展示。
    // 创建期校验违规统一返回 400，且不区分「不存在」与「无权」，避免探测他人工作流。
    let workflow: Workflow;
    try {
      workflow = await this.workflowCrud.getById(dto.workflowId, userId);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw new BadRequestException('工作流不存在或无权访问');
      }
      throw error;
    }
    // 草稿要经 DSL 转换才能导入沙箱执行；把转换门禁前移到创建期，
    // 避免建出一个注定失败的任务（错误信息也能直接显示在创建弹窗里）。
    if ((dto.mode ?? 'published') === 'draft') {
      try {
        this.converter.toDifyDSL(workflow.flowgramJson as FlowGramJSON);
      } catch (error) {
        throw new BadRequestException(
          `当前草稿无法执行：${this.errorMessage(error)}`.slice(0, 300),
        );
      }
    }

    const task = this.batchTaskRepo.create({
      userId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      name: this.resolveTaskName(dto.name, workflow.name),
      mode: dto.mode ?? 'published',
      status: 'pending',
      totalCount: inputs.length,
      inputs,
    });
    const saved = await this.batchTaskRepo.save(task);
    this.startBatchExecution(saved.id, userId);
    return this.toSummary(saved);
  }

  async getBatchTask(userId: string, taskId: string) {
    const task = await this.batchTaskRepo.findOne({
      where: { id: taskId, userId },
    });
    if (!task) throw new NotFoundException('任务不存在');
    return {
      id: task.id,
      name: task.name,
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      mode: task.mode,
      status: task.status,
      totalCount: task.totalCount,
      succeededCount: task.succeededCount,
      failedCount: task.failedCount,
      inputs: task.inputs,
      results: task.results,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
    };
  }

  /**
   * 取消是「尽力而为」：置内存标记并中断当前行正在进行的执行流，
   * 执行循环在行间检查标记后收尾（已终止的行由工作流服务退款）。
   */
  async cancelBatchTask(userId: string, taskId: string): Promise<{ ok: true }> {
    const task = await this.batchTaskRepo.findOne({
      where: { id: taskId, userId },
    });
    if (!task) throw new NotFoundException('任务不存在');
    if (TERMINAL_TASK_STATUSES.has(task.status)) return { ok: true };

    const cancellation = this.cancellations.get(taskId) ?? { cancelled: false };
    cancellation.cancelled = true;
    this.cancellations.set(taskId, cancellation);
    cancellation.controller?.abort();
    // 兜底落库：即使执行协程已不存在（例如进程重启后的残留 running），界面也能立即看到取消。
    await this.batchTaskRepo.update(taskId, {
      status: 'cancelled',
      finishedAt: new Date(),
    });
    return { ok: true };
  }

  async listAsyncRuns(
    userId: string,
    page?: number,
    pageSize?: number,
    source?: string,
  ) {
    const pagination = this.normalizePagination(page, pageSize);
    const where: FindOptionsWhere<WorkflowRun> = {
      userId,
      source: source || In([...ASYNC_RUN_SOURCES]),
    };
    const [items, total] = await this.runRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
    });

    // 一次性批量解析工作流名称；已软删除的工作流按契约返回 null。
    const workflowIds = Array.from(
      new Set(
        items
          .map((run) => run.workflowId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const workflows = workflowIds.length
      ? await this.workflowRepo.find({ where: { id: In(workflowIds) } })
      : [];
    const nameById = new Map(
      workflows
        .filter((workflow) => workflow.status !== 'deleted')
        .map((workflow) => [workflow.id, workflow.name]),
    );

    return {
      items: items.map((run) => ({
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowId
          ? nameById.get(run.workflowId) ?? null
          : null,
        source: run.source,
        status: run.status,
        tokens: run.totalTokens,
        cost: Number(run.actualCost || 0),
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      })),
      total,
      ...pagination,
    };
  }

  private startBatchExecution(taskId: string, userId: string): void {
    // 后台执行不阻塞创建接口；catch 兜底确保任何异常都不会变成未处理的 rejection。
    void this.runBatchTask(taskId, userId).catch((error) => {
      this.logger.error(
        `批量任务后台执行异常: taskId=${taskId}, ${this.errorMessage(error)}`,
      );
    });
  }

  private async runBatchTask(taskId: string, userId: string): Promise<void> {
    const cancellation: BatchTaskCancellation = { cancelled: false };
    this.cancellations.set(taskId, cancellation);
    try {
      const task = await this.batchTaskRepo.findOne({
        where: { id: taskId, userId },
      });
      if (!task) return;

      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user || user.status !== 'active') {
        throw new Error('任务所有者不存在或已停用');
      }
      if (!task.workflowId) {
        throw new Error('任务缺少关联工作流');
      }

      await this.batchTaskRepo.update(taskId, { status: 'running' });

      // 工作流定义只解析一次：整批数据基于同一版本执行，避免执行途中发布新版本造成前后不一致。
      const plan = await this.resolveExecutionPlan(task, userId);

      const results: BatchTaskRowResult[] = [];
      let succeededCount = 0;
      let failedCount = 0;

      for (let index = 0; index < task.inputs.length; index += 1) {
        if (cancellation.cancelled) break;
        const controller = new AbortController();
        cancellation.controller = controller;
        let rowResult: BatchTaskRowResult;
        try {
          rowResult = await this.executeRow(
            task,
            user,
            plan,
            task.inputs[index],
            index,
            controller.signal,
          );
        } finally {
          cancellation.controller = undefined;
        }
        // 取消发生在当前行执行期间：该行按取消处理、不计入统计（终止/退款由工作流服务完成）。
        if (cancellation.cancelled) break;

        // 草稿重新导入/发布后，Dify 应用的首次调用偶尔会瞬时失败；
        // 只对「刚发布沙箱 + 首行」重试一次，避免把冷启动算成这行数据的失败。
        if (
          rowResult.status === 'failed'
          && index === 0
          && plan.freshSandbox
        ) {
          this.logger.warn(`批量任务首行失败，沙箱刚重新发布，重试一次: taskId=${taskId}`);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const retryController = new AbortController();
          cancellation.controller = retryController;
          try {
            rowResult = await this.executeRow(
              task,
              user,
              plan,
              task.inputs[index],
              index,
              retryController.signal,
            );
          } finally {
            cancellation.controller = undefined;
          }
          if (cancellation.cancelled) break;
        }
        results.push(rowResult);
        if (rowResult.status === 'succeeded') succeededCount += 1;
        else failedCount += 1;
        // 每行结束立即落库，前端轮询详情即可看到实时进度。
        await this.batchTaskRepo.update(taskId, {
          succeededCount,
          failedCount,
          results,
        });
      }

      await this.batchTaskRepo.update(taskId, {
        status: cancellation.cancelled
          ? 'cancelled'
          : failedCount === 0
            ? 'succeeded'
            : 'failed',
        succeededCount,
        failedCount,
        results,
        finishedAt: new Date(),
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`批量任务执行失败: taskId=${taskId}, ${message}`);
      try {
        await this.batchTaskRepo.update(taskId, {
          status: cancellation.cancelled ? 'cancelled' : 'failed',
          error: message.slice(0, MAX_ROW_TEXT_LENGTH),
          finishedAt: new Date(),
        });
      } catch (updateError) {
        this.logger.error(
          `批量任务状态落库失败: taskId=${taskId}, ${this.errorMessage(updateError)}`,
        );
      }
    } finally {
      this.cancellations.delete(taskId);
    }
  }

  private async resolveExecutionPlan(
    task: BatchTask,
    userId: string,
  ): Promise<BatchExecutionPlan> {
    const workflowId = task.workflowId as string;
    if (task.mode === 'draft') {
      const workflow = await this.workflowCrud.getById(workflowId, userId);
      const flowgram = workflow.flowgramJson as FlowGramJSON;
      const sandbox = await this.draftRun.prepareSandbox(userId, flowgram);
      return {
        flowgram,
        executionContext: { source: 'batch', sandboxApiKey: sandbox.apiKey },
        freshSandbox: !sandbox.reused,
      };
    }
    const workflow = await this.workflowCrud.getPublished(workflowId, userId);
    return {
      flowgram: workflow.publishedFlowgramJson as FlowGramJSON,
      executionContext: {
        source: 'batch',
        workflowVersion: workflow.publishedVersion || undefined,
      },
      freshSandbox: false,
    };
  }

  private async executeRow(
    task: BatchTask,
    user: User,
    plan: BatchExecutionPlan,
    row: BatchTaskInputRow,
    index: number,
    abortSignal: AbortSignal,
  ): Promise<BatchTaskRowResult> {
    let finished: DifySSEEvent | undefined;
    let failed: DifySSEEvent | undefined;
    try {
      const stream = this.workflowsService.runWorkflow(
        plan.flowgram,
        user,
        row,
        task.workflowId || undefined,
        { ...plan.executionContext, abortSignal },
      );
      // 必须完整消费生成器：工作流服务在生成器的 finally 中完成结算/退款。
      for await (const event of stream) {
        if (event.event === 'workflow_finished') finished = event;
        if (event.event === 'error') failed = event;
      }
    } catch (error) {
      return {
        index,
        status: 'failed',
        error: this.errorMessage(error).slice(0, MAX_ROW_TEXT_LENGTH),
      };
    }

    const data = finished?.data || {};
    const tokens = Number(data.total_tokens) || 0;
    if (finished && data.status === 'succeeded') {
      return {
        index,
        status: 'succeeded',
        tokens,
        outputText: this.extractOutputText(data.outputs),
      };
    }
    const message =
      failed?.data?.message
      || data.error
      || (finished
        ? `工作流以非成功状态结束: ${data.status || 'unknown'}`
        : '执行流意外结束，未收到 workflow_finished 事件');
    return {
      index,
      status: 'failed',
      tokens,
      error: String(message).slice(0, MAX_ROW_TEXT_LENGTH),
    };
  }

  /** 优先取常见单文本输出，否则序列化整个输出对象并截断。 */
  private extractOutputText(outputs: unknown): string | undefined {
    if (!outputs || typeof outputs !== 'object') return undefined;
    const record = outputs as Record<string, unknown>;
    for (const key of ['output', 'text', 'result']) {
      const value = record[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        const text = String(value);
        if (text) return text.slice(0, MAX_ROW_TEXT_LENGTH);
      }
    }
    const serialized = JSON.stringify(record);
    if (!serialized || serialized === '{}') return undefined;
    return serialized.slice(0, MAX_ROW_TEXT_LENGTH);
  }

  /** 重建每行输入：只保留标量值，落库内容与执行内容一致。 */
  private sanitizeInputs(
    inputs: Record<string, unknown>[],
  ): BatchTaskInputRow[] {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUT_ROWS) {
      throw new BadRequestException(
        `inputs 数量必须在 1..${MAX_INPUT_ROWS} 之间`,
      );
    }
    return inputs.map((row, rowIndex) => {
      const position = rowIndex + 1;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new BadRequestException(`第 ${position} 行输入必须是普通对象`);
      }
      const entries = Object.entries(row);
      if (entries.length > MAX_INPUT_KEYS) {
        throw new BadRequestException(
          `第 ${position} 行输入字段数不能超过 ${MAX_INPUT_KEYS} 个`,
        );
      }
      const sanitized: BatchTaskInputRow = {};
      for (const [key, value] of entries) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new BadRequestException(
            `第 ${position} 行输入「${key}」仅支持字符串、数字或布尔值`,
          );
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new BadRequestException(
            `第 ${position} 行输入「${key}」必须是有限数字`,
          );
        }
        sanitized[key] = value as string | number | boolean;
      }
      return sanitized;
    });
  }

  private resolveTaskName(name: string | undefined, workflowName: string): string {
    const trimmed = name?.trim();
    return (trimmed || `${workflowName} 批量任务`).slice(0, 128);
  }

  private normalizePagination(
    page?: number,
    pageSize?: number,
  ): { page: number; pageSize: number } {
    const normalizedPage =
      page && Number.isInteger(page) && page > 0 ? page : 1;
    const normalizedPageSize =
      pageSize && Number.isInteger(pageSize) && pageSize > 0
        ? Math.min(pageSize, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    return { page: normalizedPage, pageSize: normalizedPageSize };
  }

  private toSummary(task: BatchTask) {
    return {
      id: task.id,
      name: task.name,
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      mode: task.mode,
      status: task.status,
      totalCount: task.totalCount,
      succeededCount: task.succeededCount,
      failedCount: task.failedCount,
      error: task.error,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
