/**
 * 工作流列表页
 * 现代卡片网格 + 创建画布
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { getToken } from '../../utils/auth';

const GATEWAY_URL = 'http://localhost:3001';

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const WorkflowListPage = () => {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createVisible, setCreateVisible] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchWorkflows = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${GATEWAY_URL}/workflows`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setWorkflows(await res.json());
      }
    } catch {
      Toast.error('加载工作流列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const handleCreate = useCallback(
    async (values: any) => {
      setCreating(true);
      try {
        const token = getToken();
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
                  modelName: { type: 'constant', content: 'deepseek-v4-pro' },
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

        const res = await fetch(`${GATEWAY_URL}/workflows`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: values.name,
            description: values.description || '',
            flowgram: JSON.stringify(blankFlowgram),
          }),
        });

        if (res.ok) {
          const wf = await res.json();
          Toast.success('创建成功');
          setCreateVisible(false);
          navigate(`/canvas/${wf.id}`);
        } else {
          const err = await res.json();
          Toast.error(err.message || '创建失败');
        }
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
      const token = getToken();
      try {
        await fetch(`${GATEWAY_URL}/workflows/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        Toast.success('已删除');
        fetchWorkflows();
      } catch {
        Toast.error('删除失败');
      }
    },
    [fetchWorkflows],
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      const token = getToken();
      try {
        await fetch(`${GATEWAY_URL}/workflows/${id}/duplicate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        Toast.success('已复制');
        fetchWorkflows();
      } catch {
        Toast.error('复制失败');
      }
    },
    [fetchWorkflows],
  );

  return (
    <PageContainer>
      <PageHeader>
        <Button
          theme="solid"
          type="primary"
          icon={<IconPlus />}
          onClick={() => setCreateVisible(true)}
          style={{ borderRadius: 8, height: 40, flexShrink: 0 }}
        >
          创建画布
        </Button>
        <HeaderTitle>
          <Typography.Title heading={3} style={{ margin: 0, fontWeight: 600 }}>
            我的工作流
          </Typography.Title>
          <Typography.Text type="tertiary" style={{ marginTop: 4, display: 'block' }}>
            创建和管理你的 AI 工作流画布
          </Typography.Text>
        </HeaderTitle>
      </PageHeader>

      {loading ? (
        <LoadingCenter>
          <Spin size="large" />
        </LoadingCenter>
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
                <Tag size="small" color="blue" style={{ borderRadius: 4 }}>v{wf.version}</Tag>
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
    </PageContainer>
  );
};

const PageContainer = styled.div`
  padding: 32px;
  height: 100%;
  overflow-y: auto;
`;

const PageHeader = styled.div`
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
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

const WorkflowGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
`;

const WorkflowCard = styled.div`
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid #eee;
  display: flex;
  flex-direction: column;
  gap: 8px;

  &:hover {
    border-color: #4834d4;
    box-shadow: 0 8px 24px rgba(72, 52, 212, 0.12);
    transform: translateY(-2px);
  }
`;

const CardTop = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const CardIcon = styled.div`
  width: 44px;
  height: 44px;
  background: #f0f0ff;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const CardTitle = styled.div`
  font-size: 16px;
  font-weight: 600;
  color: #1a1d29;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CardDesc = styled.div`
  font-size: 13px;
  color: #999;
  min-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CardMeta = styled.div`
  font-size: 12px;
  color: #bbb;
  margin-bottom: 8px;
`;

const CardActions = styled.div`
  display: flex;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid #f5f5f5;
`;

const ActionButton = styled.button<{ $danger?: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: ${(props) => (props.$danger ? '#ef4444' : '#666')};
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: ${(props) => (props.$danger ? '#fef2f2' : '#f5f5f5')};
  }
`;
