import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow } from '../database/entities/workflow.entity';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow-crud.dto';

@Injectable()
export class WorkflowCrudService {
  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
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
    return wf;
  }

  async create(userId: string, dto: CreateWorkflowDto): Promise<Workflow> {
    const wf = this.workflowRepo.create({
      userId,
      name: dto.name,
      description: dto.description || '',
      flowgramJson: JSON.parse(dto.flowgram),
    });
    return this.workflowRepo.save(wf);
  }

  async update(id: string, userId: string, dto: UpdateWorkflowDto): Promise<Workflow> {
    const wf = await this.getById(id, userId);
    if (dto.name !== undefined) wf.name = dto.name;
    if (dto.description !== undefined) wf.description = dto.description;
    if (dto.flowgram !== undefined) wf.flowgramJson = JSON.parse(dto.flowgram);
    if (dto.status !== undefined) wf.status = dto.status;
    wf.version += 1;
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
}
