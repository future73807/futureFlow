import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Button,
  Empty,
  Form,
  Modal,
  Popconfirm,
  Spin,
  Table,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconCopy, IconDelete, IconEdit, IconKey, IconPlus } from '@douyinfe/semi-icons';
import styled from 'styled-components';
import { fetchProfile, setUser } from '../../utils/auth';
import { apiJson } from '../../utils/api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export const ProfilePage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [user, setCurrentUser] = useState<any>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const fetchApiKeys = useCallback(async () => {
    setApiKeys(await apiJson<ApiKey[]>('/user/api-keys'));
  }, []);

  const loadPage = useCallback(async () => {
    setLoadError(null);
    try {
      const profile = await fetchProfile();
      if (!profile) {
        navigate('/login', { replace: true });
        return;
      }
      setCurrentUser(profile);
      await fetchApiKeys();
    } catch (error: any) {
      setLoadError(error.message || '加载个人中心失败，请确认网关服务已启动');
    } finally {
      setLoading(false);
    }
  }, [fetchApiKeys, navigate]);

  useEffect(() => { void loadPage(); }, [loadPage]);

  useEffect(() => {
    if (searchParams.get('action') !== 'create-key') return;
    setCreateVisible(true);
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleCreateKey = useCallback(async (values: { name?: string }) => {
    try {
      const data = await apiJson<{ plaintext: string }>('/user/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: values.name?.trim() || 'default' }),
      });
      setNewKey(data.plaintext);
      setCreateVisible(false);
      await fetchApiKeys();
    } catch (error: any) {
      Toast.error(error.message || '创建 Key 失败');
    }
  }, [fetchApiKeys]);

  const handleUpdateProfile = useCallback(async (values: { username?: string; email?: string }) => {
    setSavingProfile(true);
    try {
      const updated = await apiJson('/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ username: values.username?.trim(), email: values.email?.trim() }),
      });
      setUser(updated);
      setCurrentUser(updated);
      setEditVisible(false);
      Toast.success('个人信息已更新');
    } catch (error: any) {
      Toast.error(error.message || '保存个人信息失败');
    } finally {
      setSavingProfile(false);
    }
  }, []);

  const handleRevoke = useCallback(async (id: string) => {
    try {
      await apiJson(`/user/api-keys/${id}`, { method: 'DELETE' });
      Toast.success('Key 已撤销');
      await fetchApiKeys();
    } catch (error: any) {
      Toast.error(error.message || '撤销 Key 失败');
    }
  }, [fetchApiKeys]);

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success('已复制到剪贴板');
    } catch {
      Toast.error('复制失败，请手动复制');
    }
  };

  if (loading) return <Center><Spin size="large" /></Center>;
  if (!user) {
    return <Center><ErrorState><Empty title="加载失败" description={loadError || '无法读取个人信息'} /><Button onClick={() => void loadPage()}>重新加载</Button></ErrorState></Center>;
  }

  const joinDate = user.createdAt ? new Date(user.createdAt).toLocaleDateString('zh-CN') : '-';
  return (
    <PageContainer>
      <PageHeader>
        <div>
          <PageTitle>个人中心</PageTitle>
          <PageDescription>管理你的账户信息、访问密钥和用量额度。</PageDescription>
        </div>
        <Button icon={<IconEdit />} onClick={() => setEditVisible(true)}>编辑资料</Button>
      </PageHeader>

      <ProfileSurface>
        <Identity>
          <ProfileAvatar size="small">{user.username?.[0]?.toUpperCase() || 'U'}</ProfileAvatar>
          <div>
            <IdentityName>{user.username}</IdentityName>
            <IdentityMeta>{user.email || '未设置邮箱'}</IdentityMeta>
          </div>
        </Identity>
        <AccountFacts>
          <Fact><FactLabel>账户状态</FactLabel><FactValue>正常</FactValue></Fact>
          <Fact><FactLabel>账户级别</FactLabel><FactValue>{user.vipLevel?.toUpperCase() || 'FREE'}</FactValue></Fact>
          <Fact><FactLabel>注册时间</FactLabel><FactValue>{joinDate}</FactValue></Fact>
        </AccountFacts>
      </ProfileSurface>

      <MetricGrid>
        <MetricCard><MetricLabel>可用额度</MetricLabel><MetricValue>¥ {Number(user.balance || 0).toFixed(2)}</MetricValue><MetricHint>可用于工作流运行与 API 调用</MetricHint></MetricCard>
        <MetricCard><MetricLabel>冻结额度</MetricLabel><MetricValue>¥ {Number(user.frozenBalance || 0).toFixed(4)}</MetricValue><MetricHint>运行中的任务会暂时占用额度</MetricHint></MetricCard>
        <MetricCard><MetricLabel>访问密钥</MetricLabel><MetricValue>{apiKeys.length}</MetricValue><MetricHint>请仅为必要的环境创建 Key</MetricHint></MetricCard>
      </MetricGrid>

      <SectionSurface>
        <SectionHeader>
          <div><SectionTitle>API Key</SectionTitle><SectionDescription>创建后仅展示一次明文；撤销会立即使 Key 失效。</SectionDescription></div>
          <Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => setCreateVisible(true)}>创建 Key</Button>
        </SectionHeader>
        <Table
          dataSource={apiKeys}
          pagination={false}
          rowKey="id"
          empty={<Empty description="还没有 API Key" />}
          columns={[
            { title: '名称', dataIndex: 'name', width: 180, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
            { title: 'Key 前缀', dataIndex: 'keyPrefix', render: (value: string) => <KeyPrefix>{value}…</KeyPrefix> },
            { title: '最后使用', dataIndex: 'lastUsedAt', render: (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '从未使用' },
            { title: '创建时间', dataIndex: 'createdAt', render: (value: string) => new Date(value).toLocaleString('zh-CN') },
            {
              title: '操作', width: 110,
              render: (_: unknown, record: ApiKey) => (
                <Popconfirm title="确认撤销此 API Key？" okText="撤销" cancelText="取消" okType="danger" onConfirm={() => void handleRevoke(record.id)}>
                  <Button size="small" type="danger" theme="borderless" icon={<IconDelete />}>撤销</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </SectionSurface>

      <Modal title="编辑个人资料" visible={editVisible} onCancel={() => setEditVisible(false)} footer={null}>
        <ModalIntro>用户名和邮箱用于平台识别与通知；修改后会立即在当前账户生效。</ModalIntro>
        <Form onSubmit={handleUpdateProfile} initValues={{ username: user.username, email: user.email }}>
          <Form.Input field="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]} />
          <Form.Input field="email" label="邮箱" rules={[{ required: true, message: '请输入有效邮箱' }]} />
          <ModalActions><Button onClick={() => setEditVisible(false)}>取消</Button><Button type="primary" theme="solid" htmlType="submit" loading={savingProfile}>保存修改</Button></ModalActions>
        </Form>
      </Modal>

      <Modal title="创建 API Key" visible={createVisible} onCancel={() => setCreateVisible(false)} footer={null}>
        <ModalIntro>为每个用途单独创建 Key，方便后续追踪和撤销。</ModalIntro>
        <Form onSubmit={handleCreateKey}>
          <Form.Input field="name" label="名称" placeholder="例如：生产环境" rules={[{ required: true, message: '请输入 Key 名称' }]} />
          <ModalActions><Button onClick={() => setCreateVisible(false)}>取消</Button><Button type="primary" theme="solid" htmlType="submit" icon={<IconKey />}>创建 Key</Button></ModalActions>
        </Form>
      </Modal>

      <Modal title="请立即保存 API Key" visible={!!newKey} onCancel={() => setNewKey(null)} footer={<Button type="primary" theme="solid" onClick={() => setNewKey(null)}>我已保存</Button>}>
        <ModalIntro>出于安全原因，此 Key 只会展示一次。</ModalIntro>
        <SecretValue><code>{newKey}</code></SecretValue>
        <Button block icon={<IconCopy />} onClick={() => void copyToClipboard(newKey!)}>复制到剪贴板</Button>
      </Modal>
    </PageContainer>
  );
};

const PageContainer = styled.div`
  height: 100%; overflow-y: auto; box-sizing: border-box; padding: 34px 38px 48px;
  @media (max-width: 720px) { height: auto; overflow: visible; padding: 20px 16px 32px; }
`;
const PageHeader = styled.header`
  display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:24px;
  @media (max-width: 520px) { flex-direction:column; gap:12px; margin-bottom:18px; }
`;
const PageTitle = styled.h1`margin:0; color:var(--ff-text); font-size:24px; line-height:32px; letter-spacing:-.45px;`;
const PageDescription = styled.p`margin:6px 0 0; color:var(--ff-muted); font-size:14px;`;
const ProfileSurface = styled.section`
  display:flex; align-items:center; justify-content:space-between; gap:28px; min-height:96px; padding:20px 24px; background:var(--ff-surface); border:1px solid var(--ff-border); border-radius:var(--ff-radius-lg); box-shadow:var(--ff-shadow-sm);
  @media (max-width: 640px) { align-items:flex-start; flex-direction:column; gap:18px; padding:20px; }
`;
const Identity = styled.div`display:flex; align-items:center; gap:12px; min-width:0;`;
const ProfileAvatar = styled(Avatar)`.semi-avatar { background:#e8edff; color:#4054bf; font-weight:700; }`;
const IdentityName = styled.div`color:var(--ff-text); font-size:18px; font-weight:650; line-height:26px;`;
const IdentityMeta = styled.div`margin-top:2px; color:var(--ff-muted); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
const AccountFacts = styled.div`
  display:grid; grid-template-columns:repeat(3, minmax(100px, 1fr)); gap:24px;
  @media (max-width: 640px) { width:100%; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }
`;
const Fact = styled.div`min-width:0;`;
const FactLabel = styled.div`margin-bottom:6px; color:var(--ff-muted); font-size:12px;`;
const FactValue = styled.div`color:var(--ff-text); font-size:14px; font-weight:600;`;
const MetricGrid = styled.div`
  display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:14px; margin:18px 0;
  @media (max-width: 640px) { grid-template-columns:1fr; }
`;
const MetricCard = styled.div`min-height:112px; padding:20px; box-sizing:border-box; border:1px solid var(--ff-border); border-radius:var(--ff-radius); background:var(--ff-surface);`;
const MetricLabel = styled.div`color:var(--ff-muted); font-size:13px;`;
const MetricValue = styled.div`margin:9px 0 5px; color:var(--ff-text); font-size:25px; font-weight:680; letter-spacing:-.5px;`;
const MetricHint = styled.div`color:var(--ff-subtle); font-size:12px; line-height:18px;`;
const SectionSurface = styled.section`padding:22px 24px 10px; border:1px solid var(--ff-border); border-radius:var(--ff-radius-lg); background:var(--ff-surface); box-shadow:var(--ff-shadow-sm);`;
const SectionHeader = styled.div`
  display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:18px;
  @media (max-width: 520px) { flex-direction:column; gap:12px; }
`;
const SectionTitle = styled.h2`margin:0; color:var(--ff-text); font-size:16px; line-height:24px;`;
const SectionDescription = styled.p`margin:4px 0 0; color:var(--ff-muted); font-size:13px;`;
const KeyPrefix = styled.code`padding:4px 8px; border-radius:5px; background:#f1f4fb; color:#4054bf; font-size:12px;`;
const ModalIntro = styled.p`margin:0 0 18px; color:var(--ff-muted); font-size:13px; line-height:20px;`;
const ModalActions = styled.div`display:flex; justify-content:flex-end; gap:8px; margin-top:24px;`;
const SecretValue = styled.div`margin:0 0 12px; padding:14px; overflow:auto; border:1px solid #dfe5f4; border-radius:8px; background:#f7f9fd; color:#223c98; font-size:13px;`;
const Center = styled.div`display:flex; height:100%; align-items:center; justify-content:center;`;
const ErrorState = styled.div`display:grid; justify-items:center; gap:12px;`;
