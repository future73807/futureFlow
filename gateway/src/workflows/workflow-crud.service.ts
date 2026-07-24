import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowVersion } from '../database/entities/workflow-version.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow-crud.dto';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import { DifyConsoleService, DifySyncResult } from '../dify/dify-console.service';

@Injectable()
export class WorkflowCrudService {
  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(WorkflowRun)
    private readonly workflowRunRepo: Repository<WorkflowRun>,
    @InjectRepository(WorkflowVersion)
    private readonly workflowVersionRepo: Repository<WorkflowVersion>,
    private readonly converter: DifyConverterService,
    private readonly difyConsole: DifyConsoleService,
  ) {}

  async listByUser(userId: string): Promise<Workflow[]> {
    return this.workflowRepo.find({
      where: { userId, status: 'active' },
      order: { updatedAt: 'DESC' },
    });
  }

  async getById(id: string, userId: string): Promise<Workflow> {
    const wf = await this.workflowRepo.findOne({ where: { id } });
    if (!wf) throw new NotFoundException('工作流不存在');
    if (wf.userId !== userId) throw new ForbiddenException('无权访问此工作流');
    if (wf.status === 'deleted') throw new NotFoundException('工作流不存在');
    return wf;
  }

  async create(userId: string, dto: CreateWorkflowDto): Promise<Workflow> {
    const wf = this.workflowRepo.create({
      userId,
      name: dto.name.trim(),
      description: dto.description || '',
      flowgramJson: this.parseFlowgram(dto.flowgram),
    });
    return this.workflowRepo.save(wf);
  }

  async update(id: string, userId: string, dto: UpdateWorkflowDto): Promise<Workflow> {
    const wf = await this.getById(id, userId);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('工作流名称不能为空');
      wf.name = name;
    }
    if (dto.description !== undefined) wf.description = dto.description;
    if (dto.flowgram !== undefined) wf.flowgramJson = this.parseFlowgram(dto.flowgram);
    if (dto.status !== undefined) {
      if (!['active', 'archived'].includes(dto.status)) {
        throw new BadRequestException('无效的工作流状态');
      }
      wf.status = dto.status;
    }
    wf.version = Number(wf.version) + 1;
    return this.workflowRepo.save(wf);
  }

  async delete(id: string, userId: string): Promise<void> {
    const wf = await this.getById(id, userId);
    wf.status = 'deleted';
    await this.workflowRepo.save(wf);
  }

  async duplicate(id: string, userId: string): Promise<Workflow> {
    const wf = await this.getById(id, userId);
    const copy = this.workflowRepo.create({
      userId,
      name: `${wf.name} (副本)`,
      description: wf.description,
      flowgramJson: wf.flowgramJson,
    });
    return this.workflowRepo.save(copy);
  }

  /**
   * 发布当前草稿。发布内容保存为快照，后续编辑只会修改草稿而不会影响线上工作流。
   */
  async publish(id: string, userId: string): Promise<Workflow & { difySync: DifySyncResult }> {
    // Keep the live snapshot and its audit record atomic: callers must never
    // observe a published workflow whose recoverable version was not saved.
    const published = await this.workflowRepo.manager.transaction(async (manager) => {
      const workflowRepo = manager.getRepository(Workflow);
      const versionRepo = manager.getRepository(WorkflowVersion);
      const wf = await workflowRepo.findOne({ where: { id, userId } });
      if (!wf || wf.status === 'deleted') throw new NotFoundException('工作流不存在');
      if (wf.status !== 'active') {
        throw new BadRequestException('仅可发布处于正常状态的工作流');
      }

      this.converter.validateFlowGram(wf.flowgramJson as FlowGramJSON);
      const publishedAt = new Date();
      wf.publishedFlowgramJson = this.cloneJson(wf.flowgramJson);
      wf.publishedVersion = wf.version;
      wf.publishedAt = publishedAt;
      const published = await workflowRepo.save(wf);

      // Re-publishing an unchanged draft refreshes the live snapshot but does
      // not create duplicate version-history rows.
      const existing = await versionRepo.findOne({
        where: { workflowId: published.id, version: published.version },
      });
      if (!existing) {
        await versionRepo.save(
          versionRepo.create({
            workflowId: published.id,
            userId,
            version: published.version,
            name: published.name,
            description: published.description || '',
            flowgramJson: this.cloneJson(published.flowgramJson),
            publishedAt,
          }),
        );
      }
      return published;
    });
    // This external operation deliberately happens after the database commit:
    // a Dify outage must not roll back the immutable local release. A binding
    // stays `provisioning` until the import is accepted, so it cannot execute
    // an empty or stale Dify app.
    const difySync = await this.difyConsole.syncPublishedWorkflow({
      workflowId: published.id,
      workflowVersion: published.publishedVersion!,
      workflowName: published.name,
      flowgram: published.publishedFlowgramJson as FlowGramJSON,
    });
    return Object.assign(published, { difySync });
  }

  async unpublish(id: string, userId: string): Promise<Workflow> {
    const wf = await this.getById(id, userId);
    wf.publishedFlowgramJson = null;
    wf.publishedVersion = null;
    wf.publishedAt = null;
    return this.workflowRepo.save(wf);
  }

  /** Re-imports the current immutable release after Dify was authorized later. */
  async syncPublishedDify(id: string, userId: string): Promise<DifySyncResult> {
    const workflow = await this.getPublished(id, userId);
    return this.difyConsole.syncPublishedWorkflow({
      workflowId: workflow.id,
      workflowVersion: workflow.publishedVersion!,
      workflowName: workflow.name,
      flowgram: workflow.publishedFlowgramJson as FlowGramJSON,
    });
  }

  /** 获取可对外执行的发布快照。 */
  async getPublished(id: string, userId: string): Promise<Workflow> {
    const wf = await this.getById(id, userId);
    if (wf.status !== 'active') {
      throw new NotFoundException('工作流不可用');
    }
    if (!wf.publishedFlowgramJson || !wf.publishedVersion) {
      throw new BadRequestException('工作流尚未发布，请先在画布中发布当前版本');
    }
    return wf;
  }

  /** 用户查看自己已发布工作流的运行记录，避免暴露全站审计数据。 */
  async listRuns(id: string, userId: string, page = 1, pageSize = 30) {
    await this.getById(id, userId);
    const [items, total] = await this.workflowRunRepo.findAndCount({
      where: { workflowId: id, userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: items.map((run) => ({
        id: run.id,
        status: run.status,
        totalTokens: run.totalTokens,
        totalSteps: run.totalSteps,
        estimatedCost: Number(run.estimatedCost || 0),
        actualCost: Number(run.actualCost || 0),
        elapsedTime: run.elapsedTime,
        errorMessage: run.errorMessage,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** List metadata only. The full canvas is returned solely by a restore action. */
  async listVersions(id: string, userId: string) {
    await this.getById(id, userId);
    const items = await this.workflowVersionRepo.find({
      where: { workflowId: id, userId },
      order: { version: 'DESC' },
      take: 100,
    });
    return items.map((item) => ({
      id: item.id,
      version: item.version,
      name: item.name,
      description: item.description,
      publishedAt: item.publishedAt,
    }));
  }

  /**
   * Restores a published definition into the current draft. The current live
   * snapshot remains untouched until the owner explicitly publishes again.
   */
  async restoreVersion(id: string, userId: string, version: number) {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('版本号必须是正整数');
    }
    const wf = await this.getById(id, userId);
    const history = await this.workflowVersionRepo.findOne({
      where: { workflowId: id, userId, version },
    });
    if (!history) throw new NotFoundException('指定的发布版本不存在');

    wf.name = history.name;
    wf.description = history.description;
    wf.flowgramJson = this.cloneJson(history.flowgramJson);
    wf.version = Number(wf.version) + 1;
    return this.workflowRepo.save(wf);
  }

  private parseFlowgram(value: string): Record<string, any> {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error('invalid structure');
      }
      return parsed;
    } catch {
      throw new BadRequestException('flowgram 必须是包含 nodes 和 edges 数组的 JSON');
    }
  }

  private cloneJson(value: Record<string, any>): Record<string, any> {
    return JSON.parse(JSON.stringify(value));
  }
}
