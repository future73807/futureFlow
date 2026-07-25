/**
 * 工作流列表页
 * 现代卡片网格 + 创建画布
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Typography,
  Empty,
  Dropdown,
  Modal,
  Form,
  Toast,
  Spin,
  Tag,
  Popconfirm,
} from '@douyinfe/semi-ui';
import { IconDelete, IconEdit, IconMore } from '@douyinfe/semi-icons';
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

type DifyPreflightState = 'passed' | 'failed' | 'not_configured' | 'not_checked';

interface DifyPreflightCheck {
  state: DifyPreflightState;
  message: string;
  version?: string;
}

interface DifyPreflightResult {
  checkedAt: string;
  safe: true;
  consoleBase: string;
  checks: {
    apiHealth: DifyPreflightCheck;
    consoleEndpoint: DifyPreflightCheck;
    credentialEncryption: DifyPreflightCheck;
    storedAuthorization: DifyPreflightCheck;
    provisioning: DifyPreflightCheck;
    modelExecution: DifyPreflightCheck;
  };
  nextStep: string;
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
  const [difyPreflight, setDifyPreflight] = useState<DifyPreflightResult | null>(null);
  const [difyLoading, setDifyLoading] = useState(false);
  const [difyPreflighting, setDifyPreflighting] = useState(false);
  const [difyProvisioning, setDifyProvisioning] = useState(false);
  const difySubmitMode = useRef<'validate' | 'save'>('save');

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
      const [status, preflight] = await Promise.all([
        apiJson<DifyIntegrationStatus>('/admin/dify/status'),
        apiJson<DifyPreflightResult>('/admin/dify/preflight'),
      ]);
      setDifyStatus(status);
      setDifyPreflight(preflight);
    } catch (error: any) {
      setDifyStatus(null);
      setDifyPreflight(null);
      Toast.error(error.message || '无法读取 Dify 引擎状态；此设置仅管理员可用');
    } finally {
      setDifyLoading(false);
    }
  }, []);

  const runDifyPreflight = useCallback(async () => {
    setDifyPreflighting(true);
    try {
      const preflight = await apiJson<DifyPreflightResult>('/admin/dify/preflight');
      setDifyPreflight(preflight);
      Toast.success('安全预检已完成：未读取或保存管理员凭据，未创建应用或 Key，也未执行模型。');
    } catch (error: any) {
      Toast.error(error.message || 'Dify 安全预检失败');
    } finally {
      setDifyPreflighting(false);
    }
  }, []);

  const validateDifyAuthorization = useCallback(async (values: {
    consoleBase?: string;
    email?: string;
    password?: string;
    consoleToken?: string;
  }) => {
    setDifyProvisioning(true);
    try {
      await apiJson('/admin/dify/validate-authorization', {
        method: 'POST',
        body: JSON.stringify({
          consoleBase: values.consoleBase?.trim() || undefined,
          email: values.email?.trim() || undefined,
          password: values.password || undefined,
          consoleToken: values.consoleToken?.trim() || undefined,
        }),
      });
      Toast.success('管理员授权已验证：未保存凭据，未创建应用或 Key，未执行模型。');
    } catch (error: any) {
      Toast.error(error.message || 'Dify 管理员授权验证失败');
    } finally {
      setDifyProvisioning(false);
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

  const publishedCount = workflows.filter((workflow) => !!workflow.publishedVersion).length;
  const draftCount = workflows.length - publishedCount;
  const latestWorkflow = workflows.slice().sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
  const latestUpdate = latestWorkflow ? new Date(latestWorkflow.updatedAt).toLocaleDateString('zh-CN') : '-';

  return (
    <PageContainer>
      <PageHeader>
        <HeaderTitle>
          <div className="page-eyebrow">工作区</div>
          <Typography.Title heading={3} style={{ margin: 0, fontWeight: 700 }}>
            工作流
          </Typography.Title>
          <Typography.Text type="tertiary" style={{ marginTop: 5, display: 'block' }}>
            在这里查看、编辑和发布你的 AI 工作流。
          </Typography.Text>
        </HeaderTitle>
        <Button onClick={() => void openDifySettings()}>
          Dify 引擎
        </Button>
      </PageHeader>

      <WorkspaceSummary>
        <SummaryItem>
          <SummaryLabel>全部工作流</SummaryLabel>
          <SummaryValue>{workflows.length}</SummaryValue>
        </SummaryItem>
        <SummaryItem>
          <SummaryLabel>已发布</SummaryLabel>
          <SummaryValue>{publishedCount}</SummaryValue>
        </SummaryItem>
        <SummaryItem>
          <SummaryLabel>草稿</SummaryLabel>
          <SummaryValue>{draftCount}</SummaryValue>
        </SummaryItem>
        <SummaryItem>
          <SummaryLabel>最近更新</SummaryLabel>
          <SummaryValue>{latestUpdate}</SummaryValue>
        </SummaryItem>
      </WorkspaceSummary>

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
                    <path d="M10 16 L24 10 L38 16 L38 32 L24 38 L10 32 Z" stroke="#2563eb" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
                    <circle cx="24" cy="24" r="3" fill="#2563eb" />
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
                <PrimaryCardAction
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/canvas/${wf.id}`);
                  }}
                >
                  <IconEdit /> 打开画布
                </PrimaryCardAction>
                {wf.publishedVersion ? (
                  <ActionButton
                    disabled={publishingId === wf.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleUnpublish(wf.id);
                    }}
                  >
                    取消发布
                  </ActionButton>
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
                <Dropdown
                  trigger="click"
                  position="bottomRight"
                  render={
                    <Dropdown.Menu>
                      <Dropdown.Item onClick={(event) => { event.stopPropagation(); void handleOpenRuns(wf); }}>运行记录</Dropdown.Item>
                      <Dropdown.Item onClick={(event) => { event.stopPropagation(); void handleOpenVersions(wf); }}>版本历史</Dropdown.Item>
                      {wf.publishedVersion && <Dropdown.Item onClick={(event) => { event.stopPropagation(); void handleOpenTriggers(wf); }}>触发器</Dropdown.Item>}
                      {wf.publishedVersion && <Dropdown.Item onClick={(event) => { event.stopPropagation(); setApiWorkflow(wf); }}>API 调用</Dropdown.Item>}
                      {wf.publishedVersion && <Dropdown.Item disabled={difyProvisioning} onClick={(event) => { event.stopPropagation(); void syncPublishedDify(wf.id); }}>同步 Dify</Dropdown.Item>}
                      <Dropdown.Item onClick={(event) => { event.stopPropagation(); handleDuplicate(wf.id); }}>创建副本</Dropdown.Item>
                    </Dropdown.Menu>
                  }
                >
                  <MoreCardAction onClick={(e) => e.stopPropagation()}><IconMore /> 更多</MoreCardAction>
                </Dropdown>
                <Popconfirm
                  title="确认删除此工作流？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    handleDelete(wf.id);
                  }}
                >
                  <DeleteCardAction
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconDelete />
                  </DeleteCardAction>
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
        style={{ width: 960, maxWidth: 'calc(100vw - 32px)' }} bodyStyle={{ maxHeight: 'calc(100vh - 150px)', overflowY: 'auto' }}
      >
        {templatesLoading ? (
          <LoadingCenter><Spin /></LoadingCenter>
        ) : templates.length === 0 ? (
          <Empty description="暂时没有可用模板" />
        ) : (
          <>
            <TemplateIntro>
              <div><strong>从成熟结构开始</strong><span>选择模板后会创建一份独立草稿，不会改动原模板。</span></div>
              <TemplateCount>{templates.length} 个模板</TemplateCount>
            </TemplateIntro>
            <TemplateGrid>
              {templates.map((template) => (
                <TemplateCard key={template.id}>
                  <TemplateCardHeader>
                    <TemplateMark>{template.tags[0]?.slice(0, 1) || 'AI'}</TemplateMark>
                    <TemplateTier>{template.requiresDify ? 'Dify 引擎' : '平台模板'}</TemplateTier>
                  </TemplateCardHeader>
                  <Typography.Title heading={6} style={{ margin: 0 }}>{template.name}</Typography.Title>
                  <TemplateDescription>{template.description}</TemplateDescription>
                  <TemplateTags>
                    {template.tags.map((tag) => <Tag key={tag} size="small">{tag}</Tag>)}
                  </TemplateTags>
                  <Button block theme="solid" type="primary" loading={creating} onClick={() => void handleCreateFromTemplate(template)}>
                    使用此模板
                  </Button>
                </TemplateCard>
              ))}
            </TemplateGrid>
          </>
        )}
      </Modal>

      <Modal
        title="Dify 受控引擎"
        visible={difyVisible}
        onCancel={() => setDifyVisible(false)}
        footer={null}
        style={{ width: 640 }}
        bodyStyle={{ maxHeight: 'calc(100vh - 156px)', overflowY: 'auto', paddingRight: 20 }}
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
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, border: '1px solid #e5e6eb' }}>
              <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
                零成本安全预检
              </Typography.Text>
              <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 10 }}>
                仅检查 Dify 服务可达性和本地加密配置；不会读取或保存管理员凭据，不会创建应用、Key 或执行模型。
              </Typography.Text>
              <Button size="small" loading={difyPreflighting} onClick={() => void runDifyPreflight()}>
                运行安全预检
              </Button>
              {difyPreflight && (
                <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
                  {[
                    ['Dify API', difyPreflight.checks.apiHealth],
                    ['Console 接口', difyPreflight.checks.consoleEndpoint],
                    ['凭据加密', difyPreflight.checks.credentialEncryption],
                    ['已保存授权', difyPreflight.checks.storedAuthorization],
                    ['资源创建', difyPreflight.checks.provisioning],
                    ['模型执行', difyPreflight.checks.modelExecution],
                  ].map(([label, check]) => {
                    const item = check as DifyPreflightCheck;
                    const color = item.state === 'passed' ? 'green' : item.state === 'failed' ? 'red' : 'grey';
                    const stateLabel = item.state === 'passed' ? '通过' : item.state === 'failed' ? '需处理' : '未执行';
                    return (
                      <div key={label as string} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <Tag size="small" color={color}>{stateLabel}</Tag>
                        <Typography.Text size="small" style={{ flex: 1 }}>
                          {label as string}：{item.message}{item.version ? `（${item.version}）` : ''}
                        </Typography.Text>
                      </div>
                    );
                  })}
                  <Typography.Text type="tertiary" size="small">
                    下一步：{difyPreflight.nextStep}
                  </Typography.Text>
                </div>
              )}
            </div>
            <Form onSubmit={(values) => {
              void (difySubmitMode.current === 'validate'
                ? validateDifyAuthorization(values)
                : bootstrapDify(values));
            }}>
              <Form.Input
                field="consoleBase"
                label="Dify Console 地址"
                initValue="http://localhost:5001/console/api"
                placeholder="http://localhost:5001/console/api"
              />
              <Form.Input field="email" label="Dify 管理员邮箱（可选）" placeholder="与密码二选一，或直接使用 Token" />
              <Form.Input field="password" mode="password" label="Dify 管理员密码（可选）" placeholder="仅用于换取令牌，不会保存" />
              <Form.Input field="consoleToken" mode="password" label="Dify Console Token（可选）" placeholder="邮箱密码或 Token 至少填写一种" />
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <Button
                  htmlType="submit"
                  loading={difyProvisioning}
                  style={{ flex: 1, borderRadius: 8 }}
                  onClick={() => { difySubmitMode.current = 'validate'; }}
                >
                  验证管理员授权（不保存）
                </Button>
                <Button
                  type="primary"
                  theme="solid"
                  htmlType="submit"
                  loading={difyProvisioning}
                  style={{ flex: 1, borderRadius: 8 }}
                  onClick={() => { difySubmitMode.current = 'save'; }}
                >
                  保存授权并启用自动建应用 / Key
                </Button>
              </div>
              <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 10 }}>
                保存授权只启用后续发布的资源自动创建；真实模型执行与可能的模型供应商费用，仍需由你显式运行已发布工作流。
              </Typography.Text>
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
  height: 100%;
  overflow-y: auto;
  padding: 34px 40px 48px;

  @media (max-width: 720px) {
    height: auto;
    overflow: visible;
    padding: 24px 16px 32px;
  }
`;

const PageHeader = styled.header`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;

  @media (max-width: 560px) {
    flex-direction: column;
  }
`;

const HeaderTitle = styled.div`
  min-width: 0;

  .page-eyebrow {
    margin-bottom: 5px;
    color: var(--ff-primary);
    font-size: 12px;
    font-weight: 700;
  }
`;

const WorkspaceSummary = styled.section`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0 0 18px;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: var(--ff-border);
  box-shadow: var(--ff-shadow-sm);

  @media (max-width: 880px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 480px) {
    grid-template-columns: 1fr 1fr;
  }
`;

const SummaryItem = styled.div`
  min-height: 88px;
  padding: 16px 18px;
  background: var(--ff-surface);
`;

const SummaryLabel = styled.div`
  color: var(--ff-muted);
  font-size: 12px;
  font-weight: 600;
`;

const SummaryValue = styled.div`
  margin-top: 7px;
  overflow: hidden;
  color: var(--ff-text);
  font-size: 20px;
  font-weight: 700;
  line-height: 26px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const LoadingCenter = styled.div`
  display: grid;
  min-height: 300px;
  place-items: center;
`;

const EmptyState = styled.div`
  display: grid;
  min-height: 300px;
  place-items: center;
`;

const ErrorState = styled.div`
  display: grid;
  justify-items: center;
  gap: 12px;
`;

const WorkflowGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;

  @media (max-width: 420px) {
    grid-template-columns: 1fr;
  }
`;

const WorkflowCard = styled.article`
  display: flex;
  min-height: 230px;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;

  &:hover {
    border-color: #bfdbfe;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
    transform: translateY(-1px);
  }
`;

const CardTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`;

const CardIcon = styled.div`
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid #dbeafe;
  border-radius: var(--ff-radius);
  background: #eff6ff;
`;

const CardTitle = styled.div`
  overflow: hidden;
  color: var(--ff-text);
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CardDesc = styled.div`
  display: -webkit-box;
  min-height: 40px;
  overflow: hidden;
  color: var(--ff-muted);
  font-size: 13px;
  line-height: 20px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
`;

const CardMeta = styled.div`
  margin-top: auto;
  color: var(--ff-subtle);
  font-size: 12px;
`;

const CardActions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid #edf0f5;
`;

const ActionButton = styled.button`
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 10px;
  border: 1px solid var(--ff-border-strong);
  border-radius: var(--ff-radius);
  background: #ffffff;
  color: #475467;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;

  &:hover {
    border-color: #bfdbfe;
    background: #f8fbff;
    color: #1d4ed8;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const PrimaryCardAction = styled(ActionButton)`
  border-color: var(--ff-primary);
  background: var(--ff-primary);
  color: #ffffff;

  &:hover {
    border-color: var(--ff-primary-hover);
    background: var(--ff-primary-hover);
    color: #ffffff;
  }
`;

const MoreCardAction = styled(ActionButton)`
  margin-left: auto;
`;

const DeleteCardAction = styled(ActionButton)`
  min-width: 32px;
  padding: 6px;
  border-color: transparent;
  color: var(--ff-danger);

  .semi-icon {
    margin: 0;
  }

  &:hover {
    border-color: #fecaca;
    background: #fff5f5;
    color: var(--ff-danger);
  }
`;

const CodeBlock = styled.pre`
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  border: 1px solid #1e293b;
  border-radius: var(--ff-radius);
  background: #0f172a;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
`;

const TemplateGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 840px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 580px) {
    grid-template-columns: 1fr;
  }
`;

const TemplateCard = styled.article`
  display: flex;
  min-height: 222px;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: #ffffff;

  .semi-button {
    margin-top: auto;
  }
`;

const TemplateIntro = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid #dbeafe;
  border-radius: var(--ff-radius);
  background: #f8fbff;

  div {
    display: grid;
    gap: 3px;
  }

  strong {
    color: var(--ff-text);
    font-size: 14px;
  }

  span {
    color: var(--ff-muted);
    font-size: 12px;
    line-height: 18px;
  }
`;

const TemplateCount = styled.span`
  flex: 0 0 auto;
  color: var(--ff-primary);
  font-size: 12px;
  font-weight: 700;
`;

const TemplateCardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const TemplateMark = styled.div`
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid #dbeafe;
  border-radius: var(--ff-radius);
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 14px;
  font-weight: 700;
`;

const TemplateTier = styled.span`
  color: var(--ff-muted);
  font-size: 11px;
  font-weight: 600;
`;

const TemplateDescription = styled.div`
  display: -webkit-box;
  min-height: 40px;
  overflow: hidden;
  color: var(--ff-muted);
  font-size: 13px;
  line-height: 20px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
`;

const TemplateTags = styled.div`
  display: flex;
  min-height: 22px;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
`;

const RunLoading = styled.div`
  display: grid;
  min-height: 220px;
  place-items: center;
`;

const RunHistory = styled.div`
  display: flex;
  max-height: 440px;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
`;

const RunRow = styled.div`
  padding: 14px;
  border: 1px solid #e8ecf2;
  border-radius: var(--ff-radius);
  background: #ffffff;
`;

const RunHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`;

const RunMeta = styled.div`
  margin-top: 8px;
  color: var(--ff-muted);
  font-size: 12px;
  line-height: 18px;
`;

const RunError = styled.div`
  margin-top: 8px;
  color: var(--ff-danger);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
`;
