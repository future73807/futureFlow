import type { ProjectControlInput, ProjectControlReceipt } from './project-control.types';
export type { ProjectControlInput, ProjectControlReceipt } from './project-control.types';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, In } from 'typeorm';
import { HostProjectGate, HostProjectControlRecord, HostProjectWorkRecord } from '../database/entities/host-project-gate.entity';
import { User } from '../database/entities/user.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { MediaJob } from '../database/entities/media-job.entity';
import { BatchTask } from '../database/entities/batch-task.entity';
import { WorkflowTrigger } from '../database/entities/workflow-trigger.entity';
import type { HostProjectBinding } from './host.types';
import { ProjectWorkUnits, type ProjectWorkUnit } from './project-work-units';

@Injectable()
export class ProjectControlService {
  private readonly work = new ProjectWorkUnits();
  private readonly operations = new Map<string, { expected: number; promise: Promise<ProjectControlReceipt> }>();
  constructor(
    @InjectRepository(HostProjectGate) private readonly gates: Repository<HostProjectGate>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}
  private key(hostSubject: string, projectId: string) { return { hostSubject, projectId }; }
  private async ensure(manager: EntityManager, hostSubject: string, projectId: string): Promise<HostProjectGate> {
    await manager.createQueryBuilder().insert().into(HostProjectGate)
      .values({ hostSubject, projectId, generation: 1, draining: false, operationId: null }).orIgnore().execute();
    return (await manager.getRepository(HostProjectGate).findOneOrFail({
      where: this.key(hostSubject, projectId), lock: { mode: 'pessimistic_write' },
    }));
  }
  private async subject(userId: string): Promise<string> {
    const user = await this.users.findOne({ where: { id: userId, status: 'active' } });
    if (!user?.hostSubject) throw new ForbiddenException('宿主实例身份无效');
    return user.hostSubject;
  }
  async assert(userId: string, binding: HostProjectBinding): Promise<void> {
    const subject = await this.subject(userId);
    await this.gates.manager.transaction(async (manager) => {
      const gate = await this.ensure(manager, subject, binding.projectId);
      if (gate.draining || gate.generation !== binding.generation) throw new ForbiddenException('项目作用域已失效，请重新打开项目');
    });
  }
  async write<T>(userId: string, binding: HostProjectBinding, operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    const subject = await this.subject(userId);
    return this.gates.manager.transaction(async (manager) => {
      const gate = await this.ensure(manager, subject, binding.projectId);
      if (gate.draining || gate.generation !== binding.generation) throw new ForbiddenException('项目作用域已失效');
      return operation(manager);
    });
  }
  async begin(userId: string, binding: HostProjectBinding, runId?: string): Promise<ProjectWorkUnit> {
    const subject = await this.subject(userId);
    const unit = this.work.create(subject, binding, () => this.assert(userId, binding),
      async () => { await this.gates.manager.getRepository(HostProjectWorkRecord).delete({ id: unit.id }); }, runId);
    try {
      await this.write(userId, binding, (manager) => manager.getRepository(HostProjectWorkRecord).save({
        id: unit.id, hostSubject: subject, projectId: binding.projectId, generation: binding.generation, runId: runId ?? null,
      }));
      return unit;
    } catch (error) { await unit.finish(); throw error; }
  }
  async attachRun(unit: ProjectWorkUnit, runId: string): Promise<void> {
    unit.runId = runId;
    await this.gates.manager.getRepository(HostProjectWorkRecord).update({ id: unit.id }, { runId });
  }
  private async owner(hostSubject: string): Promise<void> {
    if (!(await this.users.findOne({ where: { hostSubject } }))) throw new NotFoundException('宿主实例未连接');
  }
  async control(projectId: string, input: ProjectControlInput): Promise<ProjectControlReceipt> {
    // 共享密钥已验证的首次身份回调需要先发现代际，此时User尚未get-or-create。
    if (input.action !== 'snapshot') await this.owner(input.hostSubject);
    const key = `${input.hostSubject}:${projectId}:${input.operationId}:${input.action}`;
    const running = this.operations.get(key);
    if (running) {
      if (running.expected !== input.expectedGeneration) throw new ConflictException('控制请求代际不一致');
      return running.promise;
    }
    const operation = this.execute(projectId, input);
    this.operations.set(key, { expected: input.expectedGeneration, promise: operation });
    try { return await operation; } finally { this.operations.delete(key); }
  }
  private async execute(projectId: string, input: ProjectControlInput): Promise<ProjectControlReceipt> {
    if (input.action === 'snapshot') {
      const gate = await this.gates.manager.transaction((manager) => this.ensure(manager, input.hostSubject, projectId));
      if (input.expectedGeneration !== 0 && gate.generation !== input.expectedGeneration) throw new ConflictException('项目代际已改变');
      return this.snapshot(gate, 0);
    }
    const prepared = await this.gates.manager.transaction(async (manager) => {
      const gate = await this.ensure(manager, input.hostSubject, projectId);
      const records = manager.getRepository(HostProjectControlRecord);
      const where = { ...this.key(input.hostSubject, projectId), operationId: input.operationId, action: input.action };
      const previous = await records.findOne({ where });
      if (previous) {
        if (previous.expectedGeneration !== input.expectedGeneration) throw new ConflictException('控制请求代际不一致');
        if (previous.receipt) return { gate, receipt: previous.receipt };
      }
      if (!previous && gate.generation !== input.expectedGeneration) throw new ConflictException('项目代际已改变');
      if (input.action === 'quiesce' && !previous) {
        if (gate.draining) throw new ConflictException('项目正在维护');
        gate.generation += 1; gate.draining = true; gate.operationId = input.operationId;
        await manager.save(gate);
      }
      if (input.action === 'complete-relink') {
        const stopped = await records.findOne({ where: { ...this.key(input.hostSubject, projectId), operationId: input.operationId, action: 'quiesce' } });
        if (!gate.draining || gate.operationId !== input.operationId || !stopped?.receipt?.localSettled) throw new ConflictException('项目尚未停稳');
        const owner = await manager.getRepository(User).findOne({ where: { hostSubject: input.hostSubject, status: 'active' } });
        if (!owner) throw new ConflictException('宿主实例未连接');
        const remoteRuns = await manager.getRepository(WorkflowRun).count({ where: { userId: owner.id, hostProjectId: projectId, remoteStatus: In(['outstanding', 'stop_requested']) } });
        const remoteMedia = await manager.getRepository(MediaJob).count({ where: { userId: owner.id, hostProjectId: projectId, remoteStatus: In(['outstanding', 'stop_requested']) } });
        if (remoteRuns + remoteMedia) throw new ConflictException('远端任务尚未确认结束');
        gate.draining = false; await manager.save(gate);
      }
      if (!previous) await records.save(records.create({ ...where, expectedGeneration: input.expectedGeneration, receipt: null }));
      return { gate, receipt: undefined };
    });
    if (prepared.receipt) return prepared.receipt;
    if (input.action === 'quiesce') return this.quiesce(projectId, input, prepared.gate);
    return this.saveReceipt(projectId, input, await this.snapshot(prepared.gate, 0));
  }
  private async snapshot(gate: HostProjectGate, remoteStopped: number): Promise<ProjectControlReceipt> {
    const units = this.work.forProject(gate.hostSubject, gate.projectId);
    const durableUnits = await this.gates.manager.getRepository(HostProjectWorkRecord).find({ where: this.key(gate.hostSubject, gate.projectId) });
    const owner = await this.users.findOne({ where: { hostSubject: gate.hostSubject } });
    const remoteRuns = owner ? await this.gates.manager.getRepository(WorkflowRun).count({ where: { userId: owner.id, hostProjectId: gate.projectId, remoteStatus: In(['outstanding', 'stop_requested']) } }) : 0;
    const remoteMedia = owner ? await this.gates.manager.getRepository(MediaJob).count({ where: { userId: owner.id, hostProjectId: gate.projectId, remoteStatus: In(['outstanding', 'stop_requested']) } }) : 0;
    const quiesce = gate.operationId ? await this.gates.manager.getRepository(HostProjectControlRecord).findOne({ where: { ...this.key(gate.hostSubject, gate.projectId), operationId: gate.operationId, action: 'quiesce' } }) : null;
    const receipt = { operationId: gate.operationId, quiesceSettled: Boolean(quiesce?.receipt?.localSettled), projectId: gate.projectId, generation: gate.generation, draining: gate.draining,
      localSettled: units.length === 0 && durableUnits.length === 0, activeRunIds: [...new Set([...units.flatMap((unit) => unit.runId ? [unit.runId] : []), ...durableUnits.flatMap((unit) => unit.runId ? [unit.runId] : [])])],
      remoteStopped: Math.max(quiesce?.receipt?.remoteStopped ?? 0, remoteStopped), remoteOutstanding: remoteRuns + remoteMedia };
    if (gate.draining && quiesce && receipt.localSettled && !receipt.quiesceSettled) {
      receipt.quiesceSettled = true;
      await this.gates.manager.getRepository(HostProjectControlRecord).update({ hostSubject: gate.hostSubject, projectId: gate.projectId, operationId: gate.operationId!, action: 'quiesce' }, { receipt });
    }
    return receipt;
  }
  private async quiesce(projectId: string, input: ProjectControlInput, gate: HostProjectGate): Promise<ProjectControlReceipt> {
    const owner = await this.users.findOneOrFail({ where: { hostSubject: input.hostSubject } });
    // 精确项目与旧代；隐藏绑定列不得被API序列化。
    await this.gates.manager.getRepository(WorkflowTrigger).createQueryBuilder().update()
      .set({ status: 'paused', lastRunStatus: 'authorization_required' })
      .where('"userId" = :userId AND "hostProjectBinding"->>\'projectId\' = :projectId', { userId: owner.id, projectId }).execute();
    const units = this.work.forProject(input.hostSubject, projectId);
    const remote = await Promise.all(units.map(async (unit) => {
      unit.controller.abort();
      try { return unit.remoteStop ? await unit.remoteStop() : false; } catch { return false; }
    }));
    await Promise.all(units.map(async (unit) => { await unit.cancel?.(); await unit.settled; }));
    await this.gates.manager.transaction(async (manager) => {
      for (const entity of [WorkflowRun, MediaJob, BatchTask]) {
        await manager.createQueryBuilder().update(entity)
          .set({ status: 'cancelled' }).where('"userId" = :userId AND "hostProjectId" = :projectId AND "hostGeneration" < :generation AND status IN (:...statuses)',
            { userId: owner.id, projectId, generation: gate.generation, statuses: ['pending', 'running', 'creating', 'queued', 'processing'] }).execute();
      }
    });
    const receipt = await this.snapshot(gate, remote.filter(Boolean).length);
    receipt.quiesceSettled = receipt.localSettled;
    return this.saveReceipt(projectId, input, receipt);
  }
  private async saveReceipt(projectId: string, input: ProjectControlInput, receipt: ProjectControlReceipt): Promise<ProjectControlReceipt> {
    await this.gates.manager.getRepository(HostProjectControlRecord).update({ ...this.key(input.hostSubject, projectId), operationId: input.operationId, action: input.action }, { receipt });
    return receipt;
  }
}
