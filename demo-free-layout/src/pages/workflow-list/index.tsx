/**
 * 工作流列表页
 * 现代卡片网格 + 创建画布
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Typography,
  Empty,
  Modal,
  Form,
  Toast,
  Spin,
  Tag,
  Popconfirm,
} from '@douyinfe/semi-ui';
import { IconPlus, IconDelete, IconCopy, IconEdit } from '@douyinfe/semi-icons';
import styled from 'styled-components';
import { apiJson } from '../../utils/api';
import { GATEWAY_URL } from '../../utils/config';

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  totalTokens: number;
  totalSteps: number;
  estimatedCost: number;
  actualCost: number;
  elapsedTime: number;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  requiredVip: string;
  requiresDify: boolean;
}

interface WorkflowTrigger {
  id: string;
  name: string;
  type: 'webhook' | 'schedule';
  status: 'active' | 'paused';
  intervalMinutes?: number | null;
  nextRunAt?: string | null;
  lastRunStatus?: string | null;
}

interface WorkflowVersion {
  id: string;
  version: number;
  name: string;
  description: string;
  publishedAt: string;
}

interface DifyIntegrationStatus {
  encryptionReady: boolean;
  connectionAuthorized: boolean;
  status: 'active' | 'not_authorized' | 'reauthorization_required' | 'disabled';
  consoleBase: string | null;
  lastConsoleAuthorizedAt: string | null;
  managedWorkflowAppCount: number;
  managedWorkflowApps: Array<{
    workflowId: string;
    workflowVersion: number;
    appId: string;
    keyFingerprint: string | null;
    lastRotatedAt: string | null;
  }>;
}

interface DifySyncResult {
  appId: string | null;
  status: 'synced' | 'not_configured' | 'failed';
  message: string;
}

export const WorkflowListPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [apiWorkflow, setApiWorkflow] = useState<Workflow | null>(null);
  const [runsWorkflow, setRunsWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [versionsWorkflow, setVersionsWorkflow] = useState<Workflow | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [templateVisible, setTemplateVisible] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [triggerWorkflow, setTriggerWorkflow] = useState<Workflow | null>(null);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggerCreating, setTriggerCreating] = useState(false);
  const [triggerUpdatingId, setTriggerUpdatingId] = useState<string | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState<string | null>(null);
  const [difyVisible, setDifyVisible] = useState(false);
  const [difyStatus, setDifyStatus] = useState<DifyIntegrationStatus | null>(null);
  const [difyLoading, setDifyLoading] = useState(false);
  const [difyProvisioning, setDifyProvisioning] = useState(false);

  const fetchWorkflows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setWorkflows(await apiJson<Workflow[]>('/workflows'));
    } catch (error: any) {
      setLoadError(error.message || '加载工作流列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      setTemplates(await apiJson<WorkflowTemplate[]>('/workflow-templates'));
    } catch (error: any) {
      Toast.error(error.message || '加载模板库失败');
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const openTemplates = useCallback(() => {
    setTemplateVisible(true);
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    const action = searchParams.get('action');
    if (action !== 'create' && action !== 'templates') return;
    if (action === 'create') setCreateVisible(true);
    if (action === 'templates') void openTemplates();
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [openTemplates, searchParams, setSearchParams]);

  const openDifySettings = useCallback(async () => {
    setDifyVisible(true);
    setDifyLoading(true);
    try {
      setDifyStatus(await apiJson<DifyIntegrationStatus>('/admin/dify/status'));
    } catch (error: any) {
      setDifyStatus(null);
      Toast.error(error.message || '无法读取 Dify 引擎状态；此设置仅管理员可用');
    } finally {
      setDifyLoading(false);
    }
  }, []);

  const bootstrapDify = useCallback(async (values: {
    consoleBase?: string;
    email?: string;
    password?: string;
    consoleToken?: string;
  }) => {
    setDifyProvisioning(true);
    try {
      const status = await apiJson<DifyIntegrationStatus>('/admin/dify/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          consoleBase: values.consoleBase?.trim() || undefined,
          email: values.email?.trim() || undefined,
          password: values.password || undefined,
          consoleToken: values.consoleToken?.trim() || undefined,
        }),
      });
      setDifyStatus(status);
      Toast.success('Dify 已授权；之后每次发布都会自动创建独立应用和加密 Key');
    } catch (error: any) {
      Toast.error(error.message || 'Dify 授权或自动建 Key 失败');
    } finally {
      setDifyProvisioning(false);
    }
  }, []);

  const syncPublishedDify = useCallback(async (id: string) => {
    setDifyProvisioning(true);
    try {
      const result = await apiJson<DifySyncResult>(`/workflows/${id}/dify/sync`, {
        method: 'POST',
      });
      if (result.status === 'synced') {
        Toast.success('已同步到该工作流版本专属的 Dify 应用');
      } else {
        Toast.error(result.message);
      }
    } catch (error: any) {
      Toast.error(error.message || 'Dify 同步失败，请检查授权和 Dify 模型配置');
    } finally {
      setDifyProvisioning(false);
    }
  }, []);

  const handleCreateFromTemplate = useCallback(async (template: WorkflowTemplate) => {
    setCreating(true);
    try {
      const workflow = await apiJson<Workflow>(`/workflow-templates/${template.id}/create-workflow`, {
        method: 'POST',
        body: JSON.stringify({ name: template.name }),
      });
      Toast.success(`已从「${template.name}」创建工作流`);
      setTemplateVisible(false);
      navigate(`/canvas/${workflow.id}`);
    } catch (error: any) {
      Toast.error(error.message || '从模板创建失败');
    } finally {
      setCreating(false);
    }
  }, [navigate]);

  const handleOpenTriggers = useCallback(async (workflow: Workflow) => {
    setTriggerWorkflow(workflow);
    setNewWebhookUrl(null);
    setTriggersLoading(true);
    try {
      setTriggers(await apiJson<WorkflowTrigger[]>(`/workflows/${workflow.id}/triggers`));
    } catch (error: any) {
      setTriggers([]);
      Toast.error(error.message || '加载触发器失败');
    } finally {
      setTriggersLoading(false);
    }
  }, []);

  const createTrigger = useCallback(async (type: 'webhook' | 'schedule') => {
    if (!triggerWorkflow) return;
    setTriggerCreating(true);
    try {
      const result = await apiJson<any>(`/workflows/${triggerWorkflow.id}/triggers`, {
        method: 'POST',
        body: JSON.stringify(
          type === 'webhook'
            ? { name: 'Webhook 触发器', type }
            : { name: '每小时定时触发', type, intervalMinutes: 60 },
        ),
      });
      setTriggers((items) => [result.trigger, ...items]);
      if (result.webhookUrl) setNewWebhookUrl(result.webhookUrl);
      Toast.success(type === 'webhook' ? 'Webhook 已创建，请立即复制地址' : '定时触发器已创建');
    } catch (error: any) {
      Toast.error(error.message || '创建触发器失败');
    } finally {
      setTriggerCreating(false);
    }
  }, [triggerWorkflow]);

  const deleteTrigger = useCallback(async (triggerId: string) => {
    if (!triggerWorkflow) return;
    try {
      await apiJson(`/workflows/${triggerWorkflow.id}/triggers/${triggerId}`, { method: 'DELETE' });
      setTriggers((items) => items.filter((item) => item.id !== triggerId));
      Toast.success('触发器已删除');
    } catch (error: any) {
      Toast.error(error.message || '删除触发器失败');
    }
  }, [triggerWorkflow]);

  const updateTrigger = useCallback(async (
    trigger: WorkflowTrigger,
    patch: Partial<Pick<WorkflowTrigger, 'status'>>,
  ) => {
    if (!triggerWorkflow) return;
    setTriggerUpdatingId(trigger.id);
    try {
      const updated = await apiJson<WorkflowTrigger>(
        `/workflows/${triggerWorkflow.id}/triggers/${trigger.id}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      setTriggers((items) => items.map((item) => item.id === updated.id ? updated : item));
      Toast.success(updated.status === 'paused' ? '触发器已暂停' : '触发器已启用');
    } catch (error: any) {
      Toast.error(error.message || '更新触发器失败');
    } finally {
      setTriggerUpdatingId(null);
    }
  }, [triggerWorkflow]);

  const rotateWebhook = useCallback(async (trigger: WorkflowTrigger) => {
    if (!triggerWorkflow) return;
    setTriggerUpdatingId(trigger.id);
    try {
      const result = await apiJson<any>(
        `/workflows/${triggerWorkflow.id}/triggers/${trigger.id}/rotate-webhook`,
        { method: 'POST' },
      );
      setTriggers((items) => items.map((item) => item.id === result.trigger.id ? result.trigger : item));
      setNewWebhookUrl(result.webhookUrl || null);
      Toast.success('Webhook 地址已轮换，请立即复制新地址');
    } catch (error: any) {
      Toast.error(error.message || '轮换 Webhook 地址失败');
    } finally {
      setTriggerUpdatingId(null);
    }
  }, [triggerWorkflow]);

  const handleCreate = useCallback(
    async (values: any) => {
      setCreating(true);
      try {
        const blankFlowgram = {
          nodes: [
            {
              id: 'start_0',
              type: 'start',
              meta: { position: { x: 80, y: 200 } },
              data: {
                title: 'Start',
                outputs: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', default: '你好，请介绍一下你自己。' },
                  },
                },
              },
            },
            {
              id: 'llm_0',
              type: 'llm',
              meta: { position: { x: 480, y: 200 } },
              data: {
                title: 'LLM_1',
                inputsValues: {
                  modelName: { type: 'constant', content: 'deepseek-chat' },
                  temperature: { type: 'constant', content: 0.7 },
                  systemPrompt: { type: 'template', content: '你是一个友好的 AI 助手，请用简洁的中文回答用户的问题。' },
                  prompt: { type: 'template', content: '{{start_0.query}}' },
                },
                inputs: {
                  type: 'object',
                  required: ['modelName', 'temperature', 'prompt'],
                  properties: {
                    modelName: { type: 'string' },
                    temperature: { type: 'number' },
                    systemPrompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
                    prompt: { type: 'string', extra: { formComponent: 'prompt-editor' } },
                  },
                },
                outputs: {
                  type: 'object',
                  properties: { result: { type: 'string' } },
                },
              },
            },
            {
              id: 'end_0',
              type: 'end',
              meta: { position: { x: 880, y: 200 } },
              data: {
                title: 'End',
                inputsValues: { result: { type: 'ref', content: ['llm_0', 'result'] } },
                inputs: { type: 'object', properties: { result: { type: 'string' } } },
              },
            },
          ],
          edges: [
            { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
            { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
          ],
        };

        const wf = await apiJson<Workflow>('/workflows', {
          method: 'POST',
          body: JSON.stringify({
            name: values.name,
            description: values.description || '',
            flowgram: JSON.stringify(blankFlowgram),
          }),
        });

        Toast.success('创建成功');
        setCreateVisible(false);
        navigate(`/canvas/${wf.id}`);
      } catch (err: any) {
        Toast.error(err.message || '创建失败');
      } finally {
        setCreating(false);
      }
    },
    [navigate],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiJson<{ success: boolean }>(`/workflows/${id}`, {
          method: 'DELETE',
        });
        Toast.success('已删除');
        await fetchWorkflows();
      } catch (error: any) {
        Toast.error(error.message || '删除失败');
      }
    },
    [fetchWorkflows],
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        await apiJson<Workflow>(`/workflows/${id}/duplicate`, {
          method: 'POST',
        });
        Toast.success('已复制');
        await fetchWorkflows();
      } catch (error: any) {
        Toast.error(error.message || '复制失败');
      }
    },
    [fetchWorkflows],
  );

  const handlePublish = useCallback(
    async (id: string) => {
      setPublishingId(id);
      try {
        const result = await apiJson<{ workflow: Workflow; message: string; dify: DifySyncResult }>(
          `/workflows/${id}/publish`,
          { method: 'POST' },
        );
        if (result.dify?.status === 'synced') {
          Toast.success(`${result.message}，已同步至版本专属 Dify 应用`);
        } else {
          Toast.success(`${result.message}；${result.dify?.message || '当前使用直接 LLM 引擎'}`);
        }
        await fetchWorkflows();
      } catch (error: any) {
        Toast.error(error.message || '发布失败');
      } finally {
        setPublishingId(null);
      }
    },
    [fetchWorkflows],
  );

  const handleUnpublish = useCallback(
    async (id: string) => {
      setPublishingId(id);
      try {
        await apiJson(`/workflows/${id}/unpublish`, { method: 'POST' });
        Toast.success('已取消发布，线上调用已停止');
        await fetchWorkflows();
      } catch (error: any) {
        Toast.error(error.message || '取消发布失败');
      } finally {
        setPublishingId(null);
      }
    },
    [fetchWorkflows],
  );

  const handleOpenRuns = useCallback(async (workflow: Workflow) => {
    setRunsWorkflow(workflow);
    setRunsLoading(true);
    try {
      const result = await apiJson<{ items: WorkflowRun[] }>(`/workflows/${workflow.id}/runs`);
      setRuns(result.items);
    } catch (error: any) {
      setRuns([]);
      Toast.error(error.message || '加载运行记录失败');
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const handleOpenVersions = useCallback(async (workflow: Workflow) => {
    setVersionsWorkflow(workflow);
    setVersionsLoading(true);
    try {
      setVersions(await apiJson<WorkflowVersion[]>(`/workflows/${workflow.id}/versions`));
    } catch (error: any) {
      setVersions([]);
      Toast.error(error.message || '加载版本历史失败');
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  const restoreVersion = useCallback(async (version: WorkflowVersion) => {
    if (!versionsWorkflow) return;
    setRestoringVersion(version.version);
    try {
      await apiJson<Workflow>(
        `/workflows/${versionsWorkflow.id}/versions/${version.version}/restore`,
        { method: 'POST' },
      );
      Toast.success(`已将 v${version.version} 恢复为草稿；请检查后重新发布`);
      await fetchWorkflows();
    } catch (error: any) {
      Toast.error(error.message || '恢复版本失败');
    } finally {
      setRestoringVersion(null);
    }
  }, [fetchWorkflows, versionsWorkflow]);

  return (
    <PageContainer>
      <PageHeader>
        <HeaderTitle>
          <Typography.Title heading={3} style={{ margin: 0, fontWeight: 600 }}>
            我的工作流
          </Typography.Title>
          <Typography.Text type="tertiary" style={{ marginTop: 4, display: 'block' }}>
            创建和管理你的 AI 工作流画布
          </Typography.Text>
        </HeaderTitle>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void openDifySettings()} style={{ borderRadius: 8, height: 40 }}>
            Dify 引擎
          </Button>
          <Button onClick={openTemplates} style={{ display: 'none' }}>
            模板库
          </Button>
        <Button
          theme="solid"
          type="primary"
          icon={<IconPlus />}
          onClick={() => setCreateVisible(true)}
          style={{ display: 'none' }}
        >
          创建画布
        </Button>
        </div>
      </PageHeader>

      {loading ? (
        <LoadingCenter>
          <Spin size="large" />
        </LoadingCenter>
      ) : loadError ? (
        <EmptyState>
          <ErrorState>
            <Empty title="加载失败" description={loadError} />
            <Button onClick={() => void fetchWorkflows()}>重新加载</Button>
          </ErrorState>
        </EmptyState>
      ) : workflows.length === 0 ? (
        <EmptyState>
          <Empty
            title="还没有工作流"
            description="点击「创建画布」开始你的第一个 AI 工作流"
          />
        </EmptyState>
      ) : (
        <WorkflowGrid>
          {workflows.map((wf) => (
            <WorkflowCard key={wf.id} onClick={() => navigate(`/canvas/${wf.id}`)}>
              <CardTop>
                <CardIcon>
                  <svg width="28" height="28" viewBox="0 0 48 48" fill="none">
                    <path d="M10 16 L24 10 L38 16 L38 32 L24 38 L10 32 Z" stroke="#4834d4" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
                    <circle cx="24" cy="24" r="3" fill="#4834d4" />
                  </svg>
                </CardIcon>
                <Tag
                  size="small"
                  color={wf.publishedVersion ? 'green' : 'blue'}
                  style={{ borderRadius: 4 }}
                >
                  {wf.publishedVersion
                    ? `已发布 v${wf.publishedVersion}`
                    : `草稿 v${wf.version}`}
                </Tag>
              </CardTop>
              <CardTitle>{wf.name}</CardTitle>
              <CardDesc>{wf.description || '暂无描述'}</CardDesc>
              <CardMeta>
                更新于 {new Date(wf.updatedAt).toLocaleDateString('zh-CN')}
              </CardMeta>
              <CardActions>
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/canvas/${wf.id}`);
                  }}
                >
                  <IconEdit /> 编辑
                </ActionButton>
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleOpenRuns(wf);
                  }}
                >
                  运行记录
                </ActionButton>
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleOpenVersions(wf);
                  }}
                >
                  版本历史
                </ActionButton>
                {wf.publishedVersion ? (
                  <>
                    <ActionButton
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleOpenTriggers(wf);
                      }}
                    >
                      触发器
                    </ActionButton>
                    <ActionButton
                      onClick={(e) => {
                        e.stopPropagation();
                        setApiWorkflow(wf);
                      }}
                    >
                      API 调用
                    </ActionButton>
                    <ActionButton
                      disabled={difyProvisioning}
                      onClick={(e) => {
                        e.stopPropagation();
                        void syncPublishedDify(wf.id);
                      }}
                    >
                      同步 Dify
                    </ActionButton>
                    <ActionButton
                      disabled={publishingId === wf.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleUnpublish(wf.id);
                      }}
                    >
                      取消发布
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton
                    disabled={publishingId === wf.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handlePublish(wf.id);
                    }}
                  >
                    发布
                  </ActionButton>
                )}
                <ActionButton
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDuplicate(wf.id);
                  }}
                >
                  <IconCopy /> 复制
                </ActionButton>
                <Popconfirm
                  title="确认删除此工作流？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    handleDelete(wf.id);
                  }}
                >
                  <ActionButton
                    $danger
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconDelete /> 删除
                  </ActionButton>
                </Popconfirm>
              </CardActions>
            </WorkflowCard>
          ))}
        </WorkflowGrid>
      )}

      <Modal
        title="创建新画布"
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        footer={null}
        style={{ borderRadius: 12 }}
      >
        <Form onSubmit={handleCreate}>
          <Form.Input
            field="name"
            label="工作流名称"
            placeholder="如：翻译助手"
            size="large"
            rules={[{ required: true, message: '请输入名称' }]}
          />
          <Form.TextArea
            field="description"
            label="描述"
            placeholder="可选，简要描述工作流用途"
            rows={2}
          />
          <Button
            type="primary"
            theme="solid"
            htmlType="submit"
            loading={creating}
            size="large"
            block
            style={{ marginTop: 16, borderRadius: 8, height: 44 }}
          >
            创建并进入编辑
          </Button>
        </Form>
      </Modal>

      <Modal
        title="工作流模板库"
        visible={templateVisible}
        onCancel={() => setTemplateVisible(false)}
        footer={null}
        style={{ width: 960, maxWidth: 'calc(100vw - 40px)' }}
      >
        {templatesLoading ? (
          <LoadingCenter><Spin /></LoadingCenter>
        ) : templates.length === 0 ? (
          <Empty description="暂时没有可用模板" />
        ) : (
          <TemplateGrid>
            {templates.map((template) => (
              <TemplateCard key={template.id}>
                <Typography.Title heading={6} style={{ margin: '0 0 6px' }}>{template.name}</Typography.Title>
                <Typography.Text type="tertiary" style={{ minHeight: 40, display: 'block' }}>{template.description}</Typography.Text>
                <TemplateTags>
                  {template.tags.map((tag) => <Tag key={tag} size="small">{tag}</Tag>)}
                  {template.requiresDify && <Tag size="small" color="orange">需要 Dify</Tag>}
                </TemplateTags>
                <Button block theme="solid" type="primary" loading={creating} onClick={() => void handleCreateFromTemplate(template)}>
                  使用模板
                </Button>
              </TemplateCard>
            ))}
          </TemplateGrid>
        )}
      </Modal>

      <Modal
        title="Dify 受控引擎"
        visible={difyVisible}
        onCancel={() => setDifyVisible(false)}
        footer={null}
        style={{ width: 640 }}
      >
        {difyLoading ? (
          <LoadingCenter><Spin /></LoadingCenter>
        ) : (
          <>
            <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 12 }}>
              只需完成一次管理员授权。futureFlow 会在每次发布时，为该工作流版本自动创建独立 Dify 应用、生成独立 Service API Key，并将密钥加密保存；页面不会回显明文密钥。
            </Typography.Text>
            {difyStatus && (
              <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: '#f7f8fa' }}>
                <Tag color={difyStatus.connectionAuthorized ? 'green' : 'orange'}>
                  {difyStatus.connectionAuthorized ? '已授权' : '未授权'}
                </Tag>
                <Typography.Text style={{ marginLeft: 8 }}>
                  已管理 {difyStatus.managedWorkflowAppCount} 个独立发布版本
                </Typography.Text>
                {!difyStatus.encryptionReady && (
                  <Typography.Text type="warning" style={{ display: 'block', marginTop: 8 }}>
                    请先在 .env 设置至少 32 位且非示例值的 DIFY_KEY_ENCRYPTION_SECRET。
                  </Typography.Text>
                )}
              </div>
            )}
            <Form onSubmit={bootstrapDify}>
              <Form.Input
                field="consoleBase"
                label="Dify Console 地址"
                initValue="http://localhost:5001/console/api"
                placeholder="http://localhost:5001/console/api"
              />
              <Form.Input field="email" label="Dify 管理员邮箱（可选）" placeholder="与密码二选一，或直接使用 Token" />
              <Form.Input field="password" mode="password" label="Dify 管理员密码（可选）" placeholder="仅用于换取令牌，不会保存" />
              <Form.Input field="consoleToken" mode="password" label="Dify Console Token（可选）" placeholder="邮箱密码或 Token 至少填写一种" />
              <Button
                type="primary"
                theme="solid"
                htmlType="submit"
                loading={difyProvisioning}
                block
                style={{ marginTop: 12, borderRadius: 8 }}
              >
                授权 Dify 并启用发布自动建 Key
              </Button>
            </Form>
          </>
        )}
      </Modal>

      <Modal
        title={`${apiWorkflow?.name || ''} · API 调用`}
        visible={!!apiWorkflow}
        onCancel={() => setApiWorkflow(null)}
        footer={
          <Button type="primary" theme="solid" onClick={() => setApiWorkflow(null)}>
            完成
          </Button>
        }
      >
        <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 12 }}>
          已发布版本可通过平台 API Key 调用；编辑草稿不会影响当前线上版本。
        </Typography.Text>
        <CodeBlock>{`curl -X POST ${GATEWAY_URL}/workflows/${apiWorkflow?.id || '<WORKFLOW_ID>'}/execute \\
  -H "Authorization: Bearer ff-xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"inputs":{"query":"你好"}}'`}</CodeBlock>
        <Typography.Text type="tertiary" style={{ display: 'block', marginTop: 12 }}>
          返回为 SSE 流。请在「个人中心」创建或管理 API Key。
        </Typography.Text>
      </Modal>

      <Modal
        title={`${runsWorkflow?.name || ''} · 运行记录`}
        visible={!!runsWorkflow}
        onCancel={() => setRunsWorkflow(null)}
        footer={
          <Button onClick={() => setRunsWorkflow(null)}>
            关闭
          </Button>
        }
        style={{ width: 680 }}
      >
        {runsLoading ? (
          <RunLoading><Spin /></RunLoading>
        ) : runs.length === 0 ? (
          <Empty description="暂无已发布 API 调用记录" />
        ) : (
          <RunHistory>
            {runs.map((run) => (
              <RunRow key={run.id}>
                <RunHeader>
                  <Tag
                    size="small"
                    color={run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : 'blue'}
                  >
                    {run.status === 'succeeded' ? '成功' : run.status === 'failed' ? '失败' : '运行中'}
                  </Tag>
                  <Typography.Text type="tertiary" size="small">
                    {new Date(run.createdAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                </RunHeader>
                <RunMeta>
                  {run.totalTokens} Tokens · {run.totalSteps} 步 · {run.elapsedTime?.toFixed(2) || '0.00'} 秒 · ¥{Number(run.actualCost || 0).toFixed(4)}
                </RunMeta>
                {run.errorMessage && <RunError>{run.errorMessage}</RunError>}
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
      <Modal
        title={`${versionsWorkflow?.name || ''} · 发布版本历史`}
        visible={!!versionsWorkflow}
        onCancel={() => setVersionsWorkflow(null)}
        footer={<Button onClick={() => setVersionsWorkflow(null)}>关闭</Button>}
        style={{ width: 680 }}
      >
        <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 12 }}>
          恢复只会写入当前草稿，不会自动替换线上已发布版本；确认后请在画布检查并重新发布。
        </Typography.Text>
        {versionsLoading ? (
          <RunLoading><Spin /></RunLoading>
        ) : versions.length === 0 ? (
          <Empty description="暂无发布版本" />
        ) : (
          <RunHistory>
            {versions.map((version) => (
              <RunRow key={version.id}>
                <RunHeader>
                  <Typography.Text strong>v{version.version} · {version.name}</Typography.Text>
                  <Typography.Text type="tertiary" size="small">
                    {new Date(version.publishedAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                </RunHeader>
                <RunMeta>{version.description || '无描述'}</RunMeta>
                <Popconfirm
                  title={`恢复 v${version.version} 为当前草稿？`}
                  content="线上已发布版本不会自动改变。"
                  okText="恢复草稿"
                  cancelText="取消"
                  onConfirm={() => void restoreVersion(version)}
                >
                  <Button
                    size="small"
                    style={{ marginTop: 8 }}
                    loading={restoringVersion === version.version}
                  >
                    恢复为草稿
                  </Button>
                </Popconfirm>
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
      <Modal
        title={`${triggerWorkflow?.name || ''} · 触发器`}
        visible={!!triggerWorkflow}
        onCancel={() => setTriggerWorkflow(null)}
        footer={<Button onClick={() => setTriggerWorkflow(null)}>关闭</Button>}
        style={{ width: 680 }}
      >
        <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 12 }}>
          Webhook 适合外部系统事件；定时触发器按固定分钟间隔执行已发布快照。
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <Button theme="solid" type="primary" loading={triggerCreating} onClick={() => void createTrigger('webhook')}>创建 Webhook</Button>
          <Button loading={triggerCreating} onClick={() => void createTrigger('schedule')}>创建每小时定时触发</Button>
        </div>
        {newWebhookUrl && (
          <>
            <Typography.Text type="warning" style={{ display: 'block', marginBottom: 6 }}>请立即保存此地址；轮换后旧地址立即失效。</Typography.Text>
            <CodeBlock>{newWebhookUrl}</CodeBlock>
          </>
        )}
        {triggersLoading ? (
          <RunLoading><Spin /></RunLoading>
        ) : triggers.length === 0 ? (
          <Empty description="尚未配置触发器" />
        ) : (
          <RunHistory>
            {triggers.map((trigger) => (
              <RunRow key={trigger.id}>
                <RunHeader>
                  <Typography.Text strong>{trigger.name}</Typography.Text>
                  <Tag size="small" color={trigger.type === 'webhook' ? 'blue' : 'orange'}>{trigger.type === 'webhook' ? 'Webhook' : '定时'}</Tag>
                </RunHeader>
                <RunMeta>
                  {trigger.type === 'schedule' ? `每 ${trigger.intervalMinutes} 分钟 · 下次 ${trigger.nextRunAt ? new Date(trigger.nextRunAt).toLocaleString('zh-CN') : '-'}` : '使用专属安全地址调用'}
                  {trigger.lastRunStatus ? ` · 上次 ${trigger.lastRunStatus}` : ''}
                </RunMeta>
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  <Button
                    theme="borderless"
                    size="small"
                    loading={triggerUpdatingId === trigger.id}
                    onClick={() => void updateTrigger(trigger, { status: trigger.status === 'active' ? 'paused' : 'active' })}
                  >
                    {trigger.status === 'active' ? '暂停' : '启用'}
                  </Button>
                  {trigger.type === 'webhook' && (
                    <Button
                      theme="borderless"
                      size="small"
                      loading={triggerUpdatingId === trigger.id}
                      onClick={() => void rotateWebhook(trigger)}
                    >
                      轮换地址
                    </Button>
                  )}
                  <Button theme="borderless" type="danger" size="small" onClick={() => void deleteTrigger(trigger.id)}>删除</Button>
                </div>
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
    </PageContainer>
  );
};

const PageContainer = styled.div`
  padding: 34px 38px 48px;
  height: 100%;
  overflow-y: auto;

  @media (max-width: 720px) {
    height: auto;
    padding: 20px 16px 32px;
    overflow: visible;
  }
`;

const PageHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;

  @media (max-width: 520px) {
    align-items: flex-start;
    flex-direction: column;
  }
`;

const HeaderTitle = styled.div`
  display: flex;
  flex-direction: column;
`;

const LoadingCenter = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 300px;
`;

const EmptyState = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 300px;
`;

const ErrorState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
`;

const WorkflowGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 16px;

  @media (max-width: 420px) { grid-template-columns: 1fr; }
`;

const WorkflowCard = styled.div`
  background: #fff;
  border-radius: var(--ff-radius-lg);
  padding: 22px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid var(--ff-border);
  display: flex;
  flex-direction: column;
  gap: 8px;

  &:hover {
    border-color: #b9c3f5;
    box-shadow: 0 10px 24px rgba(16, 24, 40, .08);
    transform: translateY(-1px);
  }
`;

const CardTop = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const CardIcon = styled.div`
  width: 40px;
  height: 40px;
  background: #eef1ff;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const CardTitle = styled.div`
  font-size: 16px;
  font-weight: 600;
  color: var(--ff-text);
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CardDesc = styled.div`
  font-size: 13px;
  color: var(--ff-muted);
  min-height: 38px;
  line-height: 19px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CardMeta = styled.div`
  font-size: 12px;
  color: var(--ff-subtle);
  margin-bottom: 10px;
`;

const CardActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding-top: 14px;
  border-top: 1px solid #eef1f5;
`;

const ActionButton = styled.button<{ $danger?: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: #f8fafc;
  color: ${(props) => (props.$danger ? '#d92d20' : '#475467')};
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: ${(props) => (props.$danger ? '#fff1f0' : '#eef1ff')};
    border-color: ${(props) => (props.$danger ? '#ffd4d1' : '#dce2ff')};
    color: ${(props) => (props.$danger ? '#b42318' : '#4054bf')};
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const CodeBlock = styled.pre`
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  border-radius: 8px;
  background: #1a1d29;
  color: #d8f7d8;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
`;

const TemplateGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 720px) { grid-template-columns: 1fr; }
`;

const TemplateCard = styled.article`
  min-height: 194px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--ff-border);
  border-radius: 12px;
  background: #fff;

  .semi-button { margin-top: auto; }
`;

const TemplateTags = styled.div`
  min-height: 22px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
`;

const RunLoading = styled.div`
  display: flex;
  justify-content: center;
  padding: 40px;
`;

const RunHistory = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 460px;
  overflow-y: auto;
`;

const RunRow = styled.div`
  padding: 12px;
  border: 1px solid #eceef4;
  border-radius: 8px;
`;

const RunHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`;

const RunMeta = styled.div`
  margin-top: 8px;
  color: #666;
  font-size: 12px;
`;

const RunError = styled.div`
  margin-top: 8px;
  color: #e5484d;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
`;
