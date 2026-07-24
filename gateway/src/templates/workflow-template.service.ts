import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowTemplate } from '../database/entities/workflow-template.entity';
import { DifyConverterService } from '../converter/dify-converter.service';

@Injectable()
export class WorkflowTemplateService implements OnModuleInit {
  constructor(
    @InjectRepository(WorkflowTemplate)
    private readonly templateRepo: Repository<WorkflowTemplate>,
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    private readonly converter: DifyConverterService,
  ) {}

  async onModuleInit() {
    // synchronize=true development databases do not run migrations, so make
    // the curated catalog available there as well. Production migration uses
    // the same stable slugs and this remains a no-op.
    for (const template of this.systemTemplates()) {
      await this.templateRepo.upsert(template, ['slug']);
    }
  }

  list() {
    return this.templateRepo.find({
      where: { status: 'active' },
      order: { featured: 'DESC', sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async createWorkflow(userId: string, templateId: string, name?: string) {
    const template = await this.templateRepo.findOne({ where: { id: templateId, status: 'active' } });
    if (!template) throw new NotFoundException('工作流模板不存在或已下线');

    const flowgramJson = this.cloneJson(template.flowgramJson);
    this.converter.validateFlowGram(flowgramJson as any);
    const workflow = this.workflowRepo.create({
      userId,
      name: (name || template.name).trim().slice(0, 128),
      description: template.description,
      flowgramJson,
    });
    return this.workflowRepo.save(workflow);
  }

  private cloneJson(value: Record<string, any>): Record<string, any> {
    return JSON.parse(JSON.stringify(value));
  }

  private systemTemplates(): Array<Partial<WorkflowTemplate>> {
    const create = (
      slug: string,
      name: string,
      description: string,
      category: string,
      tags: string[],
      systemPrompt: string,
      prompt: string,
      sortOrder: number,
    ) => ({
      slug,
      name,
      description,
      category,
      tags,
      featured: true,
      sortOrder,
      requiredVip: 'free',
      requiresDify: false,
      status: 'active',
      flowgramJson: {
        nodes: [
          { id: 'start_0', type: 'start', data: { title: '开始', outputs: { type: 'object', properties: { query: { type: 'string', default: '' } } } } },
          { id: 'llm_0', type: 'llm', data: { title: 'AI 处理', inputsValues: { modelName: { type: 'constant', content: 'deepseek-chat' }, systemPrompt: { type: 'constant', content: systemPrompt }, prompt: { type: 'template', content: prompt } } } },
          { id: 'end_0', type: 'end', data: { title: '结束' } },
        ],
        edges: [
          { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
          { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
        ],
      },
    });
    return [
      create('chat-assistant', '智能问答助手', '通用中文问答与任务协助。', 'assistant', ['问答', '通用'], '你是专业、准确的中文助手。', '{{start_0.query}}', 10),
      create('translator', '中英翻译', '保留原意、语气和格式的中英互译。', 'writing', ['翻译', '文本'], '你是资深中英翻译。只输出译文，保留原始格式。', '{{start_0.query}}', 20),
      create('content-outline', '内容大纲生成', '将主题整理为可执行的文章或视频大纲。', 'writing', ['内容', '大纲'], '你是内容策略师。按层级输出清晰、可执行的大纲。', '请为以下主题生成内容大纲：{{start_0.query}}', 30),
    ];
  }
}
