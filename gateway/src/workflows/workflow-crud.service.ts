import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Workflow } from '../database/entities/workflow.entity';
import {
  WorkflowVersion,
  formatVersionLabel,
} from '../database/entities/workflow-version.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { User } from '../database/entities/user.entity';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateWorkflowVersionDto,
  UpdateVersionCommentDto,
  ImportWorkflowDto,
} from './dto/workflow-crud.dto';
import { DifyConverterService } from '../converter/dify-converter.service';
import { FlowGramJSON } from '../converter/types';
import { DifyConsoleService, DifySyncResult } from '../dify/dify-console.service';
import { DifyIntegrationService } from '../dify/dify-integration.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PermissionChecker } from '../auth/auth.module';

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
    private readonly difyIntegration: DifyIntegrationService,
    private readonly knowledge: KnowledgeService,
    private readonly permissionChecker: PermissionChecker,
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
    return this.workflowRepo.manager.transaction(async (manager) => {
      const workflowRepo = manager.getRepository(Workflow);
      const wf = await this.getLockedWorkflow(manager, id, userId);
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
      return workflowRepo.save(wf);
    });
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.workflowRepo.manager.transaction(async (manager) => {
      const wf = await this.getLockedWorkflow(manager, id, userId);

      // Keep the workflow row locked while Dify resources are removed. The
      // lock is database-backed, so publish/sync requests in other Gateway
      // processes cannot create a new app between cleanup and soft deletion.
      await this.difyIntegration.deleteWorkflowIntegrations(wf.id);
      wf.status = 'deleted';
      await manager.getRepository(Workflow).save(wf);
    });
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
    let difySyncOutcome:
      | { ok: true; value: DifySyncResult }
      | { ok: false; error: unknown }
      | undefined;
    const published = await this.workflowRepo.manager.transaction(async (manager) => {
      const workflowRepo = manager.getRepository(Workflow);
      const versionRepo = manager.getRepository(WorkflowVersion);
      const wf = await this.getLockedWorkflow(manager, id, userId);
      if (wf.status !== 'active') {
        throw new BadRequestException('仅可发布处于正常状态的工作流');
      }

      const owner = await manager.getRepository(User).findOne({ where: { id: userId } });
      if (!owner) throw new NotFoundException('工作流所有者不存在');
      const nodeTypes = (wf.flowgramJson as FlowGramJSON).nodes.map((node) => node.type);
      const permission = this.permissionChecker.checkNodePermissions(owner.vipLevel, nodeTypes);
      if (!permission.allowed) {
        throw new BadRequestException(
          `当前 VIP 等级(${owner.vipLevel})无权发布以下节点: ${permission.deniedNodes.join(', ')}`,
        );
      }

      // 完整转换是发布前的无副作用门禁；变量支配关系、End 引用和 Dify DSL
      // 结构错误必须在写入不可变快照前失败，不能留下“已发布但永远无法同步”的版本。
      await this.attachSubworkflowSnapshots(wf, manager, new Set([wf.id]));
      await this.knowledge.assertFlowgramDatasetsOwned(userId, wf.flowgramJson as FlowGramJSON);
      this.converter.toDifyDSL(wf.flowgramJson as FlowGramJSON);
      const publishedAt = new Date();
      wf.publishedFlowgramJson = this.cloneJson(wf.flowgramJson);
      wf.publishedVersion = wf.version;
      wf.publishedAt = publishedAt;
      const published = await workflowRepo.save(wf);

      // 版本号统一从版本表顺延（与「另存为版本」同一条规则）：草稿修订号会被
      // 保存动作推高，直接拿它当版本号会让版本列表跳号（1.4 却没有 1.1~1.3）。
      const latest = await versionRepo.findOne({
        where: { workflowId: published.id },
        order: { version: 'DESC' },
      });
      if (latest && this.isSameSnapshot(latest, published)) {
        // 内容没变（例如刚另存过）：沿用最新版本号作为线上版本，不新增历史行。
        published.publishedVersion = latest.version;
        await workflowRepo.save(published);
      } else {
        const nextVersion = (latest?.version ?? 0) + 1;
        await this.createVersionRow(
          versionRepo,
          published,
          userId,
          nextVersion,
          publishedAt,
        );
        // publishedVersion 必须始终指向真实存在的历史行，否则「当前线上版本」标记会丢失。
        published.publishedVersion = nextVersion;
        await workflowRepo.save(published);
      }

      // The same PostgreSQL row lock must cover remote provisioning/import.
      // Capture an unexpected Dify throw so the immutable local snapshot can
      // still commit, then propagate it after the transaction releases the
      // lock. Normal failed/not-configured results are returned as before.
      try {
        difySyncOutcome = {
          ok: true,
          value: await this.difyConsole.syncPublishedWorkflow({
            workflowId: published.id,
            workflowVersion: published.publishedVersion!,
            workflowName: published.name,
            flowgram: published.publishedFlowgramJson as FlowGramJSON,
          }),
        };
      } catch (error) {
        difySyncOutcome = { ok: false, error };
      }
      return published;
    });
    if (!difySyncOutcome) {
      throw new Error('Dify 同步未返回结果');
    }
    if (!difySyncOutcome.ok) {
      throw difySyncOutcome.error;
    }
    return Object.assign(published, { difySync: difySyncOutcome.value });
  }

  async unpublish(id: string, userId: string): Promise<Workflow> {
    return this.workflowRepo.manager.transaction(async (manager) => {
      const workflowRepo = manager.getRepository(Workflow);
      const wf = await this.getLockedWorkflow(manager, id, userId);
      wf.publishedFlowgramJson = null;
      wf.publishedVersion = null;
      wf.publishedAt = null;
      return workflowRepo.save(wf);
    });
  }

  /** Re-imports the current immutable release after Dify was authorized later. */
  async syncPublishedDify(id: string, userId: string): Promise<DifySyncResult> {
    return this.workflowRepo.manager.transaction(async (manager) => {
      const workflow = await this.getLockedWorkflow(manager, id, userId);
      if (workflow.status !== 'active') {
        throw new NotFoundException('工作流不可用');
      }
      if (!workflow.publishedFlowgramJson || !workflow.publishedVersion) {
        throw new BadRequestException('工作流尚未发布，请先在画布中发布当前版本');
      }

      // A manual retry can provision an app too, so it participates in the
      // same cross-process row lock as publish and delete.
      return this.difyConsole.syncPublishedWorkflow({
        workflowId: workflow.id,
        workflowVersion: workflow.publishedVersion,
        workflowName: workflow.name,
        flowgram: workflow.publishedFlowgramJson as FlowGramJSON,
      });
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
        source: run.source,
        totalTokens: run.totalTokens,
        totalSteps: run.totalSteps,
        estimatedCost: Number(run.estimatedCost || 0),
        actualCost: Number(run.actualCost || 0),
        elapsedTime: run.elapsedTime,
        errorMessage: run.errorMessage,
        outputs: run.outputs ?? null,
        nodeResults: run.nodeResults ?? null,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 列表按版本号倒序返回，最新在前；只暴露元信息，完整画布仅在回退时下发。 */
  async listVersions(id: string, userId: string) {
    const workflow = await this.getById(id, userId);
    const items = await this.workflowVersionRepo.find({
      where: { workflowId: id, userId },
      order: { version: 'DESC' },
      take: 100,
    });
    const latestVersion = items.length > 0 ? items[0].version : 0;
    return items.map((item) =>
      this.toVersionItem(item, workflow.publishedVersion, latestVersion),
    );
  }

  /**
   * 另存为版本：把当前草稿固化成一条可回溯记录。
   * 编号取 max(version)+1，即便之后回退旧版本也不会复用已占用的版本号。
   */
  async createManualVersion(id: string, userId: string, dto: CreateWorkflowVersionDto) {
    return this.workflowRepo.manager.transaction(async (manager) => {
      const versionRepo = manager.getRepository(WorkflowVersion);
      const wf = await this.getLockedWorkflow(manager, id, userId);
      const latest = await versionRepo.findOne({
        where: { workflowId: id },
        order: { version: 'DESC' },
      });
      // 未修改的草稿重复另存只会污染历史，这里直接拒绝。
      if (latest && this.isSameSnapshot(latest, wf)) {
        throw new BadRequestException('草稿与最新版本一致，无需另存');
      }
      const created = await versionRepo.save(
        versionRepo.create({
          workflowId: id,
          userId,
          version: (latest?.version ?? 0) + 1,
          name: wf.name,
          description: wf.description || '',
          flowgramJson: this.cloneJson(wf.flowgramJson),
          comment: (dto.comment || '').trim(),
          source: 'manual',
          // 与发布路径保持一致地显式写入时间：publishedAt 是 timestamp without time zone，
          // 交给数据库 now() 会写入 UTC 墙钟，而 JS Date 写入的是进程本地墙钟，
          // 两条路径混用会让版本列表的时间差一个时区（实测差 8 小时）。
          publishedAt: new Date(),
        }),
      );
      return this.toVersionItem(created, wf.publishedVersion, created.version);
    });
  }

  /** 版本说明可以随时补充或清空，但历史快照本身保持不可变。 */
  async updateVersionComment(
    id: string,
    userId: string,
    version: number,
    dto: UpdateVersionCommentDto,
  ) {
    this.assertVersionNumber(version);
    const workflow = await this.getById(id, userId);
    const row = await this.workflowVersionRepo.findOne({
      where: { workflowId: id, userId, version },
    });
    if (!row) throw new NotFoundException('指定的版本不存在');
    row.comment = (dto.comment || '').trim();
    const saved = await this.workflowVersionRepo.save(row);
    const latest = await this.workflowVersionRepo.findOne({
      where: { workflowId: id, userId },
      order: { version: 'DESC' },
    });
    return this.toVersionItem(saved, workflow.publishedVersion, latest?.version ?? saved.version);
  }

  /**
   * Restores a published definition into the current draft. The current live
   * snapshot remains untouched until the owner explicitly publishes again.
   */
  async restoreVersion(id: string, userId: string, version: number) {
    this.assertVersionNumber(version);
    return this.workflowRepo.manager.transaction(async (manager) => {
      const workflowRepo = manager.getRepository(Workflow);
      const wf = await this.getLockedWorkflow(manager, id, userId);
      const history = await manager.getRepository(WorkflowVersion).findOne({
        where: { workflowId: id, userId, version },
      });
      if (!history) throw new NotFoundException('指定的发布版本不存在');

      wf.name = history.name;
      wf.description = history.description;
      wf.flowgramJson = this.cloneJson(history.flowgramJson);
      wf.version = Number(wf.version) + 1;
      const restored = await workflowRepo.save(wf);
      // 带上展示标签，前端才能直接提示「已回退到 v1.2」。
      return Object.assign(restored, { label: formatVersionLabel(history.version) });
    });
  }

  /**
   * 从外部 JSON 导入工作流。结构自检先给出精确定位的错误，
   * 再复用发布路径同款门禁，避免导入出永远无法执行的工作流。
   */
  async importWorkflow(userId: string, dto: ImportWorkflowDto): Promise<Workflow> {
    const flowgram = this.assertImportableFlowgram(dto.flowgram);
    try {
      this.converter.validateFlowGram(flowgram as FlowGramJSON);
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : 'flowgram 结构校验失败';
      throw new BadRequestException(message);
    }
    const name = dto.name === undefined ? '导入的工作流' : dto.name.trim();
    if (!name) throw new BadRequestException('工作流名称不能为空');
    const wf = this.workflowRepo.create({
      userId,
      name,
      description: dto.description || '',
      flowgramJson: this.cloneJson(flowgram),
    });
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

  private async getLockedWorkflow(
    manager: EntityManager,
    id: string,
    userId: string,
  ): Promise<Workflow> {
    // Do not catch lock errors here. Real PostgreSQL must never silently fall
    // back to an unlocked read; pg-mem accepts this FOR UPDATE query for tests.
    const workflow = await manager.getRepository(Workflow).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!workflow || workflow.status === 'deleted') {
      throw new NotFoundException('工作流不存在');
    }
    if (workflow.userId !== userId) {
      throw new ForbiddenException('无权访问此工作流');
    }
    return workflow;
  }

  private cloneJson(value: Record<string, any>): Record<string, any> {
    return JSON.parse(JSON.stringify(value));
  }

  private assertVersionNumber(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('版本号必须是正整数');
    }
  }

  /** 各端点共用同一份字段映射，保证版本返回结构完全一致。 */
  private toVersionItem(
    item: WorkflowVersion,
    publishedVersion: number | null,
    latestVersion: number,
  ) {
    return {
      id: item.id,
      version: item.version,
      label: formatVersionLabel(item.version),
      comment: item.comment || '',
      source: item.source || 'publish',
      name: item.name,
      description: item.description || '',
      createdAt: item.publishedAt,
      isPublished: publishedVersion !== null && publishedVersion === item.version,
      isLatest: item.version === latestVersion,
    };
  }

  /** 历史行与工作流快照的一致性判断：名称和画布都相同才算「未修改」。 */
  private isSameSnapshot(version: WorkflowVersion, workflow: Workflow): boolean {
    return (
      version.name === workflow.name
      && this.isSameFlowgram(version.flowgramJson, workflow.flowgramJson)
    );
  }

  /** jsonb 读出的键顺序已被规范化，直接序列化比较即可判定内容逐字节一致。 */
  private isSameFlowgram(
    left: Record<string, any>,
    right: Record<string, any>,
  ): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private async createVersionRow(
    versionRepo: Repository<WorkflowVersion>,
    workflow: Workflow,
    userId: string,
    version: number,
    publishedAt: Date,
  ): Promise<WorkflowVersion> {
    return versionRepo.save(
      versionRepo.create({
        workflowId: workflow.id,
        userId,
        version,
        name: workflow.name,
        description: workflow.description || '',
        flowgramJson: this.cloneJson(workflow.flowgramJson),
        comment: `发布 v${formatVersionLabel(version)}`,
        source: 'publish',
        publishedAt,
      }),
    );
  }

  /**
   * 导入前的基础结构自检：逐节点、逐连线定位错误，
   * 比转换器更早给出「是哪个节点/哪条连线」的精确提示。
   */
  private assertImportableFlowgram(value: Record<string, any>): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('flowgram 必须是包含 nodes 与 edges 的 JSON 对象');
    }
    const nodes: unknown = value.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new BadRequestException('flowgram.nodes 必须是非空数组');
    }
    const nodeIds = new Set<string>();
    nodes.forEach((node: any, index: number) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new BadRequestException(`节点 #${index + 1} 必须是对象`);
      }
      if (typeof node.id !== 'string' || !node.id.trim()) {
        throw new BadRequestException(`节点 #${index + 1} 缺少有效的 id`);
      }
      if (typeof node.type !== 'string' || !node.type.trim()) {
        throw new BadRequestException(`节点 ${node.id} 缺少有效的 type`);
      }
      if (nodeIds.has(node.id)) {
        throw new BadRequestException(`节点 id 重复: ${node.id}`);
      }
      nodeIds.add(node.id);
    });
    const edges: unknown = value.edges;
    if (edges === undefined) {
      // 允许导入单节点画布省略 edges；补空数组后仍交给发布同款门禁复核。
      value.edges = [];
    } else {
      if (!Array.isArray(edges)) {
        throw new BadRequestException('flowgram.edges 必须是数组');
      }
      edges.forEach((edge: any, index: number) => {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
          throw new BadRequestException(`连线 #${index + 1} 必须是对象`);
        }
        const label =
          typeof edge.id === 'string' && edge.id ? `「${edge.id}」` : `#${index + 1}`;
        if (typeof edge.sourceNodeID !== 'string' || !nodeIds.has(edge.sourceNodeID)) {
          throw new BadRequestException(
            `连线 ${label} 的 sourceNodeID「${edge.sourceNodeID ?? ''}」不存在对应节点`,
          );
        }
        if (typeof edge.targetNodeID !== 'string' || !nodeIds.has(edge.targetNodeID)) {
          throw new BadRequestException(
            `连线 ${label} 的 targetNodeID「${edge.targetNodeID ?? ''}」不存在对应节点`,
          );
        }
      });
    }
    return value;
  }

  /**
   * 供画布「子工作流」节点配置使用：返回目标工作流已发布快照的
   * 开始节点入参契约和结束节点输出变量。
   */
  async getSubflowMeta(id: string, userId: string) {
    const target = await this.getById(id, userId);
    if (!target.publishedVersion || !target.publishedFlowgramJson) {
      throw new BadRequestException(`「${target.name}」还没有已发布版本，请先发布`);
    }
    const snapshot = target.publishedFlowgramJson as FlowGramJSON;
    const start = (snapshot.nodes || []).find((node) => node.type === 'start');
    const end = (snapshot.nodes || []).find((node) => node.type === 'end');
    const properties = (start?.data?.outputs?.properties || {}) as Record<string, any>;
    const endOutputs = end?.data?.inputsValues
      ? Object.keys(end.data.inputsValues)
      : Object.keys((end?.data?.outputs?.properties || {}) as Record<string, any>);
    return {
      workflowId: target.id,
      name: target.name,
      publishedVersion: target.publishedVersion,
      startVariables: Object.entries(properties).map(([variable, schema]) => ({
        variable,
        label: (schema as any)?.title || variable,
        type: (schema as any)?.type || 'string',
      })),
      endOutputs,
    };
  }

  /**
   * 解析画布中所有子工作流节点的已发布快照并写入 inlinedGraph。
   * 仅允许引用同一用户、active 且已发布的工作流；沿引用链做环检测，
   * 链上任何一环未发布都会让本次发布明确失败。
   */
  private async attachSubworkflowSnapshots(
    wf: Workflow,
    manager: EntityManager,
    visiting: Set<string>,
    depth = 0,
  ): Promise<void> {
    if (depth > 3) {
      throw new BadRequestException('子工作流嵌套层数超过上限（最多 3 层）');
    }
    const workflowRepo = manager.getRepository(Workflow);
    const graph = wf.flowgramJson as FlowGramJSON;
    for (const node of graph.nodes || []) {
      if (node?.type !== 'subworkflow') continue;
      const targetId = String(node.data?.targetWorkflowId || '').trim();
      if (!targetId) {
        throw new BadRequestException(`子工作流节点 ${node.id} 尚未选择目标工作流`);
      }
      if (visiting.has(targetId)) {
        throw new BadRequestException(
          `子工作流引用形成环：工作流 ${wf.id} → ${targetId}`,
        );
      }
      const target = await workflowRepo.findOne({ where: { id: targetId } });
      if (!target || target.status !== 'active' || target.userId !== wf.userId) {
        throw new BadRequestException(
          `子工作流节点 ${node.id} 引用的目标工作流不存在、已删除或不属于当前用户`,
        );
      }
      if (!target.publishedVersion || !target.publishedFlowgramJson) {
        throw new BadRequestException(
          `子工作流节点 ${node.id} 引用的「${target.name}」还没有已发布版本，请先发布目标工作流`,
        );
      }
      const childSnapshot = this.cloneJson(target.publishedFlowgramJson) as FlowGramJSON;
      // 目标工作流的快照里若还有 subworkflow 节点，递归展开其引用链。
      await this.attachSubworkflowSnapshots(
        { ...target, flowgramJson: childSnapshot } as Workflow,
        manager,
        new Set([...visiting, targetId]),
        depth + 1,
      );
      node.data.inlinedGraph = {
        nodes: childSnapshot.nodes || [],
        edges: childSnapshot.edges || [],
      };
    }
  }
}
