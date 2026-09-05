import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  SideSheet,
  Spin,
  Table,
  Tag,
  Toast,
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import {
  IconCopy,
  IconDelete,
  IconDownload,
  IconEdit,
  IconKey,
  IconPlus,
  IconUpload,
  IconUser,
} from '@douyinfe/semi-icons';
import './profile.css';
import { fetchProfile, setUser, setToken } from '../../utils/auth';
import { apiJson } from '../../utils/api';
import { GATEWAY_URL } from '../../utils/config';
import { invalidateDatasetCache } from '../../nodes/knowledge/components/dataset-select';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface KnowledgeDataset {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  wordCount: number;
}

interface KnowledgeDocument {
  id: string;
  name: string;
  indexingStatus: string;
  enabled: boolean;
  wordCount: number;
  error: string | null;
}

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [datasets, setDatasets] = useState<KnowledgeDataset[] | null>(null);
  const [createDatasetVisible, setCreateDatasetVisible] = useState(false);
  const [docSheetDataset, setDocSheetDataset] = useState<KnowledgeDataset | null>(null);
  const [datasetDocs, setDatasetDocs] = useState<KnowledgeDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [addingDoc, setAddingDoc] = useState(false);
  const [hitQuery, setHitQuery] = useState('');
  const [hitTesting, setHitTesting] = useState(false);
  const [hitResults, setHitResults] = useState<Array<{ content: string; score: number | null; documentName: string }> | null>(null);
  const [hitError, setHitError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRow[] | null>(null);
  const [createMcpVisible, setCreateMcpVisible] = useState(false);

  const fetchMcpServers = useCallback(async () => {
    setMcpServers(await apiJson<McpServerRow[]>('/mcp/servers'));
  }, []);

  const fetchDatasets = useCallback(async () => {
    setDatasets(await apiJson<KnowledgeDataset[]>('/knowledge/datasets'));
    // 通知画布内知识检索节点的下拉缓存失效。
    invalidateDatasetCache();
  }, []);

  const fetchDatasetDocs = useCallback(async (datasetId: string) => {
    setDocsLoading(true);
    try {
      setDatasetDocs(await apiJson<KnowledgeDocument[]>(`/knowledge/datasets/${datasetId}/documents`));
    } finally {
      setDocsLoading(false);
    }
  }, []);

  // 存在尚未完成索引的文档时自动轮询状态（最多 60 秒），完成后停止。
  useEffect(() => {
    if (!docSheetDataset) return;
    const pending = datasetDocs.some(
      (doc) => doc.indexingStatus !== 'completed' && doc.indexingStatus !== 'error',
    );
    if (!pending) return;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 60_000) {
        window.clearInterval(timer);
        return;
      }
      try {
        const docs = await apiJson<KnowledgeDocument[]>(`/knowledge/datasets/${docSheetDataset.id}/documents`);
        setDatasetDocs(docs);
        if (!docs.some((doc) => doc.indexingStatus !== 'completed' && doc.indexingStatus !== 'error')) {
          window.clearInterval(timer);
        }
      } catch {
        // 轮询失败静默忽略，下一次 tick 重试。
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [docSheetDataset, datasetDocs]);

  const fetchFiles = useCallback(async () => {
    setFiles(await apiJson<StoredFile[]>('/files'));
  }, []);

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
      await Promise.all([
        fetchApiKeys(),
        fetchFiles().catch(() => undefined),
        fetchDatasets().catch(() => undefined),
        fetchMcpServers().catch(() => undefined),
      ]);
    } catch (error: any) {
      setLoadError(error.message || '加载个人中心失败，请确认网关服务已启动');
    } finally {
      setLoading(false);
    }
  }, [fetchApiKeys, fetchDatasets, fetchMcpServers, navigate]);
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

  const handleCreateKey = useCallback(async (values: { name?: string; expiresInDays?: string }) => {
    try {
      const expiresInDays = values.expiresInDays ? Number(values.expiresInDays) : undefined;
      const data = await apiJson<{ plaintext: string; expiresAt?: string }>('/user/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name?.trim() || 'default',
          ...(expiresInDays !== undefined && Number.isInteger(expiresInDays) ? { expiresInDays } : {}),
        }),
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

  const handlePasswordChange = useCallback(async (values: { currentPassword?: string; newPassword?: string }) => {
    setSavingPassword(true);
    try {
      const result = await apiJson<{ accessToken: string; user: any }>('/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword: values.currentPassword || '',
          newPassword: values.newPassword || '',
        }),
      });
      // 后端已自增 token 版本号：旧 token 全部失效，改用签发的新 token 续期当前会话。
      if (result.accessToken) {
        setToken(result.accessToken);
        if (result.user) {
          setUser(result.user);
          setCurrentUser(result.user);
        }
      }
      Toast.success('密码已修改，其他设备已强制下线');
      setPasswordVisible(false);
    } catch (error: any) {
      Toast.error(error.message || '修改密码失败');
    } finally {
      setSavingPassword(false);
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

  const handleFileUpload = useCallback(async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      Toast.error('单个文件不能超过 10 MB');
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      await apiJson('/files/upload', { method: 'POST', body });
      Toast.success('文件已上传');
      await fetchFiles();
    } catch (error: any) {
      Toast.error(error.message || '上传失败');
    } finally {
      setUploading(false);
    }
  }, [fetchFiles]);

  const handleFileDelete = useCallback(async (id: string) => {
    try {
      await apiJson('/files/' + id, { method: 'DELETE' });
      Toast.success('文件已删除');
      await fetchFiles();
    } catch (error: any) {
      Toast.error(error.message || '删除文件失败');
    }
  }, [fetchFiles]);

  const handleCreateDataset = useCallback(async (values: { name?: string; description?: string }) => {
    try {
      await apiJson('/knowledge/datasets', {
        method: 'POST',
        body: JSON.stringify({ name: values.name?.trim() || '', description: values.description?.trim() || '' }),
      });
      Toast.success('知识库已创建');
      setCreateDatasetVisible(false);
      await fetchDatasets();
    } catch (error: any) {
      Toast.error(error.message || '创建知识库失败');
    }
  }, [fetchDatasets]);

  const openDatasetDocs = useCallback(async (dataset: KnowledgeDataset) => {
    setDocSheetDataset(dataset);
    await fetchDatasetDocs(dataset.id);
  }, [fetchDatasetDocs]);

  const handleAddDoc = useCallback(async (values: { name?: string; text?: string }) => {
    if (!docSheetDataset) return;
    setAddingDoc(true);
    try {
      await apiJson(`/knowledge/datasets/${docSheetDataset.id}/documents`, {
        method: 'POST',
        body: JSON.stringify({ name: values.name?.trim() || '未命名文档', text: values.text || '' }),
      });
      Toast.success('文档已提交，索引完成后可被知识检索节点使用');
      await fetchDatasetDocs(docSheetDataset.id);
      await fetchDatasets();
    } catch (error: any) {
      Toast.error(error.message || '添加文档失败');
    } finally {
      setAddingDoc(false);
    }
  }, [docSheetDataset, fetchDatasetDocs, fetchDatasets]);

  const handleDeleteDataset = useCallback(async (id: string) => {
    try {
      await apiJson('/knowledge/datasets/' + id, { method: 'DELETE' });
      Toast.success('知识库已删除');
      if (docSheetDataset?.id === id) setDocSheetDataset(null);
      await fetchDatasets();
    } catch (error: any) {
      Toast.error(error.message || '删除知识库失败');
    }
  }, [docSheetDataset, fetchDatasets]);

  const handleDeleteDoc = useCallback(async (documentId: string) => {
    if (!docSheetDataset) return;
    try {
      await apiJson(`/knowledge/datasets/${docSheetDataset.id}/documents/${documentId}`, { method: 'DELETE' });
      Toast.success('文档已删除');
      await fetchDatasetDocs(docSheetDataset.id);
      await fetchDatasets();
    } catch (error: any) {
      Toast.error(error.message || '删除文档失败');
    }
  }, [docSheetDataset, fetchDatasetDocs, fetchDatasets]);

  const handleCreateMcp = useCallback(async (values: { name?: string; url?: string; token?: string }) => {
    try {
      await apiJson('/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name?.trim() || '',
          url: values.url?.trim() || '',
          token: values.token?.trim() || undefined,
        }),
      });
      Toast.success('MCP 服务器已注册');
      setCreateMcpVisible(false);
      await fetchMcpServers();
    } catch (error: any) {
      Toast.error(error.message || '注册 MCP 服务器失败');
    }
  }, [fetchMcpServers]);

  const handleDeleteMcp = useCallback(async (id: string) => {
    try {
      await apiJson('/mcp/servers/' + id, { method: 'DELETE' });
      Toast.success('MCP 服务器已删除');
      await fetchMcpServers();
    } catch (error: any) {
      Toast.error(error.message || '删除 MCP 服务器失败');
    }
  }, [fetchMcpServers]);

  const testMcpConnection = useCallback(async (row: McpServerRow) => {
    Toast.info(`正在测试 ${row.name} …`);
    try {
      const tools = await apiJson<Array<{ name: string }>>(`/mcp/servers/${row.id}/tools`, { method: 'POST' });
      Toast.success(`连接成功，发现 ${tools.length} 个工具`);
    } catch (error: any) {
      Toast.error(error.message || '连接失败');
    }
  }, []);

  const runHitTest = useCallback(async () => {
    if (!docSheetDataset || !hitQuery.trim()) return;
    setHitTesting(true);
    setHitError(null);
    try {
      const results = await apiJson<Array<{ content: string; score: number | null; documentName: string }>>(
        `/knowledge/datasets/${docSheetDataset.id}/hit-test`,
        { method: 'POST', body: JSON.stringify({ query: hitQuery.trim(), topK: 4 }) },
      );
      setHitResults(results);
      if (results.length === 0) Toast.info('没有命中的内容片段');
    } catch (error: any) {
      setHitError(error.message || '试检索失败');
    } finally {
      setHitTesting(false);
    }
  }, [docSheetDataset, hitQuery]);

  const fileUrl = (id: string) => GATEWAY_URL.replace(/\/+$/, '') + '/files/' + id + '/download';

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
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
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <Button onClick={() => setPasswordVisible(true)}>修改密码</Button>
          <Button icon={<IconEdit />} onClick={() => setEditVisible(true)}>
            编辑资料
          </Button>
        </div>
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
            <h2>API 密钥</h2>
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
              title: '有效期',
              dataIndex: 'expiresAt',
              width: 130,
              render: (value: string | null) => {
                if (!value) return '永久';
                const expired = new Date(value).getTime() <= Date.now();
                const days = Math.ceil((new Date(value).getTime() - Date.now()) / 24 / 60 / 60_000);
                return (
                  <Tag size="small" color={expired ? 'red' : days <= 7 ? 'orange' : 'green'}>
                    {expired ? '已过期' : `${days} 天后到期`}
                  </Tag>
                );
              },
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

      <section className="profile-section">
        <div className="profile-section-header">
          <div>
            <h2>文件管理</h2>
            <p>上传文档或图片获得可引用的下载链接（单文件 10 MB 以内）。</p>
          </div>
          <label className="profile-upload-button">
            <input
              type="file"
              style={{ display: 'none' }}
              onChange={(event) => {
                void handleFileUpload(event.target.files);
                event.currentTarget.value = '';
              }}
            />
            <Button type="primary" theme="solid" icon={<IconUpload />} loading={uploading}>
              上传文件
            </Button>
          </label>
        </div>
        <Table
          dataSource={files}
          pagination={files.length > 8 ? { pageSize: 8 } : false}
          rowKey="id"
          empty={<Empty description="还没有上传过文件" />}
          columns={[
            {
              title: '文件名',
              dataIndex: 'originalName',
              width: 260,
              render: (value: string) => <Typography.Text strong ellipsis={{ showTooltip: true }}>{value}</Typography.Text>,
            },
            {
              title: '大小',
              dataIndex: 'sizeBytes',
              width: 90,
              render: (value: number) => formatSize(value),
            },
            {
              title: '上传时间',
              dataIndex: 'createdAt',
              width: 170,
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '操作',
              width: 120,
              align: 'right' as const,
              render: (_: unknown, record: StoredFile) => (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <Tooltip content="复制下载链接">
                    <Button
                      size="small"
                      theme="borderless"
                      icon={<IconCopy />}
                      aria-label={'复制 ' + record.originalName + ' 链接'}
                      onClick={() => void copyToClipboard(fileUrl(record.id))}
                    />
                  </Tooltip>
                  <Tooltip content="下载">
                    <Button
                      size="small"
                      theme="borderless"
                      icon={<IconDownload />}
                      aria-label={'下载 ' + record.originalName}
                      onClick={() => window.open(fileUrl(record.id), '_blank', 'noopener')}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认删除此文件？"
                    okText="删除"
                    cancelText="取消"
                    okType="danger"
                    onConfirm={() => void handleFileDelete(record.id)}
                  >
                    <Tooltip content="删除文件">
                      <Button
                        size="small"
                        type="danger"
                        theme="borderless"
                        icon={<IconDelete />}
                        aria-label={'删除 ' + record.originalName}
                      />
                    </Tooltip>
                  </Popconfirm>
                </div>
              ),
            },
          ]}
        />
      </section>

      <section className="profile-section">
        <div className="profile-section-header">
          <div>
            <h2>知识库</h2>
            <p>供画布「知识检索」节点使用的私有知识库，创建后即可在画布中选择。</p>
          </div>
          <Button icon={<IconPlus />} onClick={() => setCreateDatasetVisible(true)}>
            创建知识库
          </Button>
        </div>
        <Table
          dataSource={datasets || []}
          loading={datasets === null}
          pagination={false}
          rowKey="id"
          empty={<Empty description="还没有知识库" />}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
            },
            {
              title: '描述',
              dataIndex: 'description',
              ellipsis: true,
              render: (value: string) => value || '-',
            },
            {
              title: '文档数',
              dataIndex: 'documentCount',
              width: 90,
            },
            {
              title: '操作',
              width: 150,
              align: 'right' as const,
              render: (_: unknown, record: KnowledgeDataset) => (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => void openDatasetDocs(record)}
                  >
                    管理文档
                  </Button>
                  <Popconfirm
                    title="删除知识库将同时删除其中全部文档，确认？"
                    okText="删除"
                    cancelText="取消"
                    okType="danger"
                    onConfirm={() => void handleDeleteDataset(record.id)}
                  >
                    <Tooltip content="删除知识库">
                      <Button
                        size="small"
                        type="danger"
                        theme="borderless"
                        icon={<IconDelete />}
                        aria-label={'删除 ' + record.name}
                      />
                    </Tooltip>
                  </Popconfirm>
                </div>
              ),
            },
          ]}
        />
      </section>

      <section className="profile-section">
        <div className="profile-section-header">
          <div>
            <h2>MCP 服务器</h2>
            <p>注册 streamable HTTP 方式的 MCP 服务器，供画布「MCP 工具」节点调用；Bearer 令牌加密保存。</p>
          </div>
          <Button icon={<IconPlus />} onClick={() => setCreateMcpVisible(true)}>
            注册服务器
          </Button>
        </div>
        <Table
          dataSource={mcpServers || []}
          loading={mcpServers === null}
          pagination={false}
          rowKey="id"
          empty={<Empty description="还没有注册 MCP 服务器" />}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
            },
            {
              title: '地址',
              dataIndex: 'url',
              ellipsis: true,
              render: (value: string) => <Typography.Text copyable={{ content: value }}>{value}</Typography.Text>,
            },
            {
              title: '令牌',
              dataIndex: 'hasToken',
              width: 90,
              render: (value: boolean) => <Tag size="small" color={value ? 'green' : 'grey'}>{value ? '已配置' : '无'}</Tag>,
            },
            {
              title: '操作',
              width: 150,
              align: 'right' as const,
              render: (_: unknown, record: McpServerRow) => (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => void testMcpConnection(record)}
                  >
                    测试连接
                  </Button>
                  <Popconfirm
                    title="确认删除此 MCP 服务器？"
                    okText="删除"
                    cancelText="取消"
                    okType="danger"
                    onConfirm={() => void handleDeleteMcp(record.id)}
                  >
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      aria-label={'删除 ' + record.name}
                    />
                  </Popconfirm>
                </div>
              ),
            },
          ]}
        />
      </section>

      <SideSheet
        title={docSheetDataset ? `文档管理 · ${docSheetDataset.name}` : '文档管理'}
        visible={Boolean(docSheetDataset)}
        onCancel={() => setDocSheetDataset(null)}
        width={Math.min(560, typeof window !== 'undefined' ? window.innerWidth - 24 : 560)}
        footer={null}
      >
        {docSheetDataset && (
          <>
            <Form onSubmit={handleAddDoc} initValues={{ name: '' }} key={docSheetDataset.id}>
              <Form.Input
                field="name"
                label="文档名称"
                placeholder="例如：产品说明"
                rules={[{ required: true, message: '请输入文档名称' }]}
              />
              <Form.TextArea
                field="text"
                label="文档内容"
                placeholder="粘贴要被检索的文本内容"
                rows={5}
                rules={[{ required: true, message: '请输入文档内容' }]}
              />
              <Button
                type="primary"
                theme="solid"
                htmlType="submit"
                loading={addingDoc}
                style={{ marginTop: 8 }}
              >
                添加文档
              </Button>
            </Form>
            <div style={{ margin: '20px 0 8px' }}>
              <Typography.Title heading={6} style={{ marginTop: 0 }}>文档列表</Typography.Title>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <Input
                placeholder="试检索：输入查询验证召回效果"
                value={hitQuery}
                showClear
                onChange={(value: string) => { setHitQuery(value); setHitResults(null); }}
                onEnterPress={() => void runHitTest()}
              />
              <Button
                theme="solid"
                loading={hitTesting}
                disabled={!hitQuery.trim()}
                onClick={() => void runHitTest()}
              >
                试检索
              </Button>
            </div>
            {hitError && (
              <Typography.Text type="danger" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
                {hitError}
              </Typography.Text>
            )}
            {hitResults && (
              <div style={{ marginBottom: 12 }}>
                {hitResults.length === 0 ? (
                  <Typography.Text type="tertiary" style={{ fontSize: 12 }}>没有命中的内容片段。</Typography.Text>
                ) : hitResults.map((item, index) => (
                  <div
                    key={index}
                    style={{
                      padding: '8px 10px',
                      marginBottom: 6,
                      border: '1px solid var(--ff-border)',
                      borderRadius: 8,
                      background: 'var(--ff-surface-muted)',
                      fontSize: 12,
                      lineHeight: '18px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {item.documentName && (
                      <div style={{ color: 'var(--ff-primary)', fontWeight: 600, marginBottom: 2 }}>
                        {item.documentName}{item.score !== null ? ` · 相关度 ${(item.score * 100).toFixed(0)}%` : ''}
                      </div>
                    )}
                    {item.content}
                  </div>
                ))}
              </div>
            )}
            <div style={{ margin: '20px 0 8px' }}>
              <Typography.Title heading={6} style={{ marginTop: 0 }}>文档列表</Typography.Title>
            </div>
            {docsLoading ? (
              <div className="profile-state"><Spin size="small" /></div>
            ) : (
              <Table
                dataSource={datasetDocs}
                pagination={datasetDocs.length > 8 ? { pageSize: 8 } : false}
                rowKey="id"
                empty={<Empty description="还没有文档" />}
                columns={[
                  {
                    title: '文档名',
                    dataIndex: 'name',
                    ellipsis: true,
                  },
                  {
                    title: '索引状态',
                    dataIndex: 'indexingStatus',
                    width: 110,
                    render: (value: string) => (
                      <Tag size="small" color={value === 'completed' ? 'green' : value === 'error' ? 'red' : 'blue'}>
                        {value === 'completed' ? '已完成' : value === 'error' ? '失败' : value || '排队中'}
                      </Tag>
                    ),
                  },
                  {
                    title: '操作',
                    width: 72,
                    align: 'right' as const,
                    render: (_: unknown, record: KnowledgeDocument) => (
                      <Popconfirm
                        title="确认删除此文档？"
                        okText="删除"
                        cancelText="取消"
                        okType="danger"
                        onConfirm={() => void handleDeleteDoc(record.id)}
                      >
                        <Button
                          size="small"
                          type="danger"
                          theme="borderless"
                          icon={<IconDelete />}
                          aria-label={'删除 ' + record.name}
                        />
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
      </SideSheet>

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
          <Form.Select
            field="expiresInDays"
            label="有效期"
            placeholder="永久（可选设置过期）"
            optionList={[
              { label: '永久', value: '' },
              { label: '30 天', value: '30' },
              { label: '90 天', value: '90' },
              { label: '180 天', value: '180' },
              { label: '365 天', value: '365' },
            ]}
            style={{ width: '100%' }}
          />
          <div className="modal-actions">
            <Button onClick={() => setCreateVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit" icon={<IconKey />}>
              创建 Key
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal title="注册 MCP 服务器" visible={createMcpVisible} onCancel={() => setCreateMcpVisible(false)} footer={null}>
        <p className="modal-copy">地址需为 streamable HTTP 方式的 MCP 端点（HTTP/S）。Bearer 令牌可选，加密保存后不再回显。</p>
        <Form onSubmit={handleCreateMcp}>
          <Form.Input
            field="name"
            label="名称"
            placeholder="例如：文档检索 MCP"
            rules={[{ required: true, message: '请输入名称' }]}
          />
          <Form.Input
            field="url"
            label="端点地址"
            placeholder="http://host:port/mcp"
            rules={[{ required: true, message: '请输入端点地址' }]}
          />
          <Form.Input
            field="token"
            label="Bearer 令牌"
            placeholder="可选；服务器需要认证时填写"
          />
          <div className="modal-actions">
            <Button onClick={() => setCreateMcpVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit">
              注册
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal title="修改密码" visible={passwordVisible} onCancel={() => setPasswordVisible(false)} footer={null}>
        <p className="modal-copy">修改后请在新会话中使用新密码登录（当前会话保持有效）。</p>
        <Form onSubmit={handlePasswordChange}>
          <Form.Input
            field="currentPassword"
            label="当前密码"
            mode="password"
            rules={[{ required: true, message: '请输入当前密码' }]}
          />
          <Form.Input
            field="newPassword"
            label="新密码"
            mode="password"
            placeholder="至少 8 个字符"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '新密码至少 8 个字符' },
            ]}
          />
          <div className="modal-actions">
            <Button onClick={() => setPasswordVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit" loading={savingPassword}>
              修改密码
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal title="创建知识库" visible={createDatasetVisible} onCancel={() => setCreateDatasetVisible(false)} footer={null}>
        <p className="modal-copy">创建后即可在画布「知识检索」节点中选择。</p>
        <Form onSubmit={handleCreateDataset}>
          <Form.Input
            field="name"
            label="名称"
            placeholder="例如：产品文档库"
            rules={[{ required: true, message: '请输入知识库名称' }]}
          />
          <Form.Input
            field="description"
            label="描述"
            placeholder="可选"
          />
          <div className="modal-actions">
            <Button onClick={() => setCreateDatasetVisible(false)}>取消</Button>
            <Button type="primary" theme="solid" htmlType="submit">
              创建
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
