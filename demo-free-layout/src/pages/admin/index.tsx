/**
 * futureFlow 管理员后台
 * 仪表盘 + 用户管理 + API Key + 工作流 + 运行记录 + 余额流水
 */

import './admin.css';

import { useState, useEffect, useCallback } from 'react';
import {
  Table,
  Tag,
  Button,
  Tabs,
  TabPane,
  Card,
  Spin,
  Toast,
  Modal,
  Popconfirm,
  Empty,
  Select,
  Input,
  InputNumber,
} from '@douyinfe/semi-ui';
import {
  IconUser,
  IconKey,
  IconBranch,
  IconActivity,
  IconList,
} from '@douyinfe/semi-icons';
import styled from 'styled-components';
import {
  getStats,
  listUsers,
  adjustBalance,
  updateVipLevel,
  updateUserStatus,
  listApiKeys,
  revokeApiKey,
  listWorkflows,
  listRuns,
  listBalanceLogs,
} from './api';
import { getUser } from '../../utils/auth';

type Stats = any;
type UserRow = any;
type ApiKeyRow = any;
type WorkflowRow = any;
type RunRow = any;
type BalanceLogRow = any;

/** 详情弹窗的一行：标签 + 完整值（值可以是任意 React 节点） */
type DetailField = { label: string; value: React.ReactNode };

/** 表格时间统一 YYYY-MM-DD HH:mm：去掉秒，紧凑且等宽对齐，时间列不会被挤成多行 */
function formatTime(value: unknown, fallback = '-'): string {
  if (!value) return fallback;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return fallback;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 时间单元格：始终渲染成单个 span，由全局表格 nowrap 规则保证一行显示 */
function TimeCell({ value, fallback }: { value: unknown; fallback?: string }) {
  return <span className="admin-time">{formatTime(value, fallback)}</span>;
}

/** 统一的「查看」弹窗：完整展示整行字段，表格里被截断的内容在这里看全 */
function RowDetail({
  title,
  fields,
  visible,
  onClose,
}: {
  title: string;
  fields: DetailField[];
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal title={title} visible={visible} onCancel={onClose} footer={null} width={560}>
      <div className="admin-detail">
        {fields.map((f, i) => (
          <div className="admin-detail-row" key={`${f.label}-${i}`}>
            <div className="admin-detail-label">{f.label}</div>
            <div className="admin-detail-value">{f.value ?? '-'}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 查看弹窗状态：五个列表复用同一套开关逻辑 */
function useRowDetail() {
  const [detail, setDetail] = useState<{ title: string; fields: DetailField[] } | null>(null);
  const showDetail = useCallback(
    (title: string, fields: DetailField[]) => setDetail({ title, fields }),
    [],
  );
  const detailNode = (
    <RowDetail
      title={detail?.title || ''}
      fields={detail?.fields || []}
      visible={!!detail}
      onClose={() => setDetail(null)}
    />
  );
  return { showDetail, detailNode };
}

/* ---- 各表详情字段：全部使用完整值，不在弹窗里做截断 ---- */

const USER_STATUS_TEXT: Record<string, string> = {
  active: '正常',
  suspended: '暂停',
  banned: '封禁',
};

const RUN_STATUS_TEXT: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const BALANCE_TYPE_TEXT: Record<string, string> = {
  freeze: '冻结',
  deduct: '扣费',
  unfreeze: '解冻',
  refund: '退款',
  recharge: '充值',
};

const userDetailFields = (r: UserRow): DetailField[] => [
  { label: '用户 ID', value: <span className="cell-mono">{r.id || '-'}</span> },
  { label: '用户名', value: r.username || '-' },
  { label: '邮箱', value: r.email || '-' },
  { label: '角色', value: r.role === 'admin' ? '管理员' : '普通用户' },
  { label: '会员等级', value: (r.vipLevel || 'free').toUpperCase() },
  { label: '账号状态', value: USER_STATUS_TEXT[r.status] || r.status || '-' },
  { label: '余额', value: `¥${Number(r.balance || 0).toFixed(2)}` },
  { label: '冻结余额', value: `¥${Number(r.frozenBalance || 0).toFixed(2)}` },
  { label: '注册时间', value: formatTime(r.createdAt) },
  { label: '更新时间', value: formatTime(r.updatedAt) },
];

const apiKeyDetailFields = (r: ApiKeyRow): DetailField[] => [
  { label: 'Key ID', value: <span className="cell-mono">{r.id || '-'}</span> },
  { label: '名称', value: r.name || '-' },
  { label: 'Key 前缀', value: <span className="cell-mono">{r.keyPrefix || '-'}</span> },
  { label: '所属用户', value: r.username || '-' },
  { label: '用户 ID', value: <span className="cell-mono">{r.userId || '-'}</span> },
  { label: '状态', value: r.revoked ? '已吊销' : '正常' },
  { label: '最后使用', value: formatTime(r.lastUsedAt, '从未使用') },
  { label: '过期时间', value: r.expiresAt ? formatTime(r.expiresAt) : '永不过期' },
  { label: '创建时间', value: formatTime(r.createdAt) },
];

const workflowDetailFields = (r: WorkflowRow): DetailField[] => [
  { label: '工作流 ID', value: <span className="cell-mono">{r.id || '-'}</span> },
  { label: '名称', value: r.name || '-' },
  { label: '描述', value: r.description || '暂无描述' },
  { label: '所属用户', value: r.username || '-' },
  { label: '用户 ID', value: <span className="cell-mono">{r.userId || '-'}</span> },
  { label: '版本', value: `v${r.version ?? 1}` },
  { label: '状态', value: r.status || '-' },
  { label: '创建时间', value: formatTime(r.createdAt) },
  { label: '更新时间', value: formatTime(r.updatedAt) },
];

const runDetailFields = (r: RunRow): DetailField[] => [
  { label: '运行 ID', value: <span className="cell-mono">{r.id || '-'}</span> },
  { label: '状态', value: RUN_STATUS_TEXT[r.status] || r.status || '-' },
  { label: '用户', value: r.username || '-' },
  { label: '用户 ID', value: <span className="cell-mono">{r.userId || '-'}</span> },
  { label: '来源', value: r.source || '-' },
  { label: 'Token 消耗', value: Number(r.totalTokens || 0).toLocaleString() },
  { label: '执行步数', value: String(r.totalSteps ?? 0) },
  { label: '预估费用', value: `¥${Number(r.estimatedCost || 0).toFixed(4)}` },
  { label: '实际费用', value: `¥${Number(r.actualCost || 0).toFixed(4)}` },
  { label: '耗时', value: `${Number(r.elapsedTime || 0).toFixed(2)}s` },
  { label: '错误信息', value: r.errorMessage || '-' },
  { label: '创建时间', value: formatTime(r.createdAt) },
];

const balanceLogDetailFields = (r: BalanceLogRow): DetailField[] => [
  { label: '流水 ID', value: <span className="cell-mono">{r.id || '-'}</span> },
  { label: '类型', value: BALANCE_TYPE_TEXT[r.type] || r.type || '-' },
  { label: '用户', value: r.username || '-' },
  { label: '用户 ID', value: <span className="cell-mono">{r.userId || '-'}</span> },
  {
    label: '金额',
    value: `${Number(r.amount || 0) >= 0 ? '+' : ''}${Number(r.amount || 0).toFixed(4)}`,
  },
  { label: '变动后余额', value: `¥${Number(r.balanceAfter || 0).toFixed(4)}` },
  { label: '备注', value: r.remark || '-' },
  { label: '关联运行 ID', value: <span className="cell-mono">{r.workflowRunId || '-'}</span> },
  { label: '时间', value: formatTime(r.createdAt) },
];

/** 每一行都有的查看按钮：打开完整字段弹窗 */
const ViewButton = ({ onClick }: { onClick: () => void }) => (
  <Button size="small" onClick={onClick}>
    查看
  </Button>
);

export const AdminPage = () => {
  const me = getUser();
  const [tab, setTab] = useState('dashboard');
  const [loading, setLoading] = useState(false);

  // 各列表数据
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<{ items: UserRow[]; total: number }>({ items: [], total: 0 });
  const [apiKeys, setApiKeys] = useState<{ items: ApiKeyRow[]; total: number }>({ items: [], total: 0 });
  const [workflows, setWorkflows] = useState<{ items: WorkflowRow[]; total: number }>({ items: [], total: 0 });
  const [runs, setRuns] = useState<{ items: RunRow[]; total: number }>({ items: [], total: 0 });
  const [logs, setLogs] = useState<{ items: BalanceLogRow[]; total: number }>({ items: [], total: 0 });

  // 分页
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [userSearch, setUserSearch] = useState('');
  const [runSource, setRunSource] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const s = await getStats();
      setStats(s);
    } catch (e: any) {
      Toast.error(e.message || '加载统计失败');
    }
  }, []);

  const loadTab = useCallback(
    async (key: string, p = 1) => {
      setLoading(true);
      try {
        if (key === 'dashboard') {
          await loadStats();
        } else if (key === 'users') {
          const data = await listUsers(p, pageSize, userSearch);
          setUsers(data);
        } else if (key === 'apikeys') {
          const data = await listApiKeys(p, pageSize);
          setApiKeys(data);
        } else if (key === 'workflows') {
          const data = await listWorkflows(p, pageSize);
          setWorkflows(data);
        } else if (key === 'runs') {
          const data = await listRuns(p, pageSize, runSource);
          setRuns(data);
        } else if (key === 'logs') {
          const data = await listBalanceLogs(p, 50);
          setLogs(data);
        }
      } catch (e: any) {
        Toast.error(e.message || '加载数据失败');
      } finally {
        setLoading(false);
      }
    },
    [loadStats, userSearch, runSource],
  );

  useEffect(() => {
    loadTab(tab, 1);
  }, [loadTab, tab]);

  const handlePageChange = (p: number) => {
    setPage(p);
    loadTab(tab, p);
  };

  const refresh = () => loadTab(tab, page);

  return (
    <div className="admin-page">
      <header className="page-head">
        <h1>管理员后台</h1>
        <p className="page-sub">
          欢迎，{me?.username}。你可以在这里管理系统用户、API Key、工作流和余额流水。
        </p>
        <div className="page-actions">
          <Button size="small" onClick={refresh} loading={loading}>
            刷新
          </Button>
        </div>
      </header>

      <Tabs
        type="line"
        activeKey={tab}
        onChange={(k) => {
          setTab(k);
          setPage(1);
        }}
      >
        <TabPane tab={<TabIcon icon={<IconActivity />} text="仪表盘" />} itemKey="dashboard">
          <DashboardView stats={stats} loading={loading} />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconUser />} text="用户管理" />} itemKey="users">
          <div className="list-toolbar">
            <div className="toolbar-filters">
              <Input
                placeholder="搜索用户名或邮箱"
                value={userSearch}
                showClear
                style={{ width: 280 }}
                onChange={(value: string) => setUserSearch(value)}
                onEnterPress={() => {
                  setPage(1);
                  loadTab('users', 1);
                }}
              />
            </div>
          </div>
          <UsersView
            data={users}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            refresh={refresh}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconKey />} text="API Key" />} itemKey="apikeys">
          <ApiKeysView
            data={apiKeys}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            refresh={refresh}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconBranch />} text="工作流" />} itemKey="workflows">
          <WorkflowsView
            data={workflows}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconActivity />} text="运行记录" />} itemKey="runs">
          <div className="list-toolbar">
            <div className="toolbar-filters">
            <Select
              value={runSource || 'all'}
              style={{ width: 200 }}
              onChange={(value) => {
                setRunSource(value === 'all' ? '' : String(value));
                setPage(1);
                loadTab('runs', 1);
              }}
              optionList={[
                { label: '全部来源', value: 'all' },
                { label: 'API 调用', value: 'api' },
                { label: '云端试运行', value: 'draft-run' },
                { label: 'Webhook', value: 'webhook' },
                { label: '定时调度', value: 'schedule' },
              ]}
            />
            </div>
          </div>
          <RunsView
            data={runs}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconList />} text="余额流水" />} itemKey="logs">
          <LogsView
            data={logs}
            loading={loading}
            page={page}
            pageSize={50}
            onPageChange={handlePageChange}
          />
        </TabPane>
      </Tabs>
    </div>
  );
};

/* ============ 仪表盘 ============ */

const DashboardView = ({ stats, loading }: { stats: Stats | null; loading: boolean }) => {
  if (loading && !stats) {
    return (
      <Center>
        <Spin size="large" />
      </Center>
    );
  }
  if (!stats) return <Empty description="暂无数据" />;

  return (
    <div>
      <StatsGrid>
        <StatCard>
          <StatLabel>注册用户</StatLabel>
          <StatValue>{stats.userCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>有效 API Key</StatLabel>
          <StatValue>{stats.apiKeyCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>工作流</StatLabel>
          <StatValue>{stats.workflowCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>运行总次数</StatLabel>
          <StatValue>{stats.runCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>知识库</StatLabel>
          <StatValue>{stats.datasetCount ?? 0}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>上传文件</StatLabel>
          <StatValue>{stats.fileCount ?? 0}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Token 消耗</StatLabel>
          <StatValue>{stats.totalTokens.toLocaleString()}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>总费用（元）</StatLabel>
          <StatValue>¥ {stats.totalCost.toFixed(4)}</StatValue>
        </StatCard>
      </StatsGrid>

      <Card title="最近 7 天运行趋势" style={{ marginTop: 16, borderRadius: 8, borderColor: 'var(--ff-border)', boxShadow: 'var(--ff-shadow-sm)' }}>
        {stats.recentRuns && stats.recentRuns.length > 0 ? (
          <TrendChart data={stats.recentRuns} />
        ) : (
          <Empty description="最近 7 天暂无运行记录" />
        )}
      </Card>
    </div>
  );
};

const TrendChart = ({ data }: { data: { date: string; count: number; tokens: number }[] }) => {
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  return (
    <ChartWrap>
      {data.map((d) => (
        <Bar
          key={d.date}
          title={`${d.date} · ${d.count} 次运行 · ${Number(d.tokens || 0).toLocaleString()} tokens`}
        >
          <BarFill style={{ height: `${(d.count / maxCount) * 100}%` }} />
          {/* 后端返回 ISO 时间戳，横轴只保留 MM-DD */}
          <BarLabel>{d.date.slice(5, 10)}</BarLabel>
          <BarCount>{d.count}</BarCount>
        </Bar>
      ))}
    </ChartWrap>
  );
};

/* ============ 用户管理 ============ */

const UsersView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
  refresh,
}: {
  data: { items: UserRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  refresh: () => void;
}) => {
  const [adjustModal, setAdjustModal] = useState<{ user: UserRow; visible: boolean }>({
    user: null,
    visible: false,
  });
  const [adjustValues, setAdjustValues] = useState<{
    delta: number;
    vipLevel: string;
    status: string;
  }>({ delta: 0, vipLevel: 'free', status: 'active' });
  const [adjustSaving, setAdjustSaving] = useState(false);
  const { showDetail, detailNode } = useRowDetail();

  const openAdjust = (r: UserRow) => {
    setAdjustValues({ delta: 0, vipLevel: r.vipLevel || 'free', status: r.status || 'active' });
    setAdjustModal({ user: r, visible: true });
  };

  const closeAdjust = () => setAdjustModal({ user: null, visible: false });

  const handleSaveBalance = async () => {
    if (!adjustModal.user) return;
    try {
      await adjustBalance(adjustModal.user.id, Number(adjustValues.delta || 0), '管理员手动调整');
      Toast.success('余额已保存');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '保存余额失败');
    }
  };

  const handleSaveAll = async () => {
    const user = adjustModal.user;
    if (!user) return;
    setAdjustSaving(true);
    try {
      // 余额、等级、状态各有独立接口，按顺序提交；任一失败即中止，避免只改一半还提示成功
      await adjustBalance(user.id, Number(adjustValues.delta || 0), '管理员手动调整');
      await updateVipLevel(user.id, adjustValues.vipLevel);
      await updateUserStatus(user.id, adjustValues.status);
      Toast.success('用户信息已更新');
      closeAdjust();
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '保存失败');
    } finally {
      setAdjustSaving(false);
    }
  };

  // 列宽：内容列用百分比自适应分摊整表宽度，只有「操作」列固定宽度
  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      width: '16%',
      render: (t: string, r: UserRow) => (
        <span>
          {t} {r.role === 'admin' && <Tag size="small" color="orange">管理员</Tag>}
        </span>
      ),
    },
    { title: '邮箱', dataIndex: 'email', width: '22%' },
    {
      title: 'VIP',
      dataIndex: 'vipLevel',
      width: '10%',
      render: (vip: string) => (
        <Tag
          size="small"
          color={vip === 'enterprise' ? 'purple' : vip === 'pro' ? 'blue' : 'grey'}
        >
          {vip?.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: '余额',
      dataIndex: 'balance',
      width: '12%',
      render: (b: number) => `¥${Number(b || 0).toFixed(2)}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: '10%',
      render: (s: string) => (
        <Tag size="small" color={s === 'active' ? 'green' : 'red'}>
          {USER_STATUS_TEXT[s] || s}
        </Tag>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: '14%',
      render: (t: string) => <TimeCell value={t} />,
    },
    {
      title: '操作',
      width: 140,
      render: (_: any, r: UserRow) => (
        <div className="admin-actions">
          <ViewButton onClick={() => showDetail(`用户详情 - ${r.username || ''}`, userDetailFields(r))} />
          <Button size="small" onClick={() => openAdjust(r)}>
            调整
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无用户" />}
      />
      <Modal
        title={`调整用户 - ${adjustModal.user?.username || ''}`}
        visible={adjustModal.visible}
        onCancel={closeAdjust}
        footer={
          <div className="admin-adjust-footer">
            <Button onClick={closeAdjust}>取消</Button>
            <Button
              theme="solid"
              type="primary"
              loading={adjustSaving}
              onClick={() => void handleSaveAll()}
            >
              保存
            </Button>
          </div>
        }
      >
        <div className="admin-adjust">
          <div className="admin-adjust-field">
            <label>余额</label>
            <div className="admin-adjust-balance">
              <InputNumber
                value={adjustValues.delta}
                step={1}
                style={{ width: '100%' }}
                onChange={(value) =>
                  setAdjustValues((prev) => ({ ...prev, delta: Number(value || 0) }))
                }
              />
              <Button onClick={() => void handleSaveBalance()}>保存余额</Button>
            </div>
            <span className="admin-muted">正数充值，负数扣除</span>
          </div>
          <div className="admin-adjust-field">
            <label>等级</label>
            <Select
              value={adjustValues.vipLevel}
              style={{ width: '100%' }}
              onChange={(value) =>
                setAdjustValues((prev) => ({ ...prev, vipLevel: String(value) }))
              }
              optionList={[
                { value: 'free', label: '免费版' },
                { value: 'pro', label: '专业版' },
              ]}
            />
          </div>
          <div className="admin-adjust-field">
            <label>状态</label>
            <Select
              value={adjustValues.status}
              style={{ width: '100%' }}
              onChange={(value) =>
                setAdjustValues((prev) => ({ ...prev, status: String(value) }))
              }
              optionList={[
                { value: 'active', label: '正常' },
                { value: 'suspended', label: '暂停' },
              ]}
            />
          </div>
        </div>
      </Modal>
      {detailNode}
    </div>
  );
};

/* ============ API Key 管理 ============ */

const ApiKeysView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
  refresh,
}: {
  data: { items: ApiKeyRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  refresh: () => void;
}) => {
  const { showDetail, detailNode } = useRowDetail();

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiKey(id);
      Toast.success('API Key 已吊销');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '操作失败');
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', width: '16%', render: (t: string) => t || '-' },
    {
      title: 'Key 前缀',
      dataIndex: 'keyPrefix',
      width: '18%',
      // 等宽中性色，不用品牌蓝
      render: (t: string) => <span className="cell-mono">{t ? `${t}...` : '-'}</span>,
    },
    {
      title: '所属用户',
      dataIndex: 'username',
      width: '14%',
      render: (t: string) => t || '-',
    },
    {
      title: '状态',
      dataIndex: 'revoked',
      width: '10%',
      render: (r: boolean) =>
        r ? (
          <Tag size="small" color="red">已吊销</Tag>
        ) : (
          <Tag size="small" color="green">正常</Tag>
        ),
    },
    {
      title: '最后使用',
      dataIndex: 'lastUsedAt',
      width: '18%',
      render: (t: string) => <TimeCell value={t} fallback="从未使用" />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: '18%',
      render: (t: string) => <TimeCell value={t} />,
    },
    {
      title: '操作',
      width: 160,
      render: (_: any, r: ApiKeyRow) => (
        <div className="admin-actions">
          <ViewButton onClick={() => showDetail(`API Key 详情 - ${r.name || ''}`, apiKeyDetailFields(r))} />
          {r.revoked ? (
            // 已吊销的行也要给出内容，避免操作列空白
            <span className="admin-muted">已吊销</span>
          ) : (
            <Popconfirm title="确认吊销此 API Key？" onConfirm={() => handleRevoke(r.id)}>
              <Button size="small" type="danger">
                吊销
              </Button>
            </Popconfirm>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无 API Key" />}
      />
      {detailNode}
    </div>
  );
};

/* ============ 工作流 ============ */

const WorkflowsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: WorkflowRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const { showDetail, detailNode } = useRowDetail();

  const columns = [
    { title: '名称', dataIndex: 'name', width: '20%', render: (t: string) => t || '-' },
    {
      title: '描述',
      dataIndex: 'description',
      width: '26%',
      ellipsis: true,
      render: (t: string) => t || '暂无描述',
    },
    { title: '所属用户', dataIndex: 'username', width: '14%', render: (t: string) => t || '-' },
    {
      title: '版本',
      dataIndex: 'version',
      width: '8%',
      render: (v: number) => `v${v ?? 1}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: '10%',
      render: (s: string) => <Tag size="small">{s || '-'}</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: '18%',
      render: (t: string) => <TimeCell value={t} />,
    },
    {
      title: '操作',
      width: 140,
      render: (_: any, r: WorkflowRow) => (
        <div className="admin-actions">
          <ViewButton onClick={() => showDetail(`工作流详情 - ${r.name || ''}`, workflowDetailFields(r))} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无工作流" />}
      />
      {detailNode}
    </div>
  );
};

/* ============ 运行记录 ============ */

const RunsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: RunRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const { showDetail, detailNode } = useRowDetail();

  const columns = [
    {
      title: '状态',
      dataIndex: 'status',
      width: '10%',
      render: (s: string) => {
        const color =
          s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'blue' : 'grey';
        return <Tag size="small" color={color}>{RUN_STATUS_TEXT[s] || s}</Tag>;
      },
    },
    { title: '用户', dataIndex: 'username', width: '12%', render: (v: string) => v || '-' },
    { title: '来源', dataIndex: 'source', width: '11%', render: (v: string) => v || '-' },
    {
      title: 'Token',
      dataIndex: 'totalTokens',
      width: '10%',
      render: (t: number) => (t || 0).toLocaleString(),
    },
    { title: '步数', dataIndex: 'totalSteps', width: '7%', render: (t: number) => t ?? 0 },
    {
      title: '费用',
      dataIndex: 'actualCost',
      width: '9%',
      render: (c: number) => `¥${Number(c || 0).toFixed(4)}`,
    },
    {
      title: '耗时',
      dataIndex: 'elapsedTime',
      width: '9%',
      render: (t: number) => `${Number(t || 0).toFixed(2)}s`,
    },
    {
      title: '错误',
      dataIndex: 'errorMessage',
      width: '16%',
      ellipsis: true,
      render: (t: string) => t || '-',
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: '16%',
      render: (t: string) => <TimeCell value={t} />,
    },
    {
      title: '操作',
      width: 120,
      render: (_: any, r: RunRow) => (
        <div className="admin-actions">
          <ViewButton onClick={() => showDetail('运行记录详情', runDetailFields(r))} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无运行记录" />}
      />
      {detailNode}
    </div>
  );
};

/* ============ 余额流水 ============ */

const LogsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: BalanceLogRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const { showDetail, detailNode } = useRowDetail();

  const columns = [
    {
      title: '类型',
      dataIndex: 'type',
      width: '10%',
      render: (t: string) => <Tag size="small">{BALANCE_TYPE_TEXT[t] || t}</Tag>,
    },
    { title: '用户', dataIndex: 'username', width: '14%', render: (t: string) => t || '-' },
    {
      title: '金额',
      dataIndex: 'amount',
      width: '12%',
      render: (a: number) => (
        <span style={{ color: Number(a) >= 0 ? 'var(--ff-success)' : 'var(--ff-danger)', fontWeight: 600 }}>
          {Number(a) >= 0 ? '+' : ''}
          {Number(a || 0).toFixed(4)}
        </span>
      ),
    },
    {
      title: '变动后余额',
      dataIndex: 'balanceAfter',
      width: '13%',
      render: (b: number) => `¥${Number(b || 0).toFixed(4)}`,
    },
    { title: '备注', dataIndex: 'remark', width: '22%', ellipsis: true, render: (t: string) => t || '-' },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: '17%',
      render: (t: string) => <TimeCell value={t} />,
    },
    {
      title: '操作',
      width: 120,
      render: (_: any, r: BalanceLogRow) => (
        <div className="admin-actions">
          <ViewButton onClick={() => showDetail('流水详情', balanceLogDetailFields(r))} />
        </div>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无流水记录" />}
      />
      {detailNode}
    </div>
  );
};

/* ============ 公共样式组件 ============ */

const TabIcon = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    {icon}
    {text}
  </span>
);

const Center = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 160px;
`;

const StatsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 880px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (max-width: 520px) { grid-template-columns: 1fr; }
`;

const StatCard = styled.div`
  background: var(--ff-surface);
  min-height: 104px;
  border-radius: var(--ff-radius);
  padding: 20px;
  border: 1px solid var(--ff-border);
  box-shadow: var(--ff-shadow-sm);
`;

const StatLabel = styled.div`
  font-size: 13px;
  color: var(--ff-muted);
  margin-bottom: 8px;
`;

const StatValue = styled.div`
  font-size: 28px;
  font-weight: 700;
  color: var(--ff-text);
`;

const ChartWrap = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 12px;
  height: 200px;
  padding: 20px 0;
  overflow-x: auto;
`;

const Bar = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 50px;
  height: 100%;
  justify-content: flex-end;
`;

const BarFill = styled.div`
  width: 28px;
  min-height: 4px;
  background: var(--ff-primary);
  border-radius: 4px 4px 0 0;
  transition: height 0.3s;
`;

const BarLabel = styled.div`
  font-size: 12px;
  color: var(--ff-subtle);
  margin-top: 6px;
`;

const BarCount = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--ff-text);
`;
