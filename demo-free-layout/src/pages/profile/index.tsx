/**
 * 个人中心页
 * 信息卡片 + 余额展示 + API Key 管理
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Typography,
  Button,
  Table,
  Tag,
  Modal,
  Form,
  Toast,
  Spin,
  Popconfirm,
  Empty,
} from '@douyinfe/semi-ui';
import { IconPlus, IconDelete, IconCopy } from '@douyinfe/semi-icons';
import styled from 'styled-components';
import { fetchProfile } from '../../utils/auth';
import { apiJson } from '../../utils/api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string;
  createdAt: string;
}

export const ProfilePage = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const fetchApiKeys = useCallback(async () => {
    try {
      setApiKeys(await apiJson<ApiKey[]>('/user/api-keys'));
    } catch (error: any) {
      Toast.error(error.message || '加载 API Key 失败');
    }
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      setLoadError(null);
      try {
        const currentUser = await fetchProfile();
        if (!currentUser) {
          navigate('/login', { replace: true });
          return;
        }
        setUser(currentUser);
        await fetchApiKeys();
      } catch (error: any) {
        setLoadError(error.message || '加载个人信息失败，请确认网关服务已启动');
      } finally {
        setLoading(false);
      }
    };
    void loadProfile();
  }, [fetchApiKeys, navigate]);

  const handleCreateKey = useCallback(
    async (values: any) => {
      try {
        const data = await apiJson<{ plaintext: string }>('/user/api-keys', {
          method: 'POST',
          body: JSON.stringify({ name: values.name || 'default' }),
        });
        setNewKey(data.plaintext);
        setCreateVisible(false);
        await fetchApiKeys();
        setUser(await fetchProfile());
      } catch (error: any) {
        Toast.error(error.message || '创建失败');
      }
    },
    [fetchApiKeys],
  );

  const handleRevoke = useCallback(
    async (id: string) => {
      try {
        await apiJson<{ success: boolean }>(`/user/api-keys/${id}`, {
          method: 'DELETE',
        });
        Toast.success('已撤销');
        await fetchApiKeys();
      } catch (error: any) {
        Toast.error(error.message || '撤销失败');
      }
    },
    [fetchApiKeys],
  );

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      Toast.success('已复制到剪贴板');
    } catch {
      Toast.error('复制失败，请手动复制');
    }
  };

  if (loading) {
    return (
      <Center>
        <Spin size="large" />
      </Center>
    );
  }

  if (!user) {
    return (
      <Center>
        <ErrorState>
          <Empty title="加载失败" description={loadError || '无法加载个人信息'} />
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </ErrorState>
      </Center>
    );
  }

  return (
    <PageContainer>
      <Typography.Title heading={3} style={{ marginBottom: 8, fontWeight: 600 }}>
        个人中心
      </Typography.Title>
      <Typography.Text type="tertiary" style={{ marginBottom: 28, display: 'block' }}>
        管理你的账号信息、余额和 API 密钥
      </Typography.Text>

      {/* 统计卡片 */}
      <StatsRow>
        <StatCard>
          <StatLabel>VIP 等级</StatLabel>
          <StatValue>
            <Tag
              size="large"
              color={user.vipLevel === 'enterprise' ? 'purple' : user.vipLevel === 'pro' ? 'blue' : 'grey'}
              style={{ borderRadius: 6 }}
            >
              {user.vipLevel?.toUpperCase()}
            </Tag>
          </StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>账户余额</StatLabel>
          <StatValue $highlight>¥ {user.balance?.toFixed(2)}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>冻结余额</StatLabel>
          <StatValue>¥ {user.frozenBalance?.toFixed(4)}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>账号状态</StatLabel>
          <StatValue>
            <Tag size="large" color={user.status === 'active' ? 'green' : 'red'} style={{ borderRadius: 6 }}>
              {user.status === 'active' ? '正常' : '已封禁'}
            </Tag>
          </StatValue>
        </StatCard>
      </StatsRow>

      {/* 账号信息 */}
      <SectionCard>
        <Card style={{ borderRadius: 12, border: '1px solid #eee' }}>
          <div style={{ padding: 20 }}>
            <Typography.Title heading={5} style={{ marginBottom: 16 }}>
              账号信息
            </Typography.Title>
            <InfoGrid>
              <InfoItem>
                <InfoLabel>用户名</InfoLabel>
                <InfoValue>{user.username}</InfoValue>
              </InfoItem>
              <InfoItem>
                <InfoLabel>邮箱</InfoLabel>
                <InfoValue>{user.email || '-'}</InfoValue>
              </InfoItem>
              <InfoItem>
                <InfoLabel>注册时间</InfoLabel>
                <InfoValue>{new Date(user.createdAt).toLocaleString('zh-CN')}</InfoValue>
              </InfoItem>

            </InfoGrid>
          </div>
        </Card>
      </SectionCard>

      {/* API Key 管理 */}
      <SectionCard>
        <Card style={{ borderRadius: 12, border: '1px solid #eee' }}>
          <div style={{ padding: 20 }}>
            <SectionHeader>
              <Typography.Title heading={5} style={{ margin: 0 }}>
                API Key 管理
              </Typography.Title>
              <Button
                theme="solid"
                type="primary"
                size="small"
                icon={<IconPlus />}
                onClick={() => setCreateVisible(true)}
                style={{ borderRadius: 6, flexShrink: 0 }}
              >
                新建 Key
              </Button>
            </SectionHeader>

            <Table
              dataSource={apiKeys}
              pagination={false}
              rowKey="id"
              style={{ marginTop: 12 }}
              columns={[
                {
                  title: '名称',
                  dataIndex: 'name',
                  width: 120,
                  render: (text: string) => (
                    <Typography.Text strong>{text}</Typography.Text>
                  ),
                },
                {
                  title: 'Key 前缀',
                  dataIndex: 'keyPrefix',
                  render: (text: string) => (
                    <code style={{ background: '#f0f2ff', padding: '4px 10px', borderRadius: 6, fontSize: 13, color: '#4834d4' }}>
                      {text}...
                    </code>
                  ),
                },
                {
                  title: '最后使用',
                  dataIndex: 'lastUsedAt',
                  render: (text: string) =>
                    text ? new Date(text).toLocaleString('zh-CN') : '从未使用',
                },
                {
                  title: '创建时间',
                  dataIndex: 'createdAt',
                  render: (text: string) => new Date(text).toLocaleString('zh-CN'),
                },
                {
                  title: '操作',
                  render: (_: any, record: ApiKey) => (
                    <Popconfirm
                      title="确认撤销此 API Key？"
                      okText="撤销"
                      cancelText="取消"
                      okType="danger"
                      onConfirm={() => handleRevoke(record.id)}
                    >
                      <Button size="small" type="danger" icon={<IconDelete />} style={{ borderRadius: 6 }}>
                        撤销
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
              empty="暂无 API Key，点击右上角「新建 Key」创建"
            />
          </div>
        </Card>
      </SectionCard>

      {/* 创建 API Key 弹窗 */}
      <Modal
        title="新建 API Key"
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        footer={null}
      >
        <Form onSubmit={handleCreateKey}>
          <Form.Input field="name" label="名称" placeholder="如：生产环境" />
          <Button
            type="primary"
            theme="solid"
            htmlType="submit"
            block
            size="large"
            style={{ marginTop: 16, borderRadius: 8, height: 44 }}
          >
            创建
          </Button>
        </Form>
      </Modal>

      {/* 显示新建 Key 的明文 */}
      <Modal
        title="API Key 已创建"
        visible={!!newKey}
        onCancel={() => setNewKey(null)}
        footer={
          <Button type="primary" theme="solid" onClick={() => setNewKey(null)} style={{ borderRadius: 6 }}>
            我已保存
          </Button>
        }
      >
        <Typography.Text type="danger" style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          ⚠️ 请立即复制并保存，此密钥仅显示一次！
        </Typography.Text>
        <KeyDisplay>
          <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{newKey}</code>
        </KeyDisplay>
        <Button
          icon={<IconCopy />}
          onClick={() => copyToClipboard(newKey!)}
          style={{ marginTop: 12, borderRadius: 6 }}
          block
        >
          复制到剪贴板
        </Button>
      </Modal>
    </PageContainer>
  );
};

const PageContainer = styled.div`
  padding: 32px;
  height: 100%;
  overflow-y: auto;
`;

const StatsRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
`;

const StatCard = styled.div`
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  border: 1px solid #eee;
`;

const StatLabel = styled.div`
  font-size: 13px;
  color: #999;
  margin-bottom: 8px;
`;

const StatValue = styled.div<{ $highlight?: boolean }>`
  font-size: ${(props) => (props.$highlight ? '24px' : '16px')};
  font-weight: ${(props) => (props.$highlight ? 700 : 500)};
  color: ${(props) => (props.$highlight ? '#4834d4' : '#1a1d29')};
`;

const SectionCard = styled.div`
  margin-bottom: 24px;
`;

const InfoGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`;

const InfoItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const InfoLabel = styled.div`
  font-size: 12px;
  color: #999;
`;

const InfoValue = styled.div`
  font-size: 14px;
  color: #1a1d29;
`;

const SectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
`;

const Center = styled.div`
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

const KeyDisplay = styled.div`
  padding: 16px;
  background: #1a1d29;
  border-radius: 8px;
  color: #4ade80;
`;
