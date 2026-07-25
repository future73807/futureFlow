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
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import {
  IconCopy,
  IconDelete,
  IconEdit,
  IconKey,
  IconPlus,
  IconUser,
} from '@douyinfe/semi-icons';
import './profile.css';
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
    setLoading(true);
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

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

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
        body: JSON.stringify({
          username: values.username?.trim(),
          email: values.email?.trim(),
        }),
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
      await apiJson('/user/api-keys/' + id, { method: 'DELETE' });
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

  if (loading) {
    return <div className="profile-state"><Spin size="large" /></div>;
  }

  if (!user) {
    return (
      <div className="profile-state">
        <div className="profile-empty">
          <Empty title="加载失败" description={loadError || '无法读取个人信息'} />
          <Button onClick={() => void loadPage()}>重新加载</Button>
        </div>
      </div>
    );
  }

  const joinDate = user.createdAt ? new Date(user.createdAt).toLocaleDateString('zh-CN') : '-';
  const usedKeyCount = apiKeys.filter((key) => key.lastUsedAt).length;

  return (
    <main className="profile-page">
      <header className="profile-page-header">
        <div>
          <div className="page-eyebrow">账户设置</div>
          <h1>个人中心</h1>
          <p>管理账户资料、访问密钥和工作流额度。</p>
        </div>
        <Button icon={<IconEdit />} onClick={() => setEditVisible(true)}>
          编辑资料
        </Button>
      </header>

      <section className="profile-identity">
        <div className="profile-identity-main">
          <Avatar className="profile-avatar" size="small">
            {user.username?.[0]?.toUpperCase() || 'U'}
          </Avatar>
          <div className="profile-identity-copy">
            <strong>{user.username}</strong>
            <span>{user.email || '未设置邮箱'}</span>
          </div>
        </div>
        <dl className="profile-facts">
          <div>
            <dt>账户状态</dt>
            <dd>正常</dd>
          </div>
          <div>
            <dt>账户级别</dt>
            <dd>{user.vipLevel?.toUpperCase() || 'FREE'}</dd>
          </div>
          <div>
            <dt>注册时间</dt>
            <dd>{joinDate}</dd>
          </div>
        </dl>
      </section>

      <section className="profile-metrics" aria-label="账户指标">
        <div className="profile-metric">
          <span>可用额度</span>
          <strong>¥ {Number(user.balance || 0).toFixed(2)}</strong>
          <small>可用于工作流运行与 API 调用</small>
        </div>
        <div className="profile-metric">
          <span>冻结额度</span>
          <strong>¥ {Number(user.frozenBalance || 0).toFixed(4)}</strong>
          <small>运行中的任务会暂时占用额度</small>
        </div>
        <div className="profile-metric">
          <span>访问密钥</span>
          <strong>{apiKeys.length}</strong>
          <small>{usedKeyCount ? usedKeyCount + ' 个密钥已有调用记录' : '请只为必要环境创建 Key'}</small>
        </div>
      </section>

      <section className="profile-section">
        <div className="profile-section-header">
          <div>
            <h2>API Key</h2>
            <p>每个环境使用独立 Key。明文仅在创建后显示一次。</p>
          </div>
          <Button type="primary" theme="solid" icon={<IconPlus />} onClick={() => setCreateVisible(true)}>
            创建 Key
          </Button>
        </div>
        <Table
          dataSource={apiKeys}
          pagination={false}
          rowKey="id"
          empty={<Empty description="还没有 API Key" />}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              width: 180,
              render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
            },
            {
              title: 'Key 前缀',
              dataIndex: 'keyPrefix',
              render: (value: string) => <code className="profile-key-prefix">{value}...</code>,
            },
            {
              title: '最后使用',
              dataIndex: 'lastUsedAt',
              render: (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '从未使用',
            },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '操作',
              width: 72,
              align: 'right' as const,
              render: (_: unknown, record: ApiKey) => (
                <Popconfirm
                  title="确认撤销此 API Key？"
                  okText="撤销"
                  cancelText="取消"
                  okType="danger"
                  onConfirm={() => void handleRevoke(record.id)}
                >
                  <Tooltip content="撤销 Key">
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      aria-label={'撤销 ' + record.name}
                    />
                  </Tooltip>
                </Popconfirm>
              ),
            },
          ]}
        />
      </section>

      <Modal title="编辑个人资料" visible={editVisible} onCancel={() => setEditVisible(false)} footer={null}>
        <p className="modal-copy">修改后会立即更新当前账户和左侧个人中心。</p>
        <Form onSubmit={handleUpdateProfile} initValues={{ username: user.username, email: user.email }}>
          <Form.Input
            field="username"
            label="用户名"
            prefix={<IconUser />}
            rules={[{ required: true, message: '请输入用户名' }]}
          />
          <Form.Input
            field="email"
            label="邮箱"
            rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
          />
          <div className="modal-actions">
            <Button onClick={() => setEditVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit" loading={savingProfile}>
              保存修改
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal title="创建 API Key" visible={createVisible} onCancel={() => setCreateVisible(false)} footer={null}>
        <p className="modal-copy">为每个用途单独创建 Key，便于后续追踪和撤销。</p>
        <Form onSubmit={handleCreateKey}>
          <Form.Input
            field="name"
            label="名称"
            prefix={<IconKey />}
            placeholder="例如：生产环境"
            rules={[{ required: true, message: '请输入 Key 名称' }]}
          />
          <div className="modal-actions">
            <Button onClick={() => setCreateVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit" icon={<IconKey />}>
              创建 Key
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal
        title="请立即保存 API Key"
        visible={!!newKey}
        onCancel={() => setNewKey(null)}
        footer={<Button type="primary" theme="solid" onClick={() => setNewKey(null)}>我已保存</Button>}
      >
        <p className="modal-copy">出于安全原因，此 Key 只会展示一次。</p>
        <div className="profile-secret"><code>{newKey}</code></div>
        <Button block icon={<IconCopy />} onClick={() => void copyToClipboard(newKey || '')}>
          复制到剪贴板
        </Button>
      </Modal>
    </main>
  );
};
